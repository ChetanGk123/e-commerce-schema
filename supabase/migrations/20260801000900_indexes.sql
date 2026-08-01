-- ============================================================
-- 0009  Indexes
--
-- Postgres does NOT index foreign keys automatically. Of the 78 FK
-- columns in the original schema, 47 had no index. That costs twice:
-- joins scan, and every ON DELETE SET NULL / CASCADE has to scan the
-- child table to find the rows it must touch.
--
-- Unique indexes that enforce a business rule live next to their
-- table (uniq_default_variant, uniq_payment_provider_ref, and so on).
-- This migration is purely about access paths.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Catalog
-- ------------------------------------------------------------

create index idx_categories_parent on categories(parent_id);

-- The primary storefront listing query. Had no index at all.
create index idx_products_category on products(category_id);

-- RLS forces `status = 'active'` onto EVERY storefront product read,
-- so the predicate belongs in the index rather than being re-checked
-- per row.
create index idx_products_active on products(category_id, created_at desc)
  where status = 'active';

create index idx_variants_product on product_variants(product_id);
create index idx_variants_purchasable on product_variants(product_id)
  where is_purchasable;
create index idx_variants_low_stock on product_variants(stock)
  where status = 'active' and stock <= low_stock_threshold;
create index idx_variants_barcode on product_variants(barcode)
  where barcode is not null;

create index idx_option_values_product on product_option_values(product_id);
create index idx_vov_option_value on variant_option_values(option_value_id);
create index idx_images_product on product_images(product_id, position);
create index idx_images_variant on product_images(variant_id)
  where variant_id is not null;

create index idx_collection_products_product on collection_products(product_id);
create index idx_product_relations_related on product_relations(related_product_id);

-- Fuzzy search. Turns "iphone chrger" into "iPhone charger" with a
-- plain `where name % $1`, no external search infrastructure.
create index idx_products_name_trgm on products using gin (name gin_trgm_ops);
create index idx_products_brand_trgm on products using gin (brand gin_trgm_ops);
create index idx_variants_sku_trgm on product_variants using gin (sku gin_trgm_ops);

-- ------------------------------------------------------------
-- Identity
-- ------------------------------------------------------------

create index idx_addresses_customer on addresses(customer_id);
create index idx_customers_created on customers(created_at desc);

-- ------------------------------------------------------------
-- Orders
-- ------------------------------------------------------------

create index idx_orders_customer on orders(customer_id, placed_at desc);

-- Every admin queue and every date-range report. Both were seq scans.
create index idx_orders_placed on orders(placed_at desc);
create index idx_orders_open on orders(status, placed_at desc)
  where status in ('pending', 'paid', 'packed', 'shipped');
create index idx_orders_updated on orders(updated_at desc);
create index idx_orders_email on orders(email);

create index idx_order_items_order on order_items(order_id);
-- Needed by ON DELETE SET NULL when a variant is archived, and by
-- "units sold per variant" reporting.
create index idx_order_items_variant on order_items(variant_id);

-- The order detail page joins payments on every load.
create index idx_payments_order on payments(order_id);
create index idx_payments_pending on payments(created_at)
  where status in ('created', 'authorized');

create index idx_order_events_order on order_events(order_id, created_at);

-- ------------------------------------------------------------
-- Cart
-- ------------------------------------------------------------

create index idx_carts_session on carts(session_id) where session_id is not null;
create index idx_carts_customer on carts(customer_id) where customer_id is not null;
-- Drives abandoned-cart recovery and the retention sweep.
create index idx_carts_abandoned on carts(updated_at)
  where status = 'active';
create index idx_cart_items_variant on cart_items(variant_id);

-- ------------------------------------------------------------
-- Inventory & fulfilment
-- ------------------------------------------------------------

create index idx_inventory_variant on inventory_movements(variant_id, created_at desc);
create index idx_inventory_order on inventory_movements(order_id)
  where order_id is not null;
create index idx_inventory_created_by on inventory_movements(created_by);
-- The reservation sweeper: find holds that expired without a release.
create index idx_inventory_expiring on inventory_movements(expires_at)
  where reason = 'reservation' and expires_at is not null;

create index idx_shipments_order on shipments(order_id);
create index idx_shipments_active on shipments(status, created_at desc)
  where status not in ('delivered', 'lost');
create index idx_shipment_items_order_item on shipment_items(order_item_id);

-- ------------------------------------------------------------
-- Returns, refunds, discounts
-- ------------------------------------------------------------

create index idx_returns_order on return_requests(order_id);
create index idx_returns_customer on return_requests(customer_id);
create index idx_returns_open on return_requests(status, created_at)
  where status in ('requested', 'approved', 'pickup_scheduled', 'received');
create index idx_return_items_order_item on return_items(order_item_id);

create index idx_refunds_order on refunds(order_id);
create index idx_refunds_payment on refunds(payment_id);
create index idx_refunds_return on refunds(return_id);

create index idx_discounts_collection on discounts(collection_id);
create index idx_discounts_product on discounts(product_id);
create index idx_discounts_live on discounts(code)
  where is_active;

create index idx_redemptions_order on discount_redemptions(order_id);
-- Checked on every checkout that carries a coupon, to enforce
-- max_uses_per_customer.
create index idx_redemptions_customer on discount_redemptions(discount_id, customer_id);

-- ------------------------------------------------------------
-- Invoicing
-- ------------------------------------------------------------

create index idx_invoices_order on invoices(order_id);
create index idx_invoices_parent on invoices(parent_invoice_id);
create index idx_invoices_issued on invoices(issued_at desc);
-- The e-invoice worker's queue.
create index idx_invoices_unsigned on invoices(issued_at)
  where irn is null and kind = 'tax_invoice';
create index idx_invoice_lines_invoice on invoice_lines(invoice_id);

-- ------------------------------------------------------------
-- Wallet
-- ------------------------------------------------------------

-- balance = sum(delta) per card was a full table scan without this.
create index idx_gift_card_txn_card on gift_card_transactions(gift_card_id, created_at desc);
create index idx_gift_card_txn_order on gift_card_transactions(order_id);
-- Backs the own_gift_cards RLS policy.
create index idx_gift_cards_purchaser on gift_cards(purchaser_id);
create index idx_gift_cards_purchase_order on gift_cards(purchase_order_id);
create index idx_gift_cards_expiring on gift_cards(expires_at)
  where status = 'active' and expires_at is not null;

create index idx_credit_customer on credit_ledger(customer_id, created_at desc);
create index idx_credit_order on credit_ledger(order_id);
create index idx_credit_return on credit_ledger(return_id);
create index idx_credit_gift_card on credit_ledger(gift_card_id);
create index idx_credit_expiring on credit_ledger(expires_at)
  where expires_at is not null;

-- ------------------------------------------------------------
-- Shipping & risk
-- ------------------------------------------------------------

create index idx_pincodes_zone on serviceable_pincodes(zone_id);
create index idx_rates_zone on shipping_rates(zone_id) where is_active;
create index idx_blocklist_lookup on blocklist(kind, value);

-- ------------------------------------------------------------
-- Engagement
-- ------------------------------------------------------------

create index idx_reviews_product on reviews(product_id, created_at desc)
  where status = 'approved';
create index idx_reviews_moderation on reviews(created_at)
  where status = 'pending';
create index idx_reviews_variant on reviews(variant_id);
create index idx_reviews_order_item on reviews(order_item_id);

-- The price-drop join the README advertises. wishlist_items' PK
-- leads with customer_id, so going the other way (variant -> who
-- wants it) had no index at all.
create index idx_wishlist_variant on wishlist_items(variant_id);

create index idx_stock_alerts_pending on stock_alerts(variant_id)
  where notified_at is null;
create index idx_stock_alerts_customer on stock_alerts(customer_id);

create index idx_price_history_variant on price_history(variant_id, created_at desc);
create index idx_price_history_changed_by on price_history(changed_by);

-- ------------------------------------------------------------
-- Messaging
-- ------------------------------------------------------------

create index idx_notifications_unread
  on notifications(recipient_type, recipient_id, created_at desc)
  where read_at is null;
create index idx_notifications_all
  on notifications(recipient_type, recipient_id, created_at desc);

-- The outbox drain.
create index idx_message_log_queued on message_log(created_at) where status = 'queued';
create index idx_message_log_order on message_log(order_id);
create index idx_message_log_customer on message_log(customer_id, created_at desc);

-- ------------------------------------------------------------
-- Support
-- ------------------------------------------------------------

create index idx_tickets_queue on support_tickets(priority, created_at)
  where status in ('open', 'pending_internal');
create index idx_tickets_customer on support_tickets(customer_id);
create index idx_tickets_order on support_tickets(order_id);
-- "My assigned tickets" is the first screen every agent opens.
create index idx_tickets_assigned on support_tickets(assigned_to, status)
  where assigned_to is not null;
create index idx_ticket_messages_thread on ticket_messages(ticket_id, created_at);

create index idx_enquiries_open on product_enquiries(status, created_at)
  where status in ('new', 'replied', 'quoted');
create index idx_enquiries_product on product_enquiries(product_id);
create index idx_enquiries_variant on product_enquiries(variant_id);
create index idx_enquiries_customer on product_enquiries(customer_id);
create index idx_enquiries_assigned on product_enquiries(assigned_to);
create index idx_enquiries_converted on product_enquiries(converted_order_id);

-- ------------------------------------------------------------
-- Audit & platform
-- ------------------------------------------------------------

create index idx_audit_record on audit_logs(table_name, record_id, created_at desc);
create index idx_audit_staff on audit_logs(staff_id, created_at desc);
create index idx_audit_created on audit_logs(created_at desc);

create index idx_idempotency_expiry on idempotency_keys(expires_at);
create index idx_idempotency_customer on idempotency_keys(customer_id);

-- The webhook retry queue.
create index idx_webhook_unprocessed on webhook_events(provider, received_at)
  where processed_at is null;

commit;
