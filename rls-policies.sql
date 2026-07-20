-- ============================================================
-- rls-policies.sql -- Row Level Security for Supabase
-- Run LAST: after ecommerce-schema-full.sql and triggers.sql
--
-- Assumptions (the standard Supabase wiring):
--   * customers.id   = auth.users.id for shoppers
--   * staff_users.id = auth.users.id for staff
--   * Server-side code (Next.js route handlers, edge functions,
--     workers, webhooks) uses the SERVICE KEY, which bypasses RLS.
--     These policies define what BROWSERS may do with the anon /
--     authenticated keys -- least privilege, deny by default.
--
-- Things deliberately done server-side only (service key):
--   order creation & payment capture, invoice issuing, coupon
--   validation, gift-card redemption by code, guest contact forms,
--   and anything touching staff-only tables.
--
-- Note: re-run the two DO blocks below if you add new tables later.
-- ============================================================

-- ------------------------------------------------------------
-- Helper: is the current user an active staff member?
-- SECURITY DEFINER so it can read staff_users even though that
-- table is itself locked down -- this also prevents the policy
-- recursion you'd otherwise get on staff_users.
-- ------------------------------------------------------------

create or replace function is_staff()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from staff_users s
    where s.id = auth.uid() and s.is_active
  )
$$;

-- ------------------------------------------------------------
-- 1. Deny by default: enable RLS on every table in public.
-- ------------------------------------------------------------

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 2. Staff blanket: active staff get full access everywhere.
-- Finer per-role rules (support vs warehouse) live in the admin
-- app; the database draws the staff / non-staff line.
-- ------------------------------------------------------------

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
  loop
    execute format(
      'create policy staff_all on public.%I for all
         using (is_staff()) with check (is_staff())', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 3. Column hiding via definer views.
-- RLS hides ROWS, not COLUMNS. product_variants carries cost_price
-- and store_settings.config may hold secrets, so those tables get
-- no public policy at all -- the storefront reads these views,
-- which project only the safe columns.
-- ------------------------------------------------------------

create or replace view storefront_variants
with (security_invoker = false) as
  select id, product_id, sku, title, description, specs,
         price, compare_at_price, currency, stock,
         weight_grams, is_default, status, created_at
  from product_variants
  where status <> 'archived';

grant select on storefront_variants to anon, authenticated;

create or replace view public_settings
with (security_invoker = false) as
  select store_name, support_email, support_phone,
         free_shipping_above, flat_shipping_rate, cod_enabled
  from store_settings;

grant select on public_settings to anon, authenticated;

-- ------------------------------------------------------------
-- 4. Public catalog (anon + logged-in, read only)
-- ------------------------------------------------------------

create policy public_read on categories            for select using (true);
create policy public_read on collections           for select using (is_active);
create policy public_read on collection_products   for select using (true);
create policy public_read on products              for select using (status = 'active');
create policy public_read on product_options       for select using (true);
create policy public_read on product_option_values for select using (true);
create policy public_read on variant_option_values for select using (true);
create policy public_read on product_images        for select using (true);
create policy public_read on product_relations     for select using (true);
create policy public_read on shipping_zones        for select using (true);
create policy public_read on serviceable_pincodes  for select using (true);
create policy public_read on shipping_rates        for select using (is_active);
create policy public_read on reviews               for select using (status = 'approved');

-- ------------------------------------------------------------
-- 5. Customers and their own data
-- ------------------------------------------------------------

create policy own_profile_r on customers for select using (id = auth.uid());
create policy own_profile_i on customers for insert with check (id = auth.uid());
create policy own_profile_u on customers for update
  using (id = auth.uid()) with check (id = auth.uid());

create policy own_addresses on addresses for all
  using (customer_id = auth.uid()) with check (customer_id = auth.uid());

create policy own_wishlist on wishlist_items for all
  using (customer_id = auth.uid()) with check (customer_id = auth.uid());

create policy own_prefs on communication_preferences for all
  using (customer_id = auth.uid()) with check (customer_id = auth.uid());

-- Logged-in carts. Guest carts (customer_id null + session_id)
-- cannot be safely expressed in RLS: keep guest carts client-side
-- until login, or manage them through server routes.
create policy own_carts on carts for all
  using (customer_id = auth.uid()) with check (customer_id = auth.uid());

create policy own_cart_items on cart_items for all
  using (exists (select 1 from carts c
                 where c.id = cart_id and c.customer_id = auth.uid()))
  with check (exists (select 1 from carts c
                      where c.id = cart_id and c.customer_id = auth.uid()));

-- ------------------------------------------------------------
-- 6. Orders: customers READ their own; only the server writes.
-- Order creation snapshots prices and moves stock -- that math is
-- never trusted to the browser.
-- ------------------------------------------------------------

create policy own_orders on orders for select using (customer_id = auth.uid());

create policy own_order_items on order_items for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = auth.uid()));

create policy own_payments on payments for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = auth.uid()));

create policy own_shipments on shipments for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = auth.uid()));

create policy own_shipment_items on shipment_items for select
  using (exists (select 1 from shipments s
                 join orders o on o.id = s.order_id
                 where s.id = shipment_id and o.customer_id = auth.uid()));

create policy own_order_events on order_events for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = auth.uid()));

create policy own_invoices on invoices for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = auth.uid()));

create policy own_invoice_lines on invoice_lines for select
  using (exists (select 1 from invoices i
                 join orders o on o.id = i.order_id
                 where i.id = invoice_id and o.customer_id = auth.uid()));

create policy own_refunds on refunds for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = auth.uid()));

create policy own_redemptions on discount_redemptions for select
  using (customer_id = auth.uid());

-- ------------------------------------------------------------
-- 7. Returns: customers can raise and watch their own.
-- ------------------------------------------------------------

create policy own_returns_r on return_requests for select
  using (customer_id = auth.uid());

create policy own_returns_i on return_requests for insert
  with check (customer_id = auth.uid()
    and exists (select 1 from orders o
                where o.id = order_id and o.customer_id = auth.uid()));

create policy own_return_items_r on return_items for select
  using (exists (select 1 from return_requests r
                 where r.id = return_id and r.customer_id = auth.uid()));

create policy own_return_items_i on return_items for insert
  with check (exists (select 1 from return_requests r
                      where r.id = return_id and r.customer_id = auth.uid()));

-- ------------------------------------------------------------
-- 8. Reviews: write your own; edit only while pending.
-- (Public read of approved reviews is in section 4.)
-- ------------------------------------------------------------

create policy own_reviews_r on reviews for select using (customer_id = auth.uid());
create policy own_reviews_i on reviews for insert with check (customer_id = auth.uid());
create policy own_reviews_u on reviews for update
  using (customer_id = auth.uid() and status = 'pending')
  with check (customer_id = auth.uid() and status = 'pending');

-- ------------------------------------------------------------
-- 9. Wallet, gift cards, alerts, notifications
-- ------------------------------------------------------------

create policy own_credit on credit_ledger for select using (customer_id = auth.uid());

-- Customers see the cards THEY bought. Redemption by code must be a
-- server-side lookup: a table read here would allow enumerating
-- other people's card codes.
create policy own_gift_cards on gift_cards for select
  using (purchaser_id = auth.uid());

create policy own_alerts_r on stock_alerts for select using (customer_id = auth.uid());
create policy alerts_insert on stock_alerts for insert
  with check (customer_id = auth.uid()
              or (auth.uid() is null
                  and customer_id is null
                  and email is not null));

create policy own_notifications_r on notifications for select
  using (recipient_type = 'customer' and recipient_id = auth.uid());
create policy own_notifications_u on notifications for update
  using (recipient_type = 'customer' and recipient_id = auth.uid())
  with check (recipient_type = 'customer' and recipient_id = auth.uid());

-- ------------------------------------------------------------
-- 10. Support tickets & enquiries
-- ------------------------------------------------------------

create policy own_tickets_r on support_tickets for select
  using (customer_id = auth.uid());
create policy own_tickets_i on support_tickets for insert
  with check (customer_id = auth.uid());

-- Internal notes stay internal: the is_internal = false filter here
-- is what keeps staff-only remarks out of customer eyes.
create policy own_ticket_msgs_r on ticket_messages for select
  using (is_internal = false
    and exists (select 1 from support_tickets t
                where t.id = ticket_id and t.customer_id = auth.uid()));

create policy own_ticket_msgs_i on ticket_messages for insert
  with check (sender_type = 'customer'
    and sender_id = auth.uid()
    and is_internal = false
    and exists (select 1 from support_tickets t
                where t.id = ticket_id and t.customer_id = auth.uid()));

create policy own_enquiries_r on product_enquiries for select
  using (customer_id = auth.uid());
create policy enquiries_insert on product_enquiries for insert
  with check (customer_id = auth.uid()
              or (auth.uid() is null
                  and customer_id is null
                  and (guest_email is not null or guest_phone is not null)));

-- ------------------------------------------------------------
-- Deliberately NOT public
-- ------------------------------------------------------------
-- discounts:            a public read would let anyone enumerate
--                       live coupon codes. Validate codes in a
--                       server route and return only the outcome.
-- product_variants:     table is staff-only; the storefront reads
--                       storefront_variants (hides cost_price).
-- store_settings:       staff-only; storefront reads public_settings.
-- inventory_movements, price_history, message_log, audit_logs,
-- blocklist, staff_users, invoice_sequences,
-- gift_card_transactions: staff or server only.
--
-- Every table without a policy above stays locked: that is the
-- point of enabling RLS everywhere -- deny by default.