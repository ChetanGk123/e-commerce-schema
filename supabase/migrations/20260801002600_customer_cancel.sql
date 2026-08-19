-- ============================================================
-- 0026  A customer can cancel their own unpaid order
--
-- admin_cancel_order() has existed since B3 and calls require_staff(),
-- so the only way to cancel was to contact the shop. For an order placed
-- two minutes ago that has not been paid for, that is a support ticket
-- for something the customer should simply be able to do -- and while it
-- sits unanswered the reservation holds stock nobody is going to buy.
--
-- Deliberately narrower than the staff version, in one way that matters:
-- PENDING ONLY. admin_cancel_order will cancel a paid order and return
-- the sold units to stock, which is the right power for staff and the
-- wrong one to hand a customer -- money has changed hands by then, and
-- unwinding that is a refund decision with a person attached. A paid
-- order still goes through support, and returns exist for after
-- delivery.
-- ============================================================

begin;

create or replace function cancel_own_order(
  p_order_id uuid,
  p_reason   text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  o   orders%rowtype;
  res record;
begin
  if uid is null then
    raise exception 'sign in to cancel an order' using errcode = '42501';
  end if;

  -- Ownership is in the WHERE clause, not left to RLS: this function is
  -- security definer, so RLS does not apply to it at all, and a lookup
  -- by id alone would let anyone cancel any order by guessing one.
  select * into o from orders
  where id = p_order_id and customer_id = uid
  for update;

  if not found then
    -- Same answer for "no such order" and "not yours". Telling them
    -- apart turns this into a way to test whether an order id exists.
    raise exception 'order not found' using errcode = 'P0002';
  end if;

  if o.status <> 'pending' then
    raise exception
      'That order can no longer be cancelled here. Contact support.'
      using errcode = 'ECOM1', hint = 'order_not_cancellable';
  end if;

  -- Pending means nothing was ever captured, so there are no 'sale' rows
  -- to reverse -- only the holds checkout took. That is the whole reason
  -- this function is short where admin_cancel_order is not.
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
  end loop;

  update orders set status = 'cancelled', updated_at = now() where id = p_order_id;

  insert into order_events (order_id, event, from_status, to_status, note, actor_type, actor_id)
  values (p_order_id, 'status_changed', o.status, 'cancelled', p_reason, 'customer', uid);
end $$;

revoke execute on function cancel_own_order(uuid, text) from public;
grant  execute on function cancel_own_order(uuid, text) to authenticated;

commit;
