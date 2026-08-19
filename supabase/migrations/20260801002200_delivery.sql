-- ============================================================
-- 0022  Closing the order lifecycle
--
-- admin_ship_order() has created shipments since B7 and nothing could
-- ever move one afterwards. shipments.status had six values past
-- 'label_created' that no code path could reach, shipments.delivered_at
-- was never written, and orders.status could not become 'delivered' at
-- all -- so every order this store has ever fulfilled stayed "shipped"
-- permanently, and the return window, the delivery timeline and any
-- report keyed on delivery had nothing to read.
--
-- This is an RPC rather than two UPDATEs from the API for the reason
-- every other admin_* function is: it touches three tables and the order
-- must not be left half-moved if one of them fails.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Advance a shipment, and the order with it when that is warranted
--
-- THE ORDER FOLLOWS THE LAST SHIPMENT, NOT THIS ONE. An order can be
-- fulfilled in parts -- shipment_items exists precisely so it can -- so
-- marking one parcel delivered while another is still in transit must
-- not tell the customer their order arrived. The order moves only when
-- no shipment on it is still outstanding.
--
-- 'rto' and 'lost' deliberately do NOT move the order. A returned or
-- lost parcel needs a person to decide between a refund, a reship and a
-- claim; quietly picking one here would be the code making a commercial
-- decision it has no business making.
-- ------------------------------------------------------------

create or replace function admin_update_shipment(
  p_shipment_id uuid,
  p_status      text,
  p_at          timestamptz default null
)
returns text                    -- the order's status after this call
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid       uuid := require_staff();
  s         shipments%rowtype;
  o         orders%rowtype;
  ts        timestamptz := coalesce(p_at, now());
  remaining int;
begin
  if p_status not in ('label_created', 'picked_up', 'in_transit',
                      'out_for_delivery', 'delivered', 'rto', 'lost') then
    raise exception 'unknown shipment status %', p_status using errcode = '22023';
  end if;

  select * into s from shipments where id = p_shipment_id for update;
  if not found then
    raise exception 'shipment % not found', p_shipment_id using errcode = 'P0002';
  end if;

  -- Locked in the same order admin_ship_order takes them, so two staff
  -- acting on one order cannot deadlock against each other.
  select * into o from orders where id = s.order_id for update;

  if o.status in ('cancelled', 'refunded') then
    raise exception 'order % is %', o.order_number, o.status using errcode = '55000';
  end if;

  -- Already there. Idempotent rather than an error: a courier webhook
  -- redelivering "delivered" is the ordinary case, not a fault.
  if s.status = p_status then
    return o.status;
  end if;

  update shipments
     set status       = p_status,
         delivered_at = case when p_status = 'delivered' then ts else delivered_at end,
         -- shipments_delivered_after_shipped refuses a delivery that
         -- predates dispatch. A shipment created by admin_ship_order
         -- always has shipped_at, but one created any other way may not,
         -- and a null there would let the check pass on a lie.
         shipped_at   = case
                          when shipped_at is not null then shipped_at
                          when p_status in ('picked_up', 'in_transit',
                                            'out_for_delivery', 'delivered') then ts
                          else shipped_at
                        end,
         updated_at   = now()
   where id = p_shipment_id;

  if p_status <> 'delivered' then
    return o.status;
  end if;

  select count(*) into remaining
    from shipments
   where order_id = s.order_id
     and status not in ('delivered', 'rto', 'lost');

  if remaining > 0 then
    -- Part of the order is still on its way. Nothing to announce yet.
    return o.status;
  end if;

  update orders set status = 'delivered', updated_at = now() where id = o.id;

  insert into order_events (order_id, event, from_status, to_status, actor_type, actor_id)
  values (o.id, 'delivered', o.status, 'delivered', 'staff', uid);

  return 'delivered';
end $$;

revoke execute on function admin_update_shipment(uuid, text, timestamptz) from public;
grant  execute on function admin_update_shipment(uuid, text, timestamptz) to authenticated;

commit;
