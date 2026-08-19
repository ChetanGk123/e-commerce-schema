-- ============================================================
-- 0025  Store credit becomes spendable
--
-- credit_ledger has carried an 'order_payment' reason since the
-- baseline, and the table's own comment says "Spend it at checkout by
-- adding a payments row with provider = 'store_credit'". Nothing did.
-- Staff could grant credit, a return could resolve to it, a gift card
-- could be redeemed into it, and the customer could watch the balance on
-- /credit -- and never spend a rupee of it. api-plan B12 lists this as
-- still open.
--
-- Two changes, and the first is the one to read carefully.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. capture_payment() learns that an order can be paid in parts
--
-- Its amount check compared what the gateway captured against the
-- ORDER TOTAL: "a gateway that captures less than it was asked for is a
-- dispute, not a checkout". That reasoning is right and is kept. What
-- changes is the number it is right about -- once credit has already
-- paid part of the order, the gateway was never asked for the total,
-- and comparing against it would refuse every correct capture.
--
-- So it compares against what is still outstanding: the total, less
-- everything already captured against this order. With no credit in
-- play that is exactly grand_total, so nothing about the existing path
-- changes.
-- ------------------------------------------------------------

-- The four-argument capture_payment() from 20260801001500 was superseded
-- by the five-argument one in 20260801001700 and never dropped, so both
-- have been sitting there. Nothing noticed, because PostgREST calls it
-- with named parameters and only one candidate takes five. A positional
-- four-argument call is ambiguous between them -- which is exactly how
-- this was found, when checkout() below tried to make one.
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
  due   numeric(12,2);
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;

  if o.status <> 'pending' then
    return false;
  end if;

  -- What this provider was actually asked for.
  --
  -- This compared against grand_total, and the reasoning behind it is
  -- kept: a gateway that captures less than it was asked for is a
  -- dispute, not a checkout. What changes is the number it is right
  -- about. Once store credit has already paid part of the order the
  -- gateway was never asked for the total, and comparing against it
  -- would refuse every correct capture. With no credit in play `due` is
  -- exactly grand_total, so the existing path is unchanged.
  select o.grand_total - coalesce(sum(p.amount), 0) into due
  from payments p
  where p.order_id = p_order_id and p.status = 'captured';

  if p_amount is not null and p_amount <> due then
    raise exception
      'gateway captured % against an outstanding %', p_amount, due
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
-- 2. Spending it, inside the checkout transaction
--
-- WHY THIS IS NOT A SECOND CALL. The balance has to be read, checked
-- and debited in the same transaction that creates the order, for the
-- same reason the coupon redemption and the stock reservation are:
-- two checkouts a millisecond apart would otherwise both read the same
-- balance and both spend it.
--
-- The lock is on the customers row rather than on credit_ledger. The
-- ledger has no row to lock when the balance is being read (SELECT does
-- not block INSERT), so locking the owner is what actually serialises
-- two concurrent spends by the same person.
--
-- ponytail: one lock per customer, which serialises that customer's
-- concurrent checkouts and nobody else's. Fine at any volume a person
-- generates; revisit only if a single account is placing orders
-- concurrently on purpose.
--
-- The balance rule is copied from customer_credit_balances, expiry and
-- all. If the two ever disagree, the customer's screen and the amount
-- they can spend disagree, which is the kind of bug that arrives as an
-- angry support ticket rather than as an exception.
-- ------------------------------------------------------------

create or replace function apply_store_credit(
  p_order_id uuid,
  p_customer uuid,
  p_grand    numeric
)
returns numeric               -- how much credit was actually spent
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  bal     numeric(12,2);
  applied numeric(12,2);
begin
  if p_customer is null then
    -- A guest has no ledger to spend from. Not an error: the caller asked
    -- for credit and there is none, which is the same as asking for more
    -- than the balance.
    return 0;
  end if;

  perform 1 from customers where id = p_customer for update;

  select coalesce(sum(delta), 0) into bal
  from credit_ledger
  where customer_id = p_customer
    and (expires_at is null or expires_at > now());

  applied := least(bal, p_grand);
  if applied <= 0 then
    return 0;
  end if;

  insert into credit_ledger (customer_id, delta, reason, order_id, note)
  values (p_customer, -applied, 'order_payment', p_order_id,
          'spent at checkout');

  -- 'created', not 'captured': capture_payment() is what moves an order
  -- to paid, and letting it do that here too keeps one function
  -- responsible for converting reservations into sales.
  insert into payments (order_id, provider, amount, status)
  values (p_order_id, 'store_credit', applied, 'created');

  return applied;
end $$;

revoke execute on function apply_store_credit(uuid, uuid, numeric) from public;
-- checkout() is definer and calls this; nothing else should.
revoke execute on function apply_store_credit(uuid, uuid, numeric) from authenticated;

-- ------------------------------------------------------------
-- 3. checkout(), with one more parameter and one more branch
--
-- Replaced whole because Postgres has no way to edit part of a function.
-- The diff against 20260801001400_checkout.sql is: the p_use_credit
-- parameter, the credit/o_status locals, the block that spends credit
-- before the gateway payment row is sized, and credit_applied in the
-- result.
-- ------------------------------------------------------------

-- A different argument list is a different function, so without this the
-- old ten-parameter checkout() would still exist beside the new one and
-- PostgREST would have two candidates to resolve between. Not a coin toss
-- to leave lying at a payment boundary.
drop function if exists
  checkout(text, text, text, text, jsonb, jsonb, text, text, uuid, int);

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
  p_hold_minutes     int  default 15,
  -- Spend the caller's store credit against this order, as much of it as
  -- the balance and the total allow. Ignored for guests, who have no
  -- ledger. Opt-in: a customer with a balance may well be saving it.
  p_use_credit       boolean default false
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
  credit    numeric(12,2) := 0;
  o_status  text := 'pending';
  res       jsonb;
begin
  if p_payment_method not in ('razorpay', 'cod') then
    raise exception 'That payment method is not supported.'
      using errcode = 'ECOM1', hint = 'unsupported_payment_method';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Your cart is empty.'
      using errcode = 'ECOM1', hint = 'cart_empty';
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
      raise exception 'This request was already submitted with a different basket.'
        using errcode = 'ECOM2', hint = 'idempotency_key_conflict';
    end if;
    if ik.completed_at is null then
      raise exception 'That checkout is still being processed. Try again in a moment.'
        using errcode = 'ECOM2', hint = 'checkout_in_flight';
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
    raise exception 'One or more items in your cart are no longer available.'
      using errcode = 'ECOM2', hint = 'items_unavailable';
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
      raise exception 'Coupon % is not valid.', p_coupon_code
        using errcode = 'ECOM1', hint = 'invalid_coupon';
    end if;
    if d.min_order_total is not null and subtotal < d.min_order_total then
      raise exception 'Coupon % needs an order of at least %.',
        p_coupon_code, d.min_order_total
        using errcode = 'ECOM1', hint = 'coupon_minimum_not_met';
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
      raise exception 'Coupon % does not apply to anything in this order.',
        p_coupon_code using errcode = 'ECOM1', hint = 'coupon_not_applicable';
    end if;
  end if;

  -- 4. Shipping, through the same function that quoted it on the cart
  --    page. Computing it a second way here is how the quote and the
  --    charge come to disagree.
  pin := p_shipping_address ->> 'postal_code';
  select * into q from shipping_quote(pin, weight_g, subtotal - discount);
  if not found then
    raise exception 'We do not deliver to %.', coalesce(pin, 'that pincode')
      using errcode = 'ECOM1', hint = 'not_serviceable';
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
      raise exception 'Cash on delivery is not available for this order.'
        using errcode = 'ECOM1', hint = 'cod_unavailable';
    end if;
    if not q.cod_allowed then
      raise exception 'Cash on delivery is not available for %.', pin
        using errcode = 'ECOM1', hint = 'cod_unavailable';
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

  -- 9b. Store credit, before the gateway row, because the gateway is
  --     owed whatever credit does not cover. Inside this transaction for
  --     the same reason the redemption above is: two checkouts a
  --     millisecond apart would otherwise read the same balance and both
  --     spend it. apply_store_credit() takes the lock that stops that.
  if p_use_credit then
    credit := apply_store_credit(o_id, uid, grand);
  end if;

  if grand - credit > 0 then
    insert into payments (order_id, provider, amount, status)
    values (o_id, case when p_payment_method = 'cod' then 'cod' else 'razorpay' end,
            grand - credit, 'created')
    returning id into pay_id;
  else
    -- Credit covered the lot, so there is nothing for a gateway to do
    -- and nothing to wait for. capture_payment() is what moves an order
    -- to paid and converts the reservations into sales; calling it here
    -- rather than repeating those ledger moves is what keeps one
    -- function responsible for them.
    perform capture_payment(o_id, 'store_credit', null, grand);
    o_status := 'paid';
    select id into pay_id
    from payments where order_id = o_id and provider = 'store_credit';
  end if;

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
    'status',         o_status,
    'payment_id',     pay_id,
    'payment_method', p_payment_method,
    'credit_applied', credit,
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
  checkout(text, text, text, text, jsonb, jsonb, text, text, uuid, int, boolean) from public;
grant execute on function
  checkout(text, text, text, text, jsonb, jsonb, text, text, uuid, int, boolean)
  to anon, authenticated;

commit;
