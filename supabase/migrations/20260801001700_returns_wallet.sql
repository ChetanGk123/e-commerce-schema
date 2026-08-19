-- ============================================================
-- 0017  Returns, refunds, store credit and gift cards
--
-- The phase where money goes back out, so every function here is
-- written to refuse rather than to reconcile. A refund that exceeds
-- what was captured, a return of more than was bought, a gift card
-- spent twice: none of them can be undone by an apology.
--
-- One schema gap is closed first, found by trying to use what B6 built:
-- payments.provider_payment_ref. Razorpay's refund API takes the PAYMENT
-- id, while provider_ref holds the gateway ORDER id -- which is what the
-- webhook resolves against. One column cannot be both, and without the
-- second one no refund can be issued at all.
--
-- api-plan B8 also asks for "provider ref unique" on refunds. The
-- baseline already has it (uniq_refund_provider_ref), so there is
-- nothing to add: a redelivered refund callback already cannot record
-- the same refund twice.
-- ============================================================

begin;

alter table payments add column if not exists provider_payment_ref text;

comment on column payments.provider_payment_ref is
  'The gateway PAYMENT id, as opposed to provider_ref which holds the gateway '
  'ORDER id. Refunds are issued against this one; webhooks resolve against the '
  'other. Kept apart because a refund issued against the wrong identifier '
  'fails at the gateway, and a webhook resolved against the wrong one silently '
  'captures the wrong order.';

-- ------------------------------------------------------------
-- capture_payment gains the payment id
--
-- Dropped and recreated rather than replaced: adding a parameter to
-- create-or-replace makes an overload, and two capture_payment
-- functions differing by one argument is exactly the ambiguity that
-- gets the wrong one called at 3am.
-- ------------------------------------------------------------

drop function if exists capture_payment(uuid, text, text, numeric);

create or replace function capture_payment(
  p_order_id           uuid,
  p_provider           text,
  p_provider_ref       text,
  p_amount             numeric default null,
  p_provider_payment_ref text default null
)
returns boolean
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

  if o.status <> 'pending' then
    return false;
  end if;

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

  -- The hold lapsed before the money landed. Taking the stock now is
  -- the difference between an oversell that is loud and one that is
  -- invisible until somebody counts the shelf.
  if n_res = 0 then
    insert into inventory_movements (variant_id, quantity, reason, order_id, note)
    select oi.variant_id, -oi.quantity, 'sale', p_order_id,
           'reservation expired before capture'
    from order_items oi
    where oi.order_id = p_order_id and oi.variant_id is not null;
  end if;

  update payments
  set status = 'captured',
      provider_ref = coalesce(provider_ref, p_provider_ref),
      provider_payment_ref = coalesce(p_provider_payment_ref, provider_payment_ref),
      updated_at = now()
  where order_id = p_order_id and provider = p_provider and status <> 'captured'
  returning id into pay;

  if pay is null then
    insert into payments (order_id, provider, provider_ref, provider_payment_ref,
                          amount, status)
    values (p_order_id, p_provider, p_provider_ref, p_provider_payment_ref,
            o.grand_total, 'captured')
    on conflict do nothing;
  end if;

  update orders set status = 'paid', updated_at = now() where id = p_order_id;

  insert into order_events (order_id, event, from_status, to_status, note, actor_type)
  values (p_order_id, 'payment_captured', o.status, 'paid', p_provider, 'system');

  return true;
end $$;

-- ------------------------------------------------------------
-- A customer opens a return
--
-- SECURITY INVOKER, deliberately. RLS already says exactly the right
-- thing -- own_returns_i pins status to 'requested' and requires the
-- order to be the caller's, own_return_items_i pins condition to null
-- so a customer cannot grade their own goods -- and a definer function
-- would throw all of that away and have to reimplement it worse.
--
-- What it adds is the one thing RLS cannot: the request and its lines
-- in a single transaction. Two PostgREST calls means a return that
-- exists with no lines, which reads to staff as an empty claim.
-- ------------------------------------------------------------

create or replace function request_return(
  p_order_id uuid,
  p_items    jsonb,     -- [{"order_item_id": uuid, "quantity": int}]
  p_reason   text
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare rid uuid;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Choose at least one item to return.'
      using errcode = 'ECOM1', hint = 'no_items';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Tell us why you are returning it.'
      using errcode = 'ECOM1', hint = 'reason_required';
  end if;

  insert into return_requests (order_id, customer_id, reason)
  values (p_order_id, auth.uid(), btrim(p_reason))
  returning id into rid;

  -- enforce_return_quantity() counts every other return of the same
  -- line, so returning two lots of one unit against a one-unit line is
  -- refused on the second.
  insert into return_items (return_id, order_item_id, order_id, quantity)
  select rid, (e ->> 'order_item_id')::uuid, p_order_id, (e ->> 'quantity')::int
  from jsonb_array_elements(p_items) e;

  return rid;
end $$;

-- ------------------------------------------------------------
-- Staff decide
-- ------------------------------------------------------------

create or replace function admin_review_return(
  p_return_id uuid,
  p_decision  text,     -- 'approved' | 'rejected' | 'pickup_scheduled'
  p_note      text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := require_staff();
  r   return_requests%rowtype;
begin
  if p_decision not in ('approved', 'rejected', 'pickup_scheduled') then
    raise exception 'Unknown decision %.', p_decision
      using errcode = 'ECOM1', hint = 'unknown_decision';
  end if;

  select * into r from return_requests where id = p_return_id for update;
  if not found then
    raise exception 'return % not found', p_return_id using errcode = 'P0002';
  end if;

  -- Once the goods are back, or the money has gone, the decision is
  -- made. Reopening it here would let a rejection undo a refund.
  if r.status in ('received', 'refunded', 'closed') then
    raise exception 'This return is already %.', r.status
      using errcode = 'ECOM2', hint = 'return_settled';
  end if;
  if r.status = 'rejected' and p_decision <> 'approved' then
    raise exception 'This return was already rejected.'
      using errcode = 'ECOM2', hint = 'return_settled';
  end if;

  update return_requests
  set status = p_decision,
      note = coalesce(p_note, note),
      updated_at = now(),
      resolved_at = case when p_decision = 'rejected' then now() else resolved_at end
  where id = p_return_id;

  insert into order_events (order_id, event, note, actor_type, actor_id)
  values (r.order_id, 'return_' || p_decision, p_note, 'staff', uid);
end $$;

-- ------------------------------------------------------------
-- Money back out
--
-- Records the intent, and nothing else. The gateway call happens
-- afterwards in the API, for the same reason checkout does not call
-- Razorpay inside its transaction: an HTTP call held open inside a
-- database transaction turns a gateway timeout into a rolled-back
-- refund the customer was already told about.
--
-- So a refunds row is written 'initiated' first. If the gateway call
-- then fails, the row survives as a visible, retryable record instead
-- of the refund vanishing.
-- ------------------------------------------------------------

create or replace function admin_refund(
  p_order_id  uuid,
  p_amount    numeric,
  p_return_id uuid default null,
  p_note      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid          uuid := require_staff();
  o            orders%rowtype;
  pay          payments%rowtype;
  already      numeric(12,2);
  refund_id    uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'A refund has to be for more than nothing.'
      using errcode = 'ECOM1', hint = 'invalid_amount';
  end if;

  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;
  if o.status = 'pending' then
    raise exception 'Nothing has been captured for this order yet.'
      using errcode = 'ECOM2', hint = 'nothing_to_refund';
  end if;

  -- The captured payment is the only thing a refund can go back
  -- against: refunding to a different instrument is how money leaves
  -- without a trail.
  select * into pay from payments
  where order_id = p_order_id and status = 'captured'
  order by created_at limit 1;
  if not found then
    raise exception 'No captured payment to refund against.'
      using errcode = 'ECOM2', hint = 'no_captured_payment';
  end if;

  -- 'failed' refunds do not count: that money never left.
  select coalesce(sum(amount), 0) into already
  from refunds
  where order_id = p_order_id and status in ('initiated', 'processed');

  if already + p_amount > o.grand_total then
    raise exception
      'Refunding % would take the total refunded to % on an order of %.',
      p_amount, already + p_amount, o.grand_total
      using errcode = 'ECOM2', hint = 'over_refund';
  end if;

  insert into refunds (order_id, payment_id, return_id, amount, status)
  values (p_order_id, pay.id, p_return_id, p_amount, 'initiated')
  returning id into refund_id;

  insert into order_events (order_id, event, note, actor_type, actor_id)
  values (p_order_id, 'refund_initiated',
          coalesce(p_note, p_amount::text), 'staff', uid);

  return jsonb_build_object(
    'refund_id',            refund_id,
    'payment_id',           pay.id,
    'provider',             pay.provider,
    'provider_payment_ref', pay.provider_payment_ref,
    'amount',               p_amount,
    'refunded_to_date',     already + p_amount,
    'order_total',          o.grand_total,
    'fully_refunded',       (already + p_amount) >= o.grand_total);
end $$;

-- ------------------------------------------------------------
-- Settling a refund
--
-- Split from admin_refund so the gateway's answer can be recorded
-- whether it arrives inline or by webhook later.
-- ------------------------------------------------------------

create or replace function settle_refund(
  p_refund_id    uuid,
  p_status       text,        -- 'processed' | 'failed'
  p_provider_ref text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r  refunds%rowtype;
  o  orders%rowtype;
  paid_back numeric(12,2);
begin
  if p_status not in ('processed', 'failed') then
    raise exception 'A refund settles as processed or failed, not %.', p_status
      using errcode = 'ECOM1', hint = 'unknown_status';
  end if;

  select * into r from refunds where id = p_refund_id for update;
  if not found then
    raise exception 'refund % not found', p_refund_id using errcode = 'P0002';
  end if;
  if r.status <> 'initiated' then
    return;                    -- a redelivered callback; already settled
  end if;

  update refunds
  set status = p_status, provider_ref = coalesce(p_provider_ref, provider_ref),
      updated_at = now()
  where id = p_refund_id;

  if p_status <> 'processed' then
    return;
  end if;

  select * into o from orders where id = r.order_id for update;
  select coalesce(sum(amount), 0) into paid_back
  from refunds where order_id = r.order_id and status = 'processed';

  -- Only a full refund moves the order. A partial one leaves it where
  -- it is, because 'refunded' on a part-refunded order tells the
  -- warehouse to stop shipping goods the customer is still owed.
  if paid_back >= o.grand_total and o.status <> 'refunded' then
    update orders set status = 'refunded', updated_at = now() where id = o.id;
    insert into order_events (order_id, event, from_status, to_status, actor_type)
    values (o.id, 'refunded', o.status, 'refunded', 'system');
  end if;

  if r.return_id is not null then
    update return_requests
    set status = 'refunded', resolved_at = now(), updated_at = now()
    where id = r.return_id and status <> 'refunded';
  end if;
end $$;

-- ------------------------------------------------------------
-- Store credit
--
-- The ledger is append-only, and the balance is a view over it. There
-- is no balance column to correct, which is the point: a wrong entry
-- is fixed by a compensating entry, and both stay visible.
-- ------------------------------------------------------------

create or replace function admin_grant_credit(
  p_customer_id uuid,
  p_delta       numeric,
  p_reason      text,
  p_note        text,
  p_expires_at  timestamptz default null
)
returns numeric              -- the balance afterwards
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := require_staff();
  bal numeric(12,2);
begin
  -- return_credit and gift_card_redemption are written by the flows
  -- that earn them. Granting one by hand would invent a return or a
  -- card that does not exist.
  if p_reason not in ('goodwill', 'promotion', 'adjustment', 'expiry') then
    raise exception 'Credit can be granted as goodwill, promotion, adjustment or expiry, not %.',
      p_reason using errcode = 'ECOM1', hint = 'reason_not_allowed';
  end if;
  if p_delta = 0 then
    raise exception 'A credit entry of zero changes nothing.'
      using errcode = 'ECOM1', hint = 'zero_delta';
  end if;
  if p_note is null or btrim(p_note) = '' then
    raise exception 'Say why. Every credit entry needs a note.'
      using errcode = 'ECOM1', hint = 'note_required';
  end if;

  select coalesce(sum(delta), 0) into bal
  from credit_ledger
  where customer_id = p_customer_id
    and (expires_at is null or expires_at > now());

  if bal + p_delta < 0 then
    raise exception 'That would take the balance below zero (currently %).', bal
      using errcode = 'ECOM2', hint = 'insufficient_credit';
  end if;

  insert into credit_ledger (customer_id, delta, reason, note, expires_at, created_by)
  values (p_customer_id, p_delta, p_reason, btrim(p_note), p_expires_at, uid);

  return bal + p_delta;
end $$;

-- ------------------------------------------------------------
-- Gift card codes
--
-- NOTE THE search_path ON THE NEXT THREE FUNCTIONS. pgcrypto lives in
-- the `extensions` schema on Supabase, not in public -- the baseline's
-- `create extension if not exists pgcrypto` was a no-op because the
-- image had already installed it there. With `search_path = public,
-- pg_temp` alone, digest() and gen_random_bytes() are simply invisible
-- and every gift card operation fails with "function does not exist".
--
-- A schema named in search_path that does not exist is ignored, so
-- naming `extensions` is safe on a plain Postgres where pgcrypto went
-- into public. pg_temp stays LAST either way.
--
-- The alphabet drops 0/O, 1/I/L and everything else a person reads
-- back wrongly over the phone, because these get read back over the
-- phone. 16 characters of a 25-symbol alphabet is about 74 bits.
--
-- Rejection sampling rather than a plain modulo: 256 does not divide
-- by 25, so `byte % 25` favours the first six symbols. It would not
-- matter at this length, and it costs two lines not to have to think
-- about whether it matters.
-- ------------------------------------------------------------

create or replace function generate_gift_card_code()
returns text
language plpgsql
volatile
set search_path = public, extensions, pg_temp
as $$
declare
  alphabet text := 'ACDEFGHJKMNPQRTUVWXY34679';   -- 25 symbols
  n        int  := length(alphabet);
  cap      int  := 256 - (256 % n);               -- 250
  code     text := '';
  b        int;
begin
  while length(code) < 16 loop
    b := get_byte(gen_random_bytes(1), 0);
    if b < cap then
      code := code || substr(alphabet, 1 + (b % n), 1);
    end if;
  end loop;
  return code;
end $$;

-- ------------------------------------------------------------
-- Issue a gift card
--
-- Returns the plaintext code EXACTLY ONCE. Only digest(code,'sha256')
-- is stored, so this is the only moment the code exists anywhere the
-- store can see it -- lose it and the card has to be reissued. That is
-- the same bargain as a password, and for the same reason: a leaked
-- backup of gift_cards must not be a wallet full of money.
-- ------------------------------------------------------------

create or replace function admin_issue_gift_card(
  p_amount          numeric,
  p_recipient_email text default null,
  p_message         text default null,
  p_expires_at      timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  uid  uuid := require_staff();
  code text := generate_gift_card_code();
  gid  uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'A gift card has to be worth something.'
      using errcode = 'ECOM1', hint = 'invalid_amount';
  end if;

  insert into gift_cards (code_hash, last4, initial_balance, balance,
                          recipient_email, message, expires_at)
  values (digest(code, 'sha256'), right(code, 4), p_amount, p_amount,
          p_recipient_email, p_message, p_expires_at)
  returning id into gid;

  return jsonb_build_object(
    'gift_card_id', gid,
    'code',         code,          -- say it once
    'last4',        right(code, 4),
    'balance',      p_amount,
    'expires_at',   p_expires_at);
end $$;

-- ------------------------------------------------------------
-- Redeem a gift card
--
-- Converts the whole remaining balance into store credit for the
-- caller. Whole, not partial: a card with a balance and a customer
-- with a balance are two places money can be, and reconciling them is
-- work nobody asked for. The credit ledger already handles partial
-- spending.
--
-- SECURITY DEFINER because a customer must not be able to read
-- gift_cards -- own_gift_cards only shows cards they bought, and a
-- lookup by code has to happen where the caller cannot see the table.
--
-- Every failure says the same thing. "That card is expired" tells
-- someone guessing codes that they guessed one.
-- ------------------------------------------------------------

create or replace function redeem_gift_card(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  uid  uuid := auth.uid();
  card gift_cards%rowtype;
  bal  numeric(12,2);
begin
  if uid is null then
    raise exception 'Sign in to redeem a gift card.'
      using errcode = 'ECOM1', hint = 'sign_in_required';
  end if;
  if not exists (select 1 from customers c where c.id = uid) then
    raise exception 'Sign in to redeem a gift card.'
      using errcode = 'ECOM1', hint = 'sign_in_required';
  end if;

  select * into card from gift_cards
  where code_hash = digest(btrim(upper(coalesce(p_code, ''))), 'sha256')
  for update;

  if not found
     or card.status <> 'active'
     or card.balance <= 0
     or (card.expires_at is not null and card.expires_at <= now()) then
    raise exception 'That gift card cannot be redeemed.'
      using errcode = 'ECOM1', hint = 'invalid_gift_card';
  end if;

  -- Ledger first, and the trigger checks balance_after against what it
  -- computes. CHECK (balance >= 0) is what makes an overspend
  -- impossible rather than merely unlikely.
  insert into gift_card_transactions (gift_card_id, delta, balance_after)
  values (card.id, -card.balance, 0);

  update gift_cards set status = 'redeemed', updated_at = now() where id = card.id;

  insert into credit_ledger (customer_id, delta, reason, gift_card_id, note)
  values (uid, card.balance, 'gift_card_redemption', card.id,
          'gift card ending ' || card.last4);

  select coalesce(sum(delta), 0) into bal
  from credit_ledger
  where customer_id = uid and (expires_at is null or expires_at > now());

  return jsonb_build_object(
    'redeemed',      card.balance,
    'last4',         card.last4,
    'credit_balance', bal);
end $$;

revoke execute on function capture_payment(uuid, text, text, numeric, text) from public;
revoke execute on function settle_refund(uuid, text, text)                  from public;
revoke execute on function request_return(uuid, jsonb, text)                from public;
revoke execute on function admin_review_return(uuid, text, text)            from public;
revoke execute on function admin_refund(uuid, numeric, uuid, text)          from public;
revoke execute on function admin_grant_credit(uuid, numeric, text, text, timestamptz) from public;
revoke execute on function generate_gift_card_code()                        from public;
revoke execute on function admin_issue_gift_card(numeric, text, text, timestamptz) from public;
revoke execute on function redeem_gift_card(text)                           from public;

-- Capture and refund settlement act with no user present.
grant execute on function capture_payment(uuid, text, text, numeric, text) to service_role;
grant execute on function settle_refund(uuid, text, text)                  to service_role;

-- The staff-guarded ones are granted to `authenticated` because that
-- is the role a staff member's JWT carries; require_staff() inside
-- each is what actually contains them.
grant execute on function request_return(uuid, jsonb, text)                 to authenticated;
grant execute on function admin_review_return(uuid, text, text)             to authenticated;
grant execute on function admin_refund(uuid, numeric, uuid, text)           to authenticated;
grant execute on function admin_grant_credit(uuid, numeric, text, text, timestamptz) to authenticated;
grant execute on function admin_issue_gift_card(numeric, text, text, timestamptz)    to authenticated;
grant execute on function redeem_gift_card(text)                            to authenticated;

commit;
