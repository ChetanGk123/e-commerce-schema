-- ============================================================
-- 0010  Views, Row Level Security, and grants
--
-- Assumptions (the standard Supabase wiring):
--   * customers.id   = auth.users.id for shoppers
--   * staff_users.id = auth.users.id for staff
--   * Server-side code (route handlers, edge functions, workers,
--     webhooks) uses the SERVICE KEY, which bypasses RLS.
--
-- These policies define what BROWSERS may do with the anon and
-- authenticated keys. Deny by default.
--
-- Server-side only, deliberately: order creation and payment
-- capture, invoice issuing, coupon validation, gift-card redemption
-- by code, guest contact forms, and anything touching staff tables.
--
-- ------------------------------------------------------------
-- THE RULE THIS FILE NOW FOLLOWS
--
-- An INSERT policy must constrain STATE, not just OWNERSHIP.
--
-- The previous version checked only "is this row mine?", and
-- PostgREST lets a client set every column it has been granted. So
-- a customer could insert a review with status='approved' and
-- is_verified=true and publish it straight to the storefront; file a
-- return already marked 'refunded'; or open every ticket at
-- priority='urgent'. Each policy below pins the columns a client has
-- no business choosing.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Helper: is the current user an active staff member?
--
-- SECURITY DEFINER so it can read staff_users even though that table
-- is locked down, which also avoids the policy recursion you would
-- otherwise get on staff_users itself.
--
-- search_path pins pg_temp LAST. With `set search_path = public`
-- alone, Postgres searches the temp schema first for relations, so
-- any user able to create a temp table could define pg_temp.
-- staff_users, have this function read it, and make themselves
-- staff. That is a real privilege escalation, and it is what the
-- Supabase linter's function_search_path_mutable rule is about.
-- ------------------------------------------------------------

create or replace function is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from staff_users s
    where s.id = auth.uid() and s.is_active
  )
$$;

revoke execute on function is_staff() from public;
grant execute on function is_staff() to anon, authenticated;

-- ------------------------------------------------------------
-- 1. Deny by default: RLS on every table, forced.
--
-- FORCE matters. Without it the table owner bypasses RLS entirely,
-- so any migration, job or admin script connecting as the owner
-- silently runs with no policies applied.
-- ------------------------------------------------------------

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 2. Staff blanket.
--
-- ACCEPTED RISK, chosen deliberately: every active staff member gets
-- full access to every table, regardless of staff_users.role. A
-- warehouse packer's JWT can therefore read cost_price, all customer
-- PII, and store_settings, and can write to any table, by calling
-- PostgREST directly -- whatever the admin UI chooses to show.
--
-- The database draws the staff / non-staff line only. Per-role
-- enforcement is an application concern until this is replaced with
-- a role matrix. Two mitigations are already in place: append-only
-- triggers apply to staff too, and audit_row() records who changed
-- what on the sensitive tables.
-- ------------------------------------------------------------

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
  loop
    execute format(
      'create policy staff_all on public.%I for all
         to authenticated
         using (is_staff()) with check (is_staff())', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 3. Column hiding via definer views.
--
-- RLS hides ROWS, not COLUMNS. product_variants carries cost_price
-- and store_settings carries seller GSTIN and config, so those
-- tables get no public policy at all -- the storefront reads these
-- views, which project only the safe columns.
--
-- security_invoker = false means the view runs as its owner and
-- bypasses the base table's RLS. That is the point, and it is also
-- why the WHERE clause here is load-bearing.
-- ------------------------------------------------------------

-- The join to products is the fix for a real leak. The previous
-- version filtered on the VARIANT's status only, so every variant of
-- every 'draft' and 'archived' PRODUCT -- SKU, title, specs, price --
-- was readable by anon with a single unfiltered select.
create or replace view storefront_variants
with (security_invoker = false) as
  select v.id, v.product_id, v.sku, v.title, v.description, v.specs,
         v.price, v.compare_at_price, v.currency, v.stock,
         v.weight_grams, v.is_default, v.status, v.is_purchasable,
         v.created_at
  from product_variants v
  join products p on p.id = v.product_id
  where v.status = 'active'
    and p.status = 'active';

create or replace view public_settings
with (security_invoker = false) as
  select store_name, support_email, support_phone,
         free_shipping_above, flat_shipping_rate, cod_enabled
  from store_settings;

-- Store credit balance without exposing the ledger's internals.
create or replace view customer_credit_balances
with (security_invoker = true) as
  select customer_id, sum(delta) as balance
  from credit_ledger
  where expires_at is null or expires_at > now()
  group by customer_id;

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

create policy own_profile_r on customers for select
  using (id = (select auth.uid()));
create policy own_profile_i on customers for insert
  with check (id = (select auth.uid()));
-- anonymized_at is set only by anonymize_customer(); a client that
-- could set it would be able to fake its own erasure record.
create policy own_profile_u on customers for update
  using (id = (select auth.uid()) and anonymized_at is null)
  with check (id = (select auth.uid()) and anonymized_at is null);

create policy own_addresses on addresses for all
  using (customer_id = (select auth.uid()))
  with check (customer_id = (select auth.uid()));

create policy own_wishlist on wishlist_items for all
  using (customer_id = (select auth.uid()))
  with check (customer_id = (select auth.uid()));

create policy own_prefs on communication_preferences for all
  using (customer_id = (select auth.uid()))
  with check (customer_id = (select auth.uid()));

-- Logged-in carts. Guest carts (customer_id null + session_id)
-- cannot be safely expressed in RLS -- there is no trustworthy
-- session identity in a JWT-less request -- so keep guest carts
-- client-side until login, or manage them through server routes.
create policy own_carts on carts for all
  using (customer_id = (select auth.uid()))
  with check (customer_id = (select auth.uid()));

create policy own_cart_items on cart_items for all
  using (exists (select 1 from carts c
                 where c.id = cart_id and c.customer_id = (select auth.uid())))
  with check (exists (select 1 from carts c
                      where c.id = cart_id and c.customer_id = (select auth.uid())));

-- ------------------------------------------------------------
-- 6. Orders: customers READ their own; only the server writes.
-- Order creation snapshots prices and moves stock -- that math is
-- never trusted to a browser.
-- ------------------------------------------------------------

create policy own_orders on orders for select
  using (customer_id = (select auth.uid()));

create policy own_order_items on order_items for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = (select auth.uid())));

create policy own_payments on payments for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = (select auth.uid())));

create policy own_shipments on shipments for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = (select auth.uid())));

create policy own_shipment_items on shipment_items for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = (select auth.uid())));

create policy own_order_events on order_events for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = (select auth.uid())));

create policy own_invoices on invoices for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = (select auth.uid())));

create policy own_invoice_lines on invoice_lines for select
  using (exists (select 1 from invoices i
                 join orders o on o.id = i.order_id
                 where i.id = invoice_id and o.customer_id = (select auth.uid())));

create policy own_refunds on refunds for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = (select auth.uid())));

create policy own_redemptions on discount_redemptions for select
  using (customer_id = (select auth.uid()));

-- ------------------------------------------------------------
-- 7. Returns: customers may raise and watch their own.
--
-- status and resolution are pinned. Previously a customer could
-- insert a return already marked 'refunded' with resolution
-- 'refund', which is a state only the warehouse should be able to
-- reach, and which downstream ops tooling reads as authoritative.
--
-- return_items no longer needs an ownership subquery: its composite
-- FK to (order_item_id, order_id) makes attaching another order's
-- line item impossible at the schema level.
-- ------------------------------------------------------------

create policy own_returns_r on return_requests for select
  using (customer_id = (select auth.uid()));

create policy own_returns_i on return_requests for insert
  with check (
    customer_id = (select auth.uid())
    and status = 'requested'
    and resolution is null
    and resolved_at is null
    and exists (select 1 from orders o
                where o.id = order_id and o.customer_id = (select auth.uid()))
  );

create policy own_return_items_r on return_items for select
  using (exists (select 1 from return_requests r
                 where r.id = return_id and r.customer_id = (select auth.uid())));

create policy own_return_items_i on return_items for insert
  with check (
    condition is null          -- assessed at the warehouse, not claimed by the customer
    and exists (select 1 from return_requests r
                where r.id = return_id
                  and r.customer_id = (select auth.uid())
                  and r.status = 'requested')
  );

-- ------------------------------------------------------------
-- 8. Reviews: write your own; edit only while pending.
--
-- status is pinned to 'pending' on INSERT. Without that a customer
-- could self-approve straight onto the product page. is_verified is
-- a generated column so it cannot be set at all, and
-- validate_review_purchase() checks the order item really is theirs.
-- ------------------------------------------------------------

create policy own_reviews_r on reviews for select
  using (customer_id = (select auth.uid()));

create policy own_reviews_i on reviews for insert
  with check (customer_id = (select auth.uid()) and status = 'pending');

create policy own_reviews_u on reviews for update
  using (customer_id = (select auth.uid()) and status = 'pending')
  with check (customer_id = (select auth.uid()) and status = 'pending');

-- ------------------------------------------------------------
-- 9. Wallet, gift cards, alerts, notifications
-- ------------------------------------------------------------

create policy own_credit on credit_ledger for select
  using (customer_id = (select auth.uid()));

-- Customers see the cards THEY bought. Redemption by code is a
-- server-side lookup against code_hash: a table read here would let
-- someone enumerate other people's cards.
create policy own_gift_cards on gift_cards for select
  using (purchaser_id = (select auth.uid()));

create policy own_alerts_r on stock_alerts for select
  using (customer_id = (select auth.uid()));

-- notified_at is pinned null so a client cannot pre-mark its own
-- alert as sent. The unique indexes on stock_alerts cap fan-out to
-- one pending alert per address per variant; rate limiting the
-- anonymous branch is still the application's job.
create policy alerts_insert on stock_alerts for insert
  with check (
    notified_at is null
    and (
      customer_id = (select auth.uid())
      or ((select auth.uid()) is null and customer_id is null and email is not null)
    )
  );

create policy own_notifications_r on notifications for select
  using (recipient_type = 'customer' and recipient_id = (select auth.uid()));

-- Marking as read is the only legitimate customer write. The old
-- policy allowed rewriting title, body, kind and data as well.
create policy own_notifications_u on notifications for update
  using (recipient_type = 'customer' and recipient_id = (select auth.uid()))
  with check (
    recipient_type = 'customer'
    and recipient_id = (select auth.uid())
    and read_at is not null
  );

-- ------------------------------------------------------------
-- 10. Support tickets & enquiries
--
-- priority, status, assignment and the SLA timestamps are pinned.
-- Previously every customer could open tickets at priority
-- 'urgent', pre-set resolved_at, and assign work to a staff member.
-- ------------------------------------------------------------

create policy own_tickets_r on support_tickets for select
  using (customer_id = (select auth.uid()));

create policy own_tickets_i on support_tickets for insert
  with check (
    customer_id = (select auth.uid())
    and status = 'open'
    and priority = 'normal'
    and assigned_to is null
    and first_response_at is null
    and resolved_at is null
    -- Attaching someone else's order to your ticket would put their
    -- order id in front of an agent as if it were yours.
    and (order_id is null
         or exists (select 1 from orders o
                    where o.id = order_id and o.customer_id = (select auth.uid())))
  );

-- Internal notes stay internal: the is_internal = false filter is
-- what keeps staff-only remarks out of customer eyes.
create policy own_ticket_msgs_r on ticket_messages for select
  using (is_internal = false
    and exists (select 1 from support_tickets t
                where t.id = ticket_id and t.customer_id = (select auth.uid())));

create policy own_ticket_msgs_i on ticket_messages for insert
  with check (sender_type = 'customer'
    and sender_id = (select auth.uid())
    and is_internal = false
    and exists (select 1 from support_tickets t
                where t.id = ticket_id and t.customer_id = (select auth.uid())));

create policy own_enquiries_r on product_enquiries for select
  using (customer_id = (select auth.uid()));

create policy enquiries_insert on product_enquiries for insert
  with check (
    status = 'new'
    and assigned_to is null
    and converted_order_id is null
    and (
      customer_id = (select auth.uid())
      or ((select auth.uid()) is null
          and customer_id is null
          and (guest_email is not null or guest_phone is not null))
    )
  );

-- ------------------------------------------------------------
-- 11. Grants
--
-- Supabase's default privileges already grant anon/authenticated on
-- new public tables, so RLS is the real gate. The views are the
-- exception: they need explicit grants, and they must NOT be
-- readable through their base tables.
-- ------------------------------------------------------------

grant select on storefront_variants to anon, authenticated;
grant select on public_settings to anon, authenticated;
grant select on customer_credit_balances to authenticated;

-- ------------------------------------------------------------
-- Deliberately NOT public
-- ------------------------------------------------------------
-- discounts:            a public read lets anyone enumerate live
--                       coupon codes. Validate in a server route and
--                       return only the outcome.
-- product_variants:     staff-only; the storefront reads
--                       storefront_variants, which hides cost_price.
-- store_settings:       staff-only; storefront reads public_settings.
-- gift_card_transactions, credit_ledger writes, inventory_movements,
-- price_history, message_log, audit_logs, blocklist, staff_users,
-- invoice_sequences, idempotency_keys, webhook_events:
--                       staff or server only.
--
-- Every table without a policy above stays locked. That is the point
-- of enabling RLS everywhere: deny by default.

commit;
