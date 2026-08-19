-- ============================================================
-- 0012  Admin RPCs
--
-- Operations that must be atomic and cannot be, from the client.
-- supabase-js has no transactions: it issues one PostgREST request per
-- call, so a five-statement sequence is five transactions and any
-- failure leaves the middle of it committed. Money and stock cannot be
-- run that way, so those sequences live here as single calls.
--
-- EVERY function below is SECURITY DEFINER, which bypasses RLS. That
-- makes the is_staff() guard load-bearing rather than decorative: these
-- are granted to `authenticated`, so without it any signed-in shopper
-- could cancel orders and issue invoices. The guard is the first
-- statement in every one.
--
-- search_path pins pg_temp LAST for the reason the base schema already
-- documents: with `set search_path = public` alone Postgres searches
-- the temp schema first, so anyone able to create a temp table could
-- shadow a table these functions read.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Shared guard
-- ------------------------------------------------------------

create or replace function require_staff()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare uid uuid;
begin
  uid := auth.uid();
  if uid is null or not is_staff() then
    -- 42501 = insufficient_privilege. PostgREST maps it to 403.
    raise exception 'staff access required' using errcode = '42501';
  end if;
  return uid;
end $$;

revoke execute on function require_staff() from public;
grant execute on function require_staff() to authenticated;

-- ------------------------------------------------------------
-- 1. Capture a COD payment
--
-- Converts the reservation into a sale. Two ledger rows, not one: the
-- reservation already took the stock down, and the ledger has to stay
-- honest about what happened rather than quietly rewriting history.
-- ------------------------------------------------------------

create or replace function admin_capture_cod(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := require_staff();
  o   orders%rowtype;
  res record;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;
  if o.status <> 'pending' then
    raise exception 'order % is %, not pending', o.order_number, o.status
      using errcode = '55000';
  end if;

  -- Consume every outstanding reservation for this order. The unique
  -- index on reservation_id makes a double release impossible, so a
  -- retry of this function cannot invent stock.
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

    insert into inventory_movements (variant_id, quantity, reason, order_id, created_by)
    values (res.variant_id, res.quantity, 'sale', p_order_id, uid);
  end loop;

  update payments set status = 'captured', updated_at = now()
  where order_id = p_order_id and provider = 'cod' and status <> 'captured';

  update orders set status = 'paid', updated_at = now() where id = p_order_id;

  insert into order_events (order_id, event, from_status, to_status, actor_type, actor_id)
  values (p_order_id, 'payment_captured', o.status, 'paid', 'staff', uid);
end $$;

-- ------------------------------------------------------------
-- 2. Cancel an order
--
-- Releases outstanding holds so the stock goes back on the shelf
-- immediately rather than waiting for the reservation sweeper.
-- ------------------------------------------------------------

create or replace function admin_cancel_order(p_order_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := require_staff();
  o   orders%rowtype;
  res record;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;
  if o.status in ('shipped', 'delivered', 'refunded', 'cancelled') then
    raise exception 'order % is % and cannot be cancelled', o.order_number, o.status
      using errcode = '55000';
  end if;

  for res in
    select m.id, m.variant_id, m.quantity
    from inventory_movements m
    where m.order_id = p_order_id
      and m.reason = 'reservation'
      and not exists (
        select 1 from inventory_movements c where c.reservation_id = m.id)
  loop
    insert into inventory_movements (variant_id, quantity, reason, order_id, reservation_id, created_by)
    values (res.variant_id, -res.quantity, 'release', p_order_id, res.id, uid);
  end loop;

  -- A paid order that already moved stock as 'sale' needs those units
  -- back too, or cancelling silently loses them.
  if o.status <> 'pending' then
    insert into inventory_movements (variant_id, quantity, reason, order_id, note, created_by)
    select m.variant_id, -sum(m.quantity), 'return', p_order_id,
           'cancelled order ' || o.order_number, uid
    from inventory_movements m
    where m.order_id = p_order_id and m.reason = 'sale'
    group by m.variant_id
    having sum(m.quantity) < 0;
  end if;

  update orders set status = 'cancelled', updated_at = now() where id = p_order_id;

  insert into order_events (order_id, event, from_status, to_status, note, actor_type, actor_id)
  values (p_order_id, 'status_changed', o.status, 'cancelled', p_reason, 'staff', uid);
end $$;

-- ------------------------------------------------------------
-- 3. Ship an order
--
-- p_items is [{"order_item_id": uuid, "quantity": int}, ...]. The
-- shipment-quantity trigger refuses the whole call if it would dispatch
-- more of a line than was ordered, counting across every box.
-- ------------------------------------------------------------

create or replace function admin_ship_order(
  p_order_id        uuid,
  p_items           jsonb,
  p_carrier         text default null,
  p_tracking_number text default null,
  p_tracking_url    text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := require_staff();
  o   orders%rowtype;
  sid uuid;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;
  if o.status = 'pending' then
    raise exception 'order % is unpaid', o.order_number using errcode = '55000';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'p_items must be a non-empty array' using errcode = '22023';
  end if;

  insert into shipments (order_id, carrier, tracking_number, tracking_url, status, shipped_at)
  values (p_order_id, p_carrier, p_tracking_number, p_tracking_url, 'label_created', now())
  returning id into sid;

  insert into shipment_items (shipment_id, order_item_id, order_id, quantity)
  select sid, (e ->> 'order_item_id')::uuid, p_order_id, (e ->> 'quantity')::int
  from jsonb_array_elements(p_items) e;

  update orders set status = 'shipped', updated_at = now() where id = p_order_id;

  insert into order_events (order_id, event, from_status, to_status, actor_type, actor_id)
  values (p_order_id, 'shipment_created', o.status, 'shipped', 'staff', uid);

  return sid;
end $$;

-- ------------------------------------------------------------
-- 4. Issue a GST invoice
--
-- The number and the invoice MUST be created in the same transaction:
-- next_invoice_number() takes a row lock and a rollback takes the
-- number back with it. That is what makes numbering gap-free, which GST
-- requires and ordinary sequences cannot provide.
--
-- TWO ASSUMPTIONS, both stated because an accountant may need to
-- overrule them:
--
--   * place_of_supply is a PARAMETER. The order's address snapshot
--     stores a state NAME, and this schema has no state-name to
--     state-code table, so the caller resolves it. It defaults to the
--     seller's own state, which produces CGST+SGST.
--   * Shipping is invoiced as its own line at the highest GST rate
--     among the items (the composite-supply convention). Order-level
--     discount is apportioned across item lines by value.
-- ------------------------------------------------------------

create or replace function admin_issue_invoice(
  p_order_id        uuid,
  p_place_of_supply text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid        uuid := require_staff();
  o          orders%rowtype;
  s          store_settings%rowtype;
  pos        text;
  same_state boolean;
  inv_id     uuid;
  inv_no     text;
  max_rate   numeric(4,2);
  ship_base  numeric(12,2) := 0;
  ship_tax   numeric(12,2) := 0;
  v_lines    jsonb;
  tot        record;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;
  if o.status = 'pending' then
    raise exception 'order % is unpaid', o.order_number using errcode = '55000';
  end if;

  if exists (select 1 from invoices where order_id = p_order_id and kind = 'tax_invoice') then
    raise exception 'order % already has a tax invoice', o.order_number
      using errcode = '23505';
  end if;

  select * into s from store_settings where id = 1;
  if s.seller_gstin is null then
    raise exception 'store_settings.seller_gstin is not set; invoicing cannot proceed'
      using errcode = '55000';
  end if;

  pos := coalesce(p_place_of_supply, s.seller_state_code);
  if pos is null then
    raise exception 'no place of supply and no seller_state_code' using errcode = '55000';
  end if;
  same_state := (pos = s.seller_state_code);

  -- Lines are computed BEFORE the invoice row exists. The obvious
  -- shape -- insert the invoice with zero totals, add lines, then
  -- update the totals -- is refused by protect_invoice(), and rightly:
  -- an invoice that can be updated after issue is not a legal document.
  -- So the arithmetic happens once, into jsonb, and both the header and
  -- the lines are written from it.
  --
  -- taxable_value carries each line's share of the order discount,
  -- because GST is due on what was actually charged.
  select jsonb_agg(jsonb_build_object(
           'description',   oi.product_name || coalesce(' / ' || oi.variant_title, ''),
           'hsn_code',      p.hsn_code,
           'quantity',      oi.quantity,
           'unit_price',    oi.unit_price,
           'taxable_value', net.taxable,
           'gst_rate',      coalesce(p.gst_rate, 0),
           'cgst_amount',   case when same_state then net.half else 0 end,
           'sgst_amount',   case when same_state then net.half else 0 end,
           'igst_amount',   case when same_state then 0 else net.full end,
           'line_total',    net.taxable
                            + case when same_state then 2 * net.half else net.full end))
    into v_lines
  from order_items oi
  left join product_variants v on v.id = oi.variant_id
  left join products p on p.id = v.product_id
  cross join lateral (
    select round(oi.line_total - (case when o.subtotal > 0
                                       then o.discount_total * oi.line_total / o.subtotal
                                       else 0 end), 2) as taxable
  ) base
  cross join lateral (
    select base.taxable,
           round(base.taxable * coalesce(p.gst_rate, 0) / 200, 2) as half,
           round(base.taxable * coalesce(p.gst_rate, 0) / 100, 2) as full
  ) net
  where oi.order_id = p_order_id;

  if v_lines is null then
    raise exception 'order % has no line items', o.order_number using errcode = '55000';
  end if;

  -- Shipping, at the highest item rate (composite supply).
  if o.shipping_total > 0 then
    select coalesce(max((e ->> 'gst_rate')::numeric), 0) into max_rate
    from jsonb_array_elements(v_lines) e;

    ship_base := o.shipping_total;
    ship_tax  := case when same_state then 2 * round(ship_base * max_rate / 200, 2)
                      else round(ship_base * max_rate / 100, 2) end;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'description',   'Shipping',
      'hsn_code',      null,
      'quantity',      1,
      'unit_price',    ship_base,
      'taxable_value', ship_base,
      'gst_rate',      max_rate,
      'cgst_amount',   case when same_state then round(ship_base * max_rate / 200, 2) else 0 end,
      'sgst_amount',   case when same_state then round(ship_base * max_rate / 200, 2) else 0 end,
      'igst_amount',   case when same_state then 0 else round(ship_base * max_rate / 100, 2) end,
      'line_total',    ship_base + ship_tax));
  end if;

  select sum(taxable_value) as taxable, sum(cgst_amount) as cgst,
         sum(sgst_amount) as sgst, sum(igst_amount) as igst, sum(line_total) as total
    into tot
  from jsonb_to_recordset(v_lines) as x(
    taxable_value numeric, cgst_amount numeric,
    sgst_amount numeric, igst_amount numeric, line_total numeric);

  -- Number and invoice in the same transaction: a rollback takes the
  -- number back with it, which is what keeps numbering gap-free.
  inv_no := next_invoice_number();

  insert into invoices (
    invoice_number, order_id, kind, customer_name, billing_address,
    seller_gstin, place_of_supply,
    taxable_value, cgst_total, sgst_total, igst_total, grand_total)
  values (
    inv_no, p_order_id, 'tax_invoice',
    coalesce(o.shipping_address ->> 'name', 'Customer'),
    coalesce(o.billing_address, o.shipping_address),
    s.seller_gstin, pos,
    tot.taxable, tot.cgst, tot.sgst, tot.igst, tot.total)
  returning id into inv_id;

  insert into invoice_lines (
    invoice_id, description, hsn_code, quantity, unit_price,
    taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, line_total)
  select inv_id, x.description, x.hsn_code, x.quantity, x.unit_price,
         x.taxable_value, x.gst_rate, x.cgst_amount, x.sgst_amount,
         x.igst_amount, x.line_total
  from jsonb_to_recordset(v_lines) as x(
    description text, hsn_code text, quantity int, unit_price numeric,
    taxable_value numeric, gst_rate numeric, cgst_amount numeric,
    sgst_amount numeric, igst_amount numeric, line_total numeric);

  insert into order_events (order_id, event, note, actor_type, actor_id)
  values (p_order_id, 'invoice_issued', inv_no, 'staff', uid);

  return inv_id;
end $$;

-- ------------------------------------------------------------
-- 5. Receive a return
--
-- p_items is [{"order_item_id": uuid, "quantity": int,
--              "variant_id": uuid, "condition": text}, ...].
-- Resalable units go back to stock; damaged ones are recorded as
-- damage so the ledger explains where they went.
-- ------------------------------------------------------------

create or replace function admin_receive_return(
  p_return_id  uuid,
  p_items      jsonb,
  p_resolution text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid    uuid := require_staff();
  r      return_requests%rowtype;
  it     record;
  refund numeric(12,2) := 0;
  unit   numeric(12,2);
begin
  if p_resolution not in ('refund', 'replacement', 'store_credit') then
    raise exception 'unknown resolution %', p_resolution using errcode = '22023';
  end if;

  select * into r from return_requests where id = p_return_id for update;
  if not found then
    raise exception 'return % not found', p_return_id using errcode = 'P0002';
  end if;
  if r.status in ('received', 'refunded', 'closed', 'rejected') then
    raise exception 'return is already %', r.status using errcode = '55000';
  end if;

  for it in
    select (e ->> 'order_item_id')::uuid as order_item_id,
           (e ->> 'quantity')::int       as quantity,
           (e ->> 'variant_id')::uuid    as variant_id,
           coalesce(e ->> 'condition', 'resalable') as condition
    from jsonb_array_elements(p_items) e
  loop
    update return_items
    set condition = it.condition
    where return_id = p_return_id and order_item_id = it.order_item_id;

    if it.variant_id is not null then
      insert into inventory_movements (variant_id, quantity, reason, order_id, note, created_by)
      values (
        it.variant_id,
        case when it.condition = 'resalable' then it.quantity else -it.quantity end,
        case when it.condition = 'resalable' then 'return' else 'damage' end,
        r.order_id, 'RMA ' || p_return_id, uid);
    end if;

    select oi.unit_price into unit from order_items oi where oi.id = it.order_item_id;
    refund := refund + coalesce(unit, 0) * it.quantity;
  end loop;

  update return_requests
  set status = 'received', resolution = p_resolution, resolved_at = now(), updated_at = now()
  where id = p_return_id;

  -- Store credit is a ledger entry; there is no balance column to bump.
  -- A cash refund is left to the caller, because it has to reference the
  -- original payment the gateway will refund against.
  if p_resolution = 'store_credit' and r.customer_id is not null and refund > 0 then
    insert into credit_ledger (customer_id, delta, reason, order_id, return_id, created_by)
    values (r.customer_id, refund, 'return_credit', r.order_id, p_return_id, uid);
  end if;

  insert into order_events (order_id, event, note, actor_type, actor_id)
  values (r.order_id, 'return_received', p_resolution, 'staff', uid);
end $$;

-- ------------------------------------------------------------
-- Grants
--
-- anonymize_customer() was revoked from public in the base schema, so
-- the API cannot call it without this.
-- ------------------------------------------------------------

revoke execute on function admin_capture_cod(uuid)                        from public;
revoke execute on function admin_cancel_order(uuid, text)                 from public;
revoke execute on function admin_ship_order(uuid, jsonb, text, text, text) from public;
revoke execute on function admin_issue_invoice(uuid, text)                from public;
revoke execute on function admin_receive_return(uuid, jsonb, text)        from public;

grant execute on function admin_capture_cod(uuid)                         to authenticated;
grant execute on function admin_cancel_order(uuid, text)                  to authenticated;
grant execute on function admin_ship_order(uuid, jsonb, text, text, text) to authenticated;
grant execute on function admin_issue_invoice(uuid, text)                 to authenticated;
grant execute on function admin_receive_return(uuid, jsonb, text)         to authenticated;
grant execute on function anonymize_customer(uuid)                        to authenticated;

-- ------------------------------------------------------------
-- Reporting views
--
-- security_invoker = true so the caller's RLS still applies. A definer
-- view here would hand every signed-in shopper the store's revenue.
-- ------------------------------------------------------------

create or replace view admin_sales_daily
with (security_invoker = true) as
  select date_trunc('day', placed_at)::date as day,
         count(*)                            as orders,
         sum(grand_total)                    as revenue,
         sum(discount_total)                 as discounts,
         avg(grand_total)::numeric(12,2)     as average_order_value
  from orders
  where status not in ('cancelled', 'refunded')
  group by 1;

create or replace view admin_low_stock
with (security_invoker = true) as
  select v.id as variant_id, v.product_id, p.name as product_name,
         v.sku, v.title, v.stock, v.low_stock_threshold
  from product_variants v
  join products p on p.id = v.product_id
  where v.status = 'active' and v.stock <= v.low_stock_threshold;

grant select on admin_sales_daily to authenticated;
grant select on admin_low_stock   to authenticated;

commit;
