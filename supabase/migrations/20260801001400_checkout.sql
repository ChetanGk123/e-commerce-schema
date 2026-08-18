-- ============================================================
-- 0014  Checkout
--
-- The sequence in docs/schema_guide.md section 20, as one call.
-- supabase-js issues one PostgREST request per statement, so running
-- that sequence from TypeScript is seven transactions: a failure at
-- step 5 leaves stock reserved, an order half-built, and a coupon
-- counted. There is no version of this that is safe outside a
-- function.
--
-- SECURITY DEFINER, and the owner (postgres) has BYPASSRLS, so this
-- runs with RLS off. That is required -- `orders` has no INSERT policy
-- for customers, deliberately, because order totals are never trusted
-- to a browser -- and it makes one rule load-bearing:
--
--     the customer is taken from auth.uid(), never from a parameter.
--
-- There is no p_customer_id. A caller cannot place an order as someone
-- else because there is nowhere to say who they are.
--
-- If these migrations are ever applied by a role WITHOUT BYPASSRLS,
-- checkout will start failing with row-level security errors rather
-- than doing something quietly wrong.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Splitting an order discount across its lines
--
-- Extracted because two functions have to agree to the paisa or every
-- invoice fails to reconcile against the order it bills: checkout
-- computes tax_total before the order exists, admin_issue_invoice
-- computes invoice lines after. Same arithmetic, one implementation.
--
-- The last line absorbs the rounding remainder. Without that the
-- rounded shares do not add back up: subtotal 100.00 across three
-- lines of 33.34/33.33/33.33 with a 1.00 discount rounds to
-- 33.01/33.00/33.00 = 99.01, a paisa more than the 99.00 actually
-- charged, and the invoice total disagrees with the order.
-- ------------------------------------------------------------

create or replace function apportion_taxable(
  p_lines    jsonb,      -- [{ "line_total": n, "gst_rate": n, ... }]
  p_subtotal numeric,
  p_discount numeric
)
returns jsonb            -- the same array, each element gaining taxable_value
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(
           jsonb_agg(x.line || jsonb_build_object('taxable_value', x.taxable)
                     order by x.ord),
           '[]'::jsonb)
  from (
    select t.e as line,
           t.ord,
           b.taxable
           + case when t.ord = max(t.ord) over ()
                  then (p_subtotal - p_discount) - sum(b.taxable) over ()
                  else 0 end as taxable
    from jsonb_array_elements(p_lines) with ordinality as t(e, ord)
    cross join lateral (
      select round((t.e ->> 'line_total')::numeric
                   - case when p_subtotal > 0
                          then p_discount * (t.e ->> 'line_total')::numeric / p_subtotal
                          else 0 end, 2) as taxable
    ) b
  ) x;
$$;

revoke execute on function apportion_taxable(jsonb, numeric, numeric) from public;

-- ------------------------------------------------------------
-- Taking an order
--
-- p_items is [{"variant_id": uuid, "quantity": int}]. Everything else
-- about those items -- price, name, SKU, weight, GST rate -- is read
-- from the database. The request says what, never what it costs.
-- ------------------------------------------------------------

create or replace function checkout(
  p_idempotency_key  text,
  p_request_hash     text,
  p_email            text,
  p_phone            text,
  p_items            jsonb,
  p_shipping_address jsonb,
  p_payment_method   text,
  p_coupon_code      text default null,
  p_cart_id          uuid default null,
  p_hold_minutes     int  default 15
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid       uuid := auth.uid();
  ik        idempotency_keys%rowtype;
  claimed   text;
  d         discounts%rowtype;
  q         record;
  pin       text;
  v_lines   jsonb;
  n_items   int;
  weight_g  int           := 0;
  max_rate  numeric(4,2)  := 0;
  subtotal  numeric(12,2) := 0;
  discount  numeric(12,2) := 0;
  shipping  numeric(12,2) := 0;
  tax       numeric(12,2) := 0;
  grand     numeric(12,2);
  eligible  numeric(12,2) := 0;
  flags     jsonb := '[]'::jsonb;
  risk      int;
  o_id      uuid;
  o_number  text;
  pay_id    uuid;
  res       jsonb;
begin
  if p_payment_method not in ('razorpay', 'cod') then
    raise exception 'unsupported payment method %', p_payment_method
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'your cart is empty' using errcode = '22023';
  end if;

  -- 1. Claim the idempotency key FIRST.
  --
  -- Two concurrent identical requests do not both proceed: the second
  -- INSERT blocks on the unique index until the first commits or rolls
  -- back, then either replays the stored response or takes over.
  insert into idempotency_keys (key, scope, request_hash, customer_id, locked_at)
  values (p_idempotency_key, 'checkout', p_request_hash, uid, now())
  on conflict (key) do nothing
  returning key into claimed;

  if claimed is null then
    select * into ik from idempotency_keys where key = p_idempotency_key;

    -- Same key, different body is a client bug. Replaying the first
    -- response would hide it and charge for the wrong basket.
    if ik.request_hash is distinct from p_request_hash then
      raise exception 'this idempotency key was already used for a different request'
        using errcode = '22023';
    end if;
    if ik.completed_at is null then
      raise exception 'a checkout with this key is still in flight'
        using errcode = '55006';
    end if;
    return ik.response_body;
  end if;

  -- 2. Price the basket from the database.
  select jsonb_agg(jsonb_build_object(
           'variant_id',    v.id,
           'product_id',    p.id,
           'product_name',  p.name,
           'variant_title', coalesce(v.title, 'Default'),
           'sku',           v.sku,
           'unit_price',    v.price,
           'quantity',      req.quantity,
           'line_total',    round(v.price * req.quantity, 2),
           'gst_rate',      coalesce(p.gst_rate, 0))),
         count(*),
         coalesce(sum(round(v.price * req.quantity, 2)), 0),
         coalesce(sum(coalesce(v.weight_grams, 0) * req.quantity), 0),
         coalesce(max(coalesce(p.gst_rate, 0)), 0)
    into v_lines, n_items, subtotal, weight_g, max_rate
  from jsonb_to_recordset(p_items) as req(variant_id uuid, quantity int)
  join product_variants v on v.id = req.variant_id
  join products p on p.id = v.product_id
  where v.status = 'active' and p.status = 'active' and req.quantity > 0;

  -- A short count means something in the basket is archived, draft or
  -- gone. Naming which would let anyone enumerate unreleased products.
  if v_lines is null or n_items <> jsonb_array_length(p_items) then
    raise exception 'one or more items are no longer available'
      using errcode = 'P0002';
  end if;

  -- 3. Coupon. Locked, because max_uses is enforced by a counter and
  --    two checkouts must not both claim the last use.
  if p_coupon_code is not null then
    select * into d from discounts
    where code = p_coupon_code
      and is_active
      and starts_at <= now()
      and (ends_at is null or ends_at > now())
    for update;

    -- One message for expired, inactive and non-existent alike: three
    -- messages is a way to enumerate live codes.
    if not found then
      raise exception 'coupon % is not valid', p_coupon_code using errcode = 'P0002';
    end if;
    if d.min_order_total is not null and subtotal < d.min_order_total then
      raise exception 'coupon % needs an order of at least %',
        p_coupon_code, d.min_order_total using errcode = '55000';
    end if;

    select coalesce(sum((e ->> 'line_total')::numeric), 0) into eligible
    from jsonb_array_elements(v_lines) e
    where d.applies_to = 'order'
       or (d.applies_to = 'product' and (e ->> 'product_id')::uuid = d.product_id)
       or (d.applies_to = 'collection' and exists (
             select 1 from collection_products cp
             where cp.collection_id = d.collection_id
               and cp.product_id = (e ->> 'product_id')::uuid));

    if d.kind = 'percent' then
      discount := round(eligible * d.value / 100, 2);
    elsif d.kind = 'fixed' then
      -- Capped at what it applies to, or orders_discount_within_subtotal
      -- refuses the insert.
      discount := least(d.value, eligible);
    end if;

    if discount = 0 and d.kind <> 'free_shipping' then
      raise exception 'coupon % does not apply to anything in this order',
        p_coupon_code using errcode = '55000';
    end if;
  end if;

  -- 4. Shipping, through the same function that quoted it on the cart
  --    page. Computing it a second way here is how the quote and the
  --    charge come to disagree.
  pin := p_shipping_address ->> 'postal_code';
  select * into q from shipping_quote(pin, weight_g, subtotal - discount);
  if not found then
    raise exception 'we do not deliver to %', coalesce(pin, '(no pincode)')
      using errcode = '55000';
  end if;

  shipping := q.rate;
  if d.id is not null and d.kind = 'free_shipping' then
    -- Zero the shipping rather than adding to discount_total:
    -- orders_discount_within_subtotal caps the discount at the subtotal,
    -- and free shipping is not a discount on goods.
    shipping := 0;
  end if;

  -- 5. COD gating. The blocklist exists to stop repeat RTO offenders
  --    before they cost two-way courier fees; not consulting it here
  --    means it never blocks anybody.
  select coalesce(jsonb_agg(f), '[]'::jsonb) into flags
  from (
    select 'blocklisted_' || b.kind as f
    from blocklist b
    where (b.expires_at is null or b.expires_at > now())
      and ((b.kind = 'phone'   and b.value = p_phone)
        or (b.kind = 'email'   and b.value = p_email)
        or (b.kind = 'pincode' and b.value = pin))
  ) hits;

  risk := case when jsonb_array_length(flags) > 0 then 100 else null end;

  if p_payment_method = 'cod' then
    if jsonb_array_length(flags) > 0 then
      raise exception 'cash on delivery is not available for this order'
        using errcode = '55000';
    end if;
    if not q.cod_allowed then
      raise exception 'cash on delivery is not available for %', pin
        using errcode = '55000';
    end if;
    shipping := shipping + q.cod_surcharge;
  end if;

  -- 6. Tax. Prices are GST-exclusive here: grand_total = subtotal
  --    - discount + shipping + tax, and orders_totals_balance enforces it.
  --    Shipping is taxed at the highest item rate (composite supply),
  --    matching admin_issue_invoice.
  v_lines := apportion_taxable(v_lines, subtotal, discount);

  -- 2 * round(rate/200) rather than round(rate/100): the invoice must
  -- split intra-state tax into two EQUAL halves (invoice_lines_
  -- cgst_equals_sgst), so the amount has to be even in paise. Rounding
  -- to the full rate here would leave the invoice a paisa off.
  select coalesce(sum(2 * round((e ->> 'taxable_value')::numeric
                                * (e ->> 'gst_rate')::numeric / 200, 2)), 0)
    into tax
  from jsonb_array_elements(v_lines) e;

  tax   := tax + 2 * round(shipping * max_rate / 200, 2);
  grand := subtotal - discount + shipping + tax;

  -- 7. The order.
  insert into orders (customer_id, email, phone,
                      subtotal, discount_total, shipping_total, tax_total, grand_total,
                      coupon_code, shipping_address, risk_score, risk_flags)
  values (uid, p_email, p_phone,
          subtotal, discount, shipping, tax, grand,
          case when d.id is not null then p_coupon_code end,
          p_shipping_address, risk, flags)
  returning id, order_number into o_id, o_number;

  insert into order_items (order_id, variant_id, product_name, variant_title,
                           sku, unit_price, quantity)
  select o_id, (e ->> 'variant_id')::uuid, e ->> 'product_name',
         e ->> 'variant_title', e ->> 'sku',
         (e ->> 'unit_price')::numeric, (e ->> 'quantity')::int
  from jsonb_array_elements(v_lines) e;

  -- 8. Reserve the stock.
  --
  -- After the order, not before it as section 20 shows, because
  -- inventory_movements is append-only: order_id cannot be filled in
  -- later, and admin_capture_cod finds its reservations by order_id.
  -- The guard is unaffected -- this is one transaction, so a failed
  -- CHECK (stock >= 0) still takes the order with it.
  --
  -- expires_at is mandatory: a hold nothing releases strands that unit
  -- forever. release_expired_reservations() sweeps these.
  insert into inventory_movements (variant_id, quantity, reason, order_id, expires_at)
  select (e ->> 'variant_id')::uuid, -(e ->> 'quantity')::int, 'reservation',
         o_id, now() + make_interval(mins => p_hold_minutes)
  from jsonb_array_elements(v_lines) e;

  -- 9. Redemption. The trigger on this table increments used_count and
  --    refuses the row if it would exceed either limit.
  if d.id is not null and discount > 0 then
    insert into discount_redemptions (discount_id, order_id, customer_id, amount)
    values (d.id, o_id, uid, discount);
  end if;

  insert into payments (order_id, provider, amount, status)
  values (o_id, case when p_payment_method = 'cod' then 'cod' else 'razorpay' end,
          grand, 'created')
  returning id into pay_id;

  insert into order_events (order_id, event, to_status, actor_type, actor_id)
  values (o_id, 'order_placed', 'pending',
          case when uid is null then 'system' else 'customer' end, uid);

  -- 10. Outbox. Queued in the same transaction as the order, so a dead
  --     email provider cannot lose the confirmation or roll back the sale.
  insert into message_log (customer_id, order_id, channel, template, recipient, payload)
  values (uid, o_id, 'email', 'order_confirmation', p_email,
          jsonb_build_object('order_number', o_number, 'grand_total', grand));

  if p_cart_id is not null then
    update carts
    set status = 'converted', converted_order_id = o_id, updated_at = now()
    where id = p_cart_id and status = 'active';
  end if;

  res := jsonb_build_object(
    'order_id',       o_id,
    'order_number',   o_number,
    'status',         'pending',
    'payment_id',     pay_id,
    'payment_method', p_payment_method,
    'currency',       'INR',
    'subtotal',       subtotal,
    'discount_total', discount,
    'shipping_total', shipping,
    'tax_total',      tax,
    'grand_total',    grand,
    'reserved_until', (now() + make_interval(mins => p_hold_minutes)));

  -- 11. Store the response so a retry of step 1 replays it verbatim.
  update idempotency_keys
  set response_status = 201, response_body = res, completed_at = now()
  where key = p_idempotency_key;

  return res;
end $$;

revoke execute on function
  checkout(text, text, text, text, jsonb, jsonb, text, text, uuid, int) from public;
grant execute on function
  checkout(text, text, text, text, jsonb, jsonb, text, text, uuid, int)
  to anon, authenticated;

-- ------------------------------------------------------------
-- admin_issue_invoice, corrected
--
-- Replaced rather than edited in 0012, because 0012 has been applied
-- and a migration that changes after it runs is not a migration.
--
-- Two defects, both worth a paisa and both fatal to reconciliation --
-- an invoice whose total is not what the customer was charged is a
-- GST filing problem, not a rounding curiosity:
--
--  1. The discount was apportioned per line and each share rounded
--     independently, so the rounded shares did not add back up to
--     the discount actually taken. Now shared with checkout via
--     apportion_taxable(), which gives the remainder to the last line.
--
--  2. Same-state tax was 2 * round(taxable * rate/200, 2) while
--     inter-state was round(taxable * rate/100, 2). Those disagree by
--     a paisa on some values, so the identical supply was billed two
--     different totals depending on where the customer lives -- and
--     checkout, which cannot know the place of supply, could only
--     match one of them. Both now derive from the same half:
--     cgst = sgst = half, igst = 2 * half.
--
--     The halving is not a choice. invoice_lines_cgst_equals_sgst and
--     invoices_cgst_equals_sgst require the two to be exactly equal,
--     so the tax on a line has to be an even number of paise.
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
  raw_lines  jsonb;
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
  select jsonb_agg(jsonb_build_object(
           'description', oi.product_name || coalesce(' / ' || oi.variant_title, ''),
           'hsn_code',    p.hsn_code,
           'quantity',    oi.quantity,
           'unit_price',  oi.unit_price,
           'line_total',  oi.line_total,
           'gst_rate',    coalesce(p.gst_rate, 0))
         order by oi.id)
    into raw_lines
  from order_items oi
  left join product_variants v on v.id = oi.variant_id
  left join products p on p.id = v.product_id
  where oi.order_id = p_order_id;

  if raw_lines is null then
    raise exception 'order % has no line items', o.order_number using errcode = '55000';
  end if;

  -- The same split checkout used to arrive at tax_total.
  raw_lines := apportion_taxable(raw_lines, o.subtotal, o.discount_total);

  select jsonb_agg(jsonb_build_object(
           'description',   e ->> 'description',
           'hsn_code',      e ->> 'hsn_code',
           'quantity',      (e ->> 'quantity')::int,
           'unit_price',    (e ->> 'unit_price')::numeric,
           'taxable_value', t.taxable,
           'gst_rate',      (e ->> 'gst_rate')::numeric,
           'cgst_amount',   case when same_state then t.half else 0 end,
           'sgst_amount',   case when same_state then t.half else 0 end,
           'igst_amount',   case when same_state then 0 else 2 * t.half end,
           'line_total',    t.taxable + 2 * t.half))
    into v_lines
  from jsonb_array_elements(raw_lines) e
  cross join lateral (
    -- One half, used three ways. igst is 2 * half rather than its own
    -- rounding, so intra-state and inter-state bill the same amount for
    -- the same supply -- and both match what checkout charged.
    select (e ->> 'taxable_value')::numeric as taxable,
           round((e ->> 'taxable_value')::numeric
                 * (e ->> 'gst_rate')::numeric / 200, 2) as half
  ) t;

  -- Shipping, at the highest item rate (composite supply).
  if o.shipping_total > 0 then
    select coalesce(max((e ->> 'gst_rate')::numeric), 0) into max_rate
    from jsonb_array_elements(v_lines) e;

    ship_base := o.shipping_total;
    ship_tax  := 2 * round(ship_base * max_rate / 200, 2);

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'description',   'Shipping',
      'hsn_code',      null,
      'quantity',      1,
      'unit_price',    ship_base,
      'taxable_value', ship_base,
      'gst_rate',      max_rate,
      'cgst_amount',   case when same_state then ship_tax / 2 else 0 end,
      'sgst_amount',   case when same_state then ship_tax / 2 else 0 end,
      'igst_amount',   case when same_state then 0 else ship_tax end,
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

commit;
