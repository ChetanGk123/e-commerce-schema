-- ============================================================
-- 0019  Customers, support and engagement
--
-- Opens with a security fix, because B10 is where the hole became
-- reachable.
--
-- anonymize_customer() is SECURITY DEFINER, takes a customer id, and
-- has no authorisation check of any kind. Migration 0012 granted it to
-- `authenticated` so the API could call it. Between them, any signed-in
-- shopper could scrub any other customer: name replaced, email
-- replaced, phone nulled, addresses and consent and wishlist and stock
-- alerts removed, every order address redacted. Irreversible, silent,
-- and reproducible in three lines of SQL.
--
-- The rest of this migration is the small amount that RLS cannot do on
-- its own: making a ticket and its first message one transaction, and
-- letting staff act on tickets in a way that keeps the SLA clock
-- honest.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Who is asking, and are they senior enough
-- ------------------------------------------------------------

create or replace function staff_has_role(variadic p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from staff_users s
    where s.id = auth.uid() and s.is_active and s.role = any(p_roles)
  )
$$;

comment on function staff_has_role(text[]) is
  'Role gate for the few operations where role is a real boundary rather '
  'than a UX hint. RLS still ignores staff_users.role everywhere else -- see '
  'the accepted risk in README.';

-- ------------------------------------------------------------
-- Erasure, with an owner
--
-- DPDP gives a person an erasure right over THEIR OWN data, so
-- self-service stays: a customer may scrub themselves. Anyone else
-- doing it is a staff decision, and not a junior one -- it destroys
-- personal data and cannot be undone, so it is owner or admin.
--
-- The check has to live in the function, not in the API. Every staff
-- member can reach PostgREST directly with their own JWT, so a guard
-- in a route handler is advice.
-- ------------------------------------------------------------

create or replace function anonymize_customer(p_customer_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Sign in first.'
      using errcode = 'ECOM1', hint = 'sign_in_required';
  end if;

  if uid <> p_customer_id and not staff_has_role('owner', 'admin') then
    -- Deliberately says nothing about whether that customer exists.
    raise exception 'You cannot erase that account.'
      using errcode = '42501', hint = 'forbidden';
  end if;

  update customers
  set email         = format('deleted+%s@invalid', id),
      phone         = null,
      full_name     = 'Deleted customer',
      anonymized_at = now()
  where id = p_customer_id
    and anonymized_at is null;

  delete from addresses where customer_id = p_customer_id;
  delete from communication_preferences where customer_id = p_customer_id;
  delete from wishlist_items where customer_id = p_customer_id;
  delete from stock_alerts where customer_id = p_customer_id;

  -- Orders keep a contact snapshot for GST purposes, but the name
  -- and address blobs are personal data, so they go.
  update orders
  set email            = format('deleted+%s@invalid', p_customer_id),
      phone            = null,
      shipping_address = '{"redacted": true}'::jsonb,
      billing_address  = null
  where customer_id = p_customer_id;

  update reviews
  set title = null, body = null
  where customer_id = p_customer_id;
end $$;

comment on function anonymize_customer(uuid) is
  'DPDP erasure. Scrubs PII while retaining orders, invoices and the credit '
  'ledger. A customer may erase themselves; anyone else needs the owner or '
  'admin role. Call this BEFORE removing the auth.users row -- customers.id '
  'has ON DELETE RESTRICT precisely so an unscrubbed removal fails loudly.';

-- ------------------------------------------------------------
-- Opening a ticket
--
-- SECURITY INVOKER, so own_tickets_i keeps doing the work it already
-- does: status pinned to 'open', priority to 'normal', assigned_to
-- null, and an attached order has to be the caller's own. A definer
-- function would discard all of that.
--
-- What it adds is atomicity. A ticket with no message is an agent
-- opening a blank conversation and having to ask what it is about.
-- ------------------------------------------------------------

create or replace function open_ticket(
  p_subject  text,
  p_body     text,
  p_category text default 'general',
  p_order_id uuid default null
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare tid uuid;
begin
  if p_subject is null or btrim(p_subject) = '' then
    raise exception 'A ticket needs a subject.'
      using errcode = 'ECOM1', hint = 'subject_required';
  end if;
  if p_body is null or btrim(p_body) = '' then
    raise exception 'Tell us what happened.'
      using errcode = 'ECOM1', hint = 'body_required';
  end if;

  insert into support_tickets (customer_id, order_id, subject, category)
  values (auth.uid(), p_order_id, btrim(p_subject), p_category)
  returning id into tid;

  -- own_ticket_msgs_i pins is_internal to false and sender to the
  -- caller, so a customer cannot open a ticket with a staff note on it.
  insert into ticket_messages (ticket_id, sender_type, sender_id, body)
  values (tid, 'customer', auth.uid(), btrim(p_body));

  return tid;
end $$;

-- ------------------------------------------------------------
-- Replying
--
-- first_response_at is the SLA clock, and it is stamped here rather
-- than left to the API because an agent who replies through PostgREST
-- directly would otherwise never start it. Internal notes do not stop
-- the clock: the customer has not been answered.
-- ------------------------------------------------------------

create or replace function admin_reply_ticket(
  p_ticket_id   uuid,
  p_body        text,
  p_is_internal boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := require_staff();
  t   support_tickets%rowtype;
  mid uuid;
begin
  if p_body is null or btrim(p_body) = '' then
    raise exception 'An empty reply is not a reply.'
      using errcode = 'ECOM1', hint = 'body_required';
  end if;

  select * into t from support_tickets where id = p_ticket_id for update;
  if not found then
    raise exception 'ticket % not found', p_ticket_id using errcode = 'P0002';
  end if;
  if t.status = 'closed' then
    raise exception 'Ticket % is closed. Reopen it first.', t.ticket_number
      using errcode = 'ECOM2', hint = 'ticket_closed';
  end if;

  insert into ticket_messages (ticket_id, sender_type, sender_id, body, is_internal)
  values (p_ticket_id, 'staff', uid, btrim(p_body), coalesce(p_is_internal, false))
  returning id into mid;

  update support_tickets
  set first_response_at = case
        when first_response_at is null and not coalesce(p_is_internal, false)
        then now() else first_response_at end,
      status = case
        when coalesce(p_is_internal, false) then status
        else 'pending_customer' end,
      updated_at = now()
  where id = p_ticket_id;

  return mid;
end $$;

-- ------------------------------------------------------------
-- Triaging
--
-- Priority, assignment and status are staff-only by RLS already
-- (own_tickets_i pins them at insert and there is no customer UPDATE
-- policy at all). This exists to keep resolved_at truthful, which a
-- raw UPDATE would not.
-- ------------------------------------------------------------

create or replace function admin_update_ticket(
  p_ticket_id   uuid,
  p_status      text default null,
  p_priority    text default null,
  p_assigned_to uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := require_staff();
  t   support_tickets%rowtype;
begin
  if p_status is not null
     and p_status not in ('open', 'pending_customer', 'pending_internal', 'resolved', 'closed') then
    raise exception 'Unknown ticket status %.', p_status
      using errcode = 'ECOM1', hint = 'unknown_status';
  end if;
  if p_priority is not null and p_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Unknown priority %.', p_priority
      using errcode = 'ECOM1', hint = 'unknown_priority';
  end if;

  select * into t from support_tickets where id = p_ticket_id for update;
  if not found then
    raise exception 'ticket % not found', p_ticket_id using errcode = 'P0002';
  end if;

  update support_tickets
  set status      = coalesce(p_status, status),
      priority    = coalesce(p_priority, priority),
      assigned_to = coalesce(p_assigned_to, assigned_to),
      resolved_at = case
        when coalesce(p_status, status) in ('resolved', 'closed')
        then coalesce(resolved_at, now())
        -- Reopening clears it, or "time to resolution" counts the first
        -- attempt and ignores the three that followed.
        else null end,
      updated_at = now()
  where id = p_ticket_id;
end $$;

revoke execute on function staff_has_role(text[])                      from public;
revoke execute on function open_ticket(text, text, text, uuid)         from public;
revoke execute on function admin_reply_ticket(uuid, text, boolean)     from public;
revoke execute on function admin_update_ticket(uuid, text, text, uuid) from public;

grant execute on function staff_has_role(text[])                       to authenticated;
grant execute on function open_ticket(text, text, text, uuid)          to authenticated;
grant execute on function admin_reply_ticket(uuid, text, boolean)      to authenticated;
grant execute on function admin_update_ticket(uuid, text, text, uuid)  to authenticated;

commit;
