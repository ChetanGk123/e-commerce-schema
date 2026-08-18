-- ============================================================
-- 0015  Payments and webhooks
--
-- Gateways retry until they get a 2xx, and they are not careful about
-- it. Everything here exists so that a delivery arriving twice -- or
-- arriving while the first one is still being processed -- changes the
-- world exactly once.
--
-- Two rules the shapes below enforce rather than document:
--
--   RECORD BEFORE ACTING. record_webhook() writes the delivery down
--   first. If processing then crashes, the row is still there with its
--   error, and the retry has something to be idempotent against. Acting
--   first and recording after means a crash in between captures twice.
--
--   PROCESSED, NOT SEEN, IS THE GATE. A duplicate delivery whose first
--   attempt failed must still be processed. So the question is never
--   "have I seen this?" but "did it finish?" -- processed_at, not the
--   unique index.
--
-- Granted to service_role only. A webhook has no user, so these run on
-- the service key; giving them to `authenticated` would let any signed-in
-- shopper mark their own order paid.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Write the delivery down
--
-- Returns is_new (did this insert, or collide with an earlier delivery)
-- and already_processed (did an earlier attempt finish). The caller
-- processes on `not already_processed`, whatever is_new says.
--
-- xmax = 0 is how a row that was just INSERTed is told apart from one
-- the ON CONFLICT clause UPDATEd: a fresh insert has no updating
-- transaction id.
-- ------------------------------------------------------------

create or replace function record_webhook(
  p_provider   text,
  p_event_id   text,
  p_event_type text,
  p_payload    jsonb,
  p_verified   boolean default false
)
returns table (
  id                uuid,
  is_new            boolean,
  already_processed boolean,
  attempts          int
)
language sql
set search_path = public, pg_temp
as $$
  insert into webhook_events (provider, event_id, event_type, payload,
                              signature_verified, attempts)
  values (p_provider, p_event_id, p_event_type, p_payload, p_verified, 1)
  on conflict (provider, event_id) do update
    set attempts = webhook_events.attempts + 1
  returning webhook_events.id,
            (xmax = 0),
            webhook_events.processed_at is not null,
            webhook_events.attempts;
$$;

create or replace function mark_webhook_processed(
  p_id    uuid,
  p_error text default null
)
returns void
language sql
set search_path = public, pg_temp
as $$
  update webhook_events
  set processed_at = case when p_error is null then now() else processed_at end,
      error        = p_error
  where id = p_id;
$$;

-- ------------------------------------------------------------
-- Capture
--
-- The same two-row ledger move admin_capture_cod makes, for a gateway
-- instead of a person: give the hold back, then take the units as a
-- sale. One row would be cheaper and would also be a lie -- the
-- reservation really did take that stock down, and the ledger has to say
-- what happened.
--
-- Idempotent three times over, because a gateway will test all three:
--   - a non-pending order returns false and changes nothing
--   - uniq_payment_provider_ref refuses a second payment row for the
--     same gateway reference
--   - the reservation_id unique index makes a double release impossible
-- ------------------------------------------------------------

create or replace function capture_payment(
  p_order_id     uuid,
  p_provider     text,
  p_provider_ref text,
  p_amount       numeric default null
)
returns boolean          -- true if this call is what moved the order
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o     orders%rowtype;
  res   record;
  pay   uuid;
  n_res int;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;

  -- The replay lands here. Not an error: the gateway is doing exactly
  -- what it promised, and the answer is that there is nothing to do.
  if o.status <> 'pending' then
    return false;
  end if;

  -- A gateway that captures less than it was asked for is a dispute, not
  -- a checkout. Refusing is the only safe answer -- marking the order
  -- paid for the wrong amount is unrecoverable without a human.
  if p_amount is not null and p_amount <> o.grand_total then
    raise exception
      'gateway captured % against an order of %', p_amount, o.grand_total
      using errcode = 'ECOM2', hint = 'amount_mismatch';
  end if;

  n_res := 0;
  for res in
    select m.id, m.variant_id, m.quantity
    from inventory_movements m
    where m.order_id = p_order_id
      and m.reason = 'reservation'
      and not exists (
        select 1 from inventory_movements c where c.reservation_id = m.id)
  loop
    insert into inventory_movements (variant_id, quantity, reason, order_id, reservation_id)
    values (res.variant_id, -res.quantity, 'release', p_order_id, res.id);

    insert into inventory_movements (variant_id, quantity, reason, order_id)
    values (res.variant_id, res.quantity, 'sale', p_order_id);

    n_res := n_res + 1;
  end loop;

  -- The hold lapsed before the money landed.
  --
  -- Doing nothing here is the dangerous option, and it is the one the
  -- loop above does on its own: no reservation left to consume means no
  -- sale row, so the order goes to 'paid' with the stock never taken and
  -- the shortfall is invisible until someone counts the shelf.
  --
  -- So take it now. If the units are genuinely gone, stock >= 0 fires and
  -- this whole capture fails -- which is correct and is meant to be loud:
  -- the gateway has the customer's money and the store cannot ship. That
  -- is a person's decision (refund, or restock and re-run), not a retry's.
  if n_res = 0 then
    insert into inventory_movements (variant_id, quantity, reason, order_id, note)
    select oi.variant_id, -oi.quantity, 'sale', p_order_id,
           'reservation expired before capture'
    from order_items oi
    where oi.order_id = p_order_id and oi.variant_id is not null;
  end if;

  update payments
  set status = 'captured', provider_ref = coalesce(provider_ref, p_provider_ref),
      updated_at = now()
  where order_id = p_order_id and provider = p_provider and status <> 'captured'
  returning id into pay;

  -- COD captured through the gateway path, or a payment row that never
  -- got created: record it rather than losing the money's provenance.
  if pay is null then
    insert into payments (order_id, provider, provider_ref, amount, status)
    values (p_order_id, p_provider, p_provider_ref, o.grand_total, 'captured')
    on conflict do nothing;
  end if;

  update orders set status = 'paid', updated_at = now() where id = p_order_id;

  insert into order_events (order_id, event, from_status, to_status, note, actor_type)
  values (p_order_id, 'payment_captured', o.status, 'paid', p_provider, 'system');

  return true;
end $$;

-- ------------------------------------------------------------
-- Failure
--
-- Marks the attempt failed and leaves the stock hold alone, which looks
-- wrong next to schema_guide section 20's "on payment failure, release
-- only" and is not.
--
-- payment.failed is not terminal at Razorpay: a mistyped OTP fires it
-- and the customer retries in the same session. Releasing there would
-- hand their basket to someone else mid-checkout, and the retry would
-- have no hold at all. The reservation's own expires_at is the release
-- mechanism -- that is the entire reason it is mandatory -- and
-- release_expired_reservations() runs it. A terminal failure is a
-- cancellation, and admin_cancel_order() releases immediately.
-- ------------------------------------------------------------

create or replace function fail_payment(
  p_order_id     uuid,
  p_provider     text,
  p_provider_ref text default null,
  p_reason       text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare o orders%rowtype;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;
  if o.status <> 'pending' then
    return false;                       -- already paid, or already cancelled
  end if;

  update payments
  set status = 'failed',
      provider_ref = coalesce(provider_ref, p_provider_ref),
      updated_at = now()
  where order_id = p_order_id and provider = p_provider and status = 'created';

  insert into order_events (order_id, event, note, actor_type)
  values (p_order_id, 'payment_failed', p_reason, 'system');

  return true;
end $$;

-- ------------------------------------------------------------
-- Attach the gateway's order id
--
-- Separate from capture so creating the gateway order is retryable: the
-- route asks for the existing ref first and only calls Razorpay if there
-- is not one, so a client that retries does not open a second gateway
-- order against the same basket.
-- ------------------------------------------------------------

create or replace function attach_payment_ref(
  p_order_id     uuid,
  p_provider     text,
  p_provider_ref text
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update payments
  set provider_ref = p_provider_ref, updated_at = now()
  where order_id = p_order_id and provider = p_provider and provider_ref is null;
$$;

revoke execute on function record_webhook(text, text, text, jsonb, boolean)  from public;
revoke execute on function mark_webhook_processed(uuid, text)                from public;
revoke execute on function capture_payment(uuid, text, text, numeric)        from public;
revoke execute on function fail_payment(uuid, text, text, text)              from public;
revoke execute on function attach_payment_ref(uuid, text, text)              from public;

-- service_role only. These move money and stock with no user present, so
-- there is no version of this that `authenticated` should reach.
grant execute on function record_webhook(text, text, text, jsonb, boolean)   to service_role;
grant execute on function mark_webhook_processed(uuid, text)                 to service_role;
grant execute on function capture_payment(uuid, text, text, numeric)         to service_role;
grant execute on function fail_payment(uuid, text, text, text)               to service_role;
grant execute on function attach_payment_ref(uuid, text, text)               to service_role;

commit;
