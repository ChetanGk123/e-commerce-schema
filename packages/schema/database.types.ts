/**
 * database.types.ts — row types for every table and view in the schema.
 *
 * GENERATED FILE — DO NOT EDIT.
 * Regenerate with `make types`. It introspects a database built from
 * supabase/migrations/, so column names and nullability match exactly.
 *
 * Conventions:
 *   - snake_case is kept: it is what Supabase/PostgREST returns over JSON.
 *   - `numeric` -> number (Supabase JSON). If you query with node-postgres
 *     directly, numeric arrives as a string — adjust there, not here.
 *   - `timestamptz` -> string (ISO 8601 over the wire).
 *   - Enum-ish columns use the union types from ./enums. The schema enforces
 *     them with CHECK constraints rather than Postgres enum types, so this
 *     file is what restores type safety on those columns.
 *   - Columns marked `generated, read-only` are computed by Postgres. Never
 *     send them on insert or update; the database will reject the write.
 */

import type {
  ActorType,
  AuditAction,
  BlocklistKind,
  CartStatus,
  CreditReason,
  DiscountAppliesTo,
  DiscountKind,
  EnquiryStatus,
  GiftCardStatus,
  IdempotencyScope,
  InventoryReason,
  InvoiceKind,
  MessageChannel,
  MessageStatus,
  MessageTemplate,
  NotificationKind,
  OrderEventType,
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  ProductStatus,
  RecipientType,
  RefundStatus,
  RelationKind,
  ReturnReason,
  ReturnResolution,
  ReturnStatus,
  ReviewStatus,
  ShipmentStatus,
  StaffRole,
  TicketCategory,
  TicketChannel,
  TicketPriority,
  TicketStatus,
  VariantStatus,
  WebhookProvider,
} from './enums';

/* ---------- Shared JSON shapes ---------- */

/** Frozen address stored on orders & invoices (a snapshot, not a FK). */
export interface AddressSnapshot {
  name?: string;
  phone?: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  [key: string]: unknown;
}

/** One entry in ticket_messages.attachments. */
export interface Attachment {
  url: string;
  name: string;
  size?: number;
  content_type?: string;
}

/** product_variants.specs — free-form technical attributes. */
export type VariantSpecs = Record<string, string | number | boolean | null>;

/** audit_logs.changes — only the columns that actually changed. */
export interface AuditChanges {
  old?: Record<string, unknown>;
  new?: Record<string, unknown>;
}

/* ---------- Tables ---------- */

export interface Category {
  id: string;  // has default
  parent_id: string | null;
  name: string;
  slug: string;
  position: number;  // has default
  created_at: string;  // has default
  updated_at: string;  // has default
}

export interface Product {
  id: string;  // has default
  category_id: string | null;
  brand: string | null;
  name: string;
  slug: string;
  description: string | null;
  hsn_code: string | null;
  gst_rate: number | null;
  status: ProductStatus;  // has default
  created_at: string;  // has default
  updated_at: string;  // has default
}

export interface ProductOption {
  id: string;  // has default
  product_id: string;
  name: string;
  position: number;  // has default
}

export interface ProductOptionValue {
  id: string;  // has default
  option_id: string;
  product_id: string;
  value: string;
  position: number;  // has default
}

export interface ProductVariant {
  id: string;  // has default
  product_id: string;
  sku: string;
  title: string | null;
  description: string | null;
  specs: VariantSpecs;  // has default
  price: number;
  compare_at_price: number | null;
  cost_price: number | null;
  currency: string;  // has default
  stock: number;  // has default
  low_stock_threshold: number;  // has default
  weight_grams: number | null;
  barcode: string | null;
  is_default: boolean;  // has default
  status: VariantStatus;  // has default
  is_purchasable: boolean | null;  // generated, read-only
  options_signature: string | null;
  created_at: string;  // has default
  updated_at: string;  // has default
}

export interface VariantOptionValue {
  variant_id: string;
  option_value_id: string;
  product_id: string;
}

export interface ProductImage {
  id: string;  // has default
  product_id: string;
  variant_id: string | null;
  url: string;
  alt_text: string | null;
  position: number;  // has default
}

export interface Collection {
  id: string;  // has default
  name: string;
  slug: string;
  description: string | null;
  image_url: string | null;
  is_active: boolean;  // has default
  position: number;  // has default
  created_at: string;  // has default
  updated_at: string;  // has default
}

export interface CollectionProduct {
  collection_id: string;
  product_id: string;
  position: number;  // has default
}

export interface ProductRelation {
  product_id: string;
  related_product_id: string;
  kind: RelationKind;  // has default
  position: number;  // has default
}

export interface Customer {
  id: string;
  email: string | null;
  phone: string | null;
  full_name: string | null;
  anonymized_at: string | null;
  created_at: string;  // has default
  updated_at: string;  // has default
}

export interface Address {
  id: string;  // has default
  customer_id: string;
  label: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;  // has default
  is_default: boolean;  // has default
  created_at: string;  // has default
  updated_at: string;  // has default
}

export interface CommunicationPreference {
  customer_id: string;
  order_updates_email: boolean;  // has default
  order_updates_sms: boolean;  // has default
  order_updates_whatsapp: boolean;  // has default
  marketing_email: boolean;  // has default
  marketing_sms: boolean;  // has default
  marketing_whatsapp: boolean;  // has default
  updated_at: string;  // has default
}

export interface StaffUser {
  id: string;
  email: string;
  full_name: string | null;
  role: StaffRole;  // has default
  is_active: boolean;  // has default
  created_at: string;  // has default
  updated_at: string;  // has default
}

export interface Cart {
  id: string;  // has default
  customer_id: string | null;
  session_id: string | null;
  status: CartStatus;  // has default
  converted_order_id: string | null;
  created_at: string;  // has default
  updated_at: string;  // has default
}

export interface CartItem {
  id: string;  // has default
  cart_id: string;
  variant_id: string;
  quantity: number;
  created_at: string;  // has default
}

export interface Order {
  id: string;  // has default
  order_number: string;  // has default
  customer_id: string | null;
  email: string;
  phone: string | null;
  status: OrderStatus;  // has default
  subtotal: number;
  discount_total: number;  // has default
  shipping_total: number;  // has default
  tax_total: number;  // has default
  grand_total: number;
  currency: string;  // has default
  coupon_code: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  risk_score: number | null;
  risk_flags: string[];  // has default
  shipping_address: AddressSnapshot;
  billing_address: AddressSnapshot | null;
  placed_at: string;  // has default
  updated_at: string;  // has default
}

export interface OrderItem {
  id: string;  // has default
  order_id: string;
  variant_id: string | null;
  product_name: string;
  variant_title: string;
  sku: string;
  unit_price: number;
  quantity: number;
  line_total: number | null;  // generated, read-only
}

export interface Payment {
  id: string;  // has default
  order_id: string;
  provider: PaymentProvider;
  provider_ref: string | null;
  amount: number;
  status: PaymentStatus;  // has default
  created_at: string;  // has default
  updated_at: string;  // has default
  provider_payment_ref: string | null;
}

export interface OrderEvent {
  id: string;  // has default
  order_id: string;
  event: OrderEventType;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  actor_type: ActorType;  // has default
  actor_id: string | null;
  created_at: string;  // has default
}

export interface InventoryMovement {
  id: string;  // has default
  variant_id: string;
  quantity: number;
  reason: InventoryReason;
  order_id: string | null;
  expires_at: string | null;
  reservation_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;  // has default
}

export interface Shipment {
  id: string;  // has default
  order_id: string;
  carrier: string | null;
  service: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  status: ShipmentStatus;  // has default
  shipped_at: string | null;
  delivered_at: string | null;
  created_at: string;  // has default
  updated_at: string;  // has default
}

export interface ShipmentItem {
  shipment_id: string;
  order_item_id: string;
  order_id: string;
  quantity: number;
}

export interface ReturnRequest {
  id: string;  // has default
  order_id: string;
  customer_id: string | null;
  reason: ReturnReason;
  status: ReturnStatus;  // has default
  resolution: ReturnResolution | null;
  note: string | null;
  created_at: string;  // has default
  updated_at: string;  // has default
  resolved_at: string | null;
}

export interface ReturnItem {
  return_id: string;
  order_item_id: string;
  order_id: string;
  quantity: number;
  condition: string | null;
}

export interface Refund {
  id: string;  // has default
  order_id: string;
  payment_id: string | null;
  return_id: string | null;
  amount: number;
  provider_ref: string | null;
  status: RefundStatus;  // has default
  created_at: string;  // has default
  updated_at: string;  // has default
}

export interface Discount {
  id: string;  // has default
  code: string;
  description: string | null;
  kind: DiscountKind;
  value: number;  // has default
  min_order_total: number | null;
  applies_to: DiscountAppliesTo;  // has default
  collection_id: string | null;
  product_id: string | null;
  max_uses: number | null;
  max_uses_per_customer: number | null;  // has default
  used_count: number;  // has default
  starts_at: string;  // has default
  ends_at: string | null;
  is_active: boolean;  // has default
  created_at: string;  // has default
  updated_at: string;  // has default
}

export interface DiscountRedemption {
  id: string;  // has default
  discount_id: string;
  order_id: string;
  customer_id: string | null;
  amount: number;
  created_at: string;  // has default
}

export interface InvoiceSequence {
  fy: string;
  last_number: number;  // has default
}

export interface Invoice {
  id: string;  // has default
  invoice_number: string;
  order_id: string;
  kind: InvoiceKind;  // has default
  parent_invoice_id: string | null;
  customer_name: string;
  customer_gstin: string | null;
  billing_address: AddressSnapshot;
  seller_gstin: string;
  place_of_supply: string;
  taxable_value: number;
  cgst_total: number;  // has default
  sgst_total: number;  // has default
  igst_total: number;  // has default
  grand_total: number;
  pdf_url: string | null;
  irn: string | null;
  ack_no: string | null;
  ack_date: string | null;
  signed_qr: string | null;
  issued_at: string;  // has default
}

export interface InvoiceLine {
  id: string;  // has default
  invoice_id: string;
  description: string;
  hsn_code: string | null;
  quantity: number;
  unit_price: number;
  taxable_value: number;
  gst_rate: number;
  cgst_amount: number;  // has default
  sgst_amount: number;  // has default
  igst_amount: number;  // has default
  line_total: number;
}

export interface GiftCard {
  id: string;  // has default
  code_hash: string;
  last4: string;
  initial_balance: number;
  balance: number;
  currency: string;  // has default
  purchaser_id: string | null;
  purchase_order_id: string | null;
  recipient_email: string | null;
  message: string | null;
  status: GiftCardStatus;  // has default
  expires_at: string | null;
  created_at: string;  // has default
  updated_at: string;  // has default
}

export interface GiftCardTransaction {
  id: string;  // has default
  gift_card_id: string;
  order_id: string | null;
  delta: number;
  balance_after: number;
  created_at: string;  // has default
}

export interface CreditLedgerEntry {
  id: string;  // has default
  customer_id: string;
  delta: number;
  reason: CreditReason;
  order_id: string | null;
  return_id: string | null;
  gift_card_id: string | null;
  expires_at: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;  // has default
}

export interface ShippingZone {
  id: string;  // has default
  name: string;
  position: number;  // has default
}

export interface ServiceablePincode {
  pincode: string;
  zone_id: string | null;
  cod_allowed: boolean;  // has default
  courier: string | null;
  updated_at: string;  // has default
}

export interface ShippingRate {
  id: string;  // has default
  zone_id: string;
  min_weight_grams: number;  // has default
  max_weight_grams: number | null;
  min_order_total: number;  // has default
  max_order_total: number | null;
  rate: number;
  cod_surcharge: number;  // has default
  delivery_days: number | null;
  is_active: boolean;  // has default
}

export interface BlocklistEntry {
  id: string;  // has default
  kind: BlocklistKind;
  value: string;
  reason: string | null;
  added_by: string | null;
  expires_at: string | null;
  created_at: string;  // has default
}

export interface Review {
  id: string;  // has default
  product_id: string;
  variant_id: string | null;
  customer_id: string;
  order_item_id: string | null;
  rating: number;
  title: string | null;
  body: string | null;
  is_verified: boolean | null;  // generated, read-only
  status: ReviewStatus;  // has default
  created_at: string;  // has default
  updated_at: string;  // has default
}

export interface WishlistItem {
  customer_id: string;
  variant_id: string;
  created_at: string;  // has default
}

export interface StockAlert {
  id: string;  // has default
  variant_id: string;
  customer_id: string | null;
  email: string | null;
  notified_at: string | null;
  created_at: string;  // has default
}

export interface PriceHistoryEntry {
  id: string;  // has default
  variant_id: string;
  old_price: number | null;
  new_price: number;
  changed_by: string | null;
  created_at: string;  // has default
}

export interface Notification {
  id: string;  // has default
  recipient_type: RecipientType;
  recipient_id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  data: Record<string, unknown>;  // has default
  read_at: string | null;
  created_at: string;  // has default
}

export interface MessageLogEntry {
  id: string;  // has default
  customer_id: string | null;
  order_id: string | null;
  channel: MessageChannel;
  template: MessageTemplate;
  recipient: string;
  payload: Record<string, unknown> | null;
  status: MessageStatus;  // has default
  provider: string | null;
  provider_ref: string | null;
  error: string | null;
  attempts: number;  // has default
  created_at: string;  // has default
  sent_at: string | null;
  claimed_at: string | null;
}

export interface MessageTemplateRow {
  key: MessageTemplate;
  subject: string;
  body: string;
  description: string | null;
  updated_at: string;  // has default
}

export interface SupportTicket {
  id: string;  // has default
  ticket_number: string;  // has default
  customer_id: string | null;
  order_id: string | null;
  channel: TicketChannel;  // has default
  category: TicketCategory;  // has default
  subject: string;
  status: TicketStatus;  // has default
  priority: TicketPriority;  // has default
  assigned_to: string | null;
  guest_name: string | null;
  guest_email: string | null;
  guest_phone: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  created_at: string;  // has default
  updated_at: string;  // has default
}

export interface TicketMessage {
  id: string;  // has default
  ticket_id: string;
  sender_type: ActorType;
  sender_id: string | null;
  body: string;
  is_internal: boolean;  // has default
  attachments: Attachment[];  // has default
  created_at: string;  // has default
}

export interface ProductEnquiry {
  id: string;  // has default
  product_id: string | null;
  variant_id: string | null;
  customer_id: string | null;
  guest_name: string | null;
  guest_email: string | null;
  guest_phone: string | null;
  quantity: number | null;
  message: string;
  status: EnquiryStatus;  // has default
  assigned_to: string | null;
  converted_order_id: string | null;
  created_at: string;  // has default
  updated_at: string;  // has default
}

export interface AuditLog {
  id: string;  // has default
  staff_id: string | null;
  actor_uid: string | null;
  action: AuditAction;
  table_name: string;
  record_id: string | null;
  changes: AuditChanges | null;
  created_at: string;  // has default
}

export interface StoreSettings {
  id: number;  // has default
  store_name: string;  // has default
  support_email: string | null;
  support_phone: string | null;
  seller_gstin: string | null;
  seller_state_code: string | null;
  free_shipping_above: number | null;
  flat_shipping_rate: number | null;  // has default
  cod_enabled: boolean;  // has default
  config: Record<string, unknown>;  // has default
  updated_at: string;  // has default
}

export interface IdempotencyKey {
  key: string;
  scope: IdempotencyScope;
  request_hash: string;
  customer_id: string | null;
  response_status: number | null;
  response_body: Record<string, unknown> | null;
  locked_at: string | null;
  completed_at: string | null;
  created_at: string;  // has default
  expires_at: string;  // has default
}

export interface WebhookEvent {
  id: string;  // has default
  provider: WebhookProvider;
  event_id: string;
  event_type: string | null;
  payload: Record<string, unknown>;
  signature_verified: boolean;  // has default
  received_at: string;  // has default
  processed_at: string | null;
  attempts: number;  // has default
  error: string | null;
}

export interface AuthAttempt {
  email: string;
  failures: number;  // has default
  last_at: string;  // has default
  locked_until: string | null;
}

export interface JobRun {
  job: string;
  last_run_at: string;  // has default
}

export interface StorageGcQueueEntry {
  id: string;  // has default
  url: string;
  queued_at: string;  // has default
  attempts: number;  // has default
  last_error: string | null;
}

export interface StorageOrphanSighting {
  path: string;
  first_seen_at: string;  // has default
  last_seen_at: string;  // has default
}

/* ---------- Views ---------- */

export interface StorefrontVariant {
  id: string | null;
  product_id: string | null;
  sku: string | null;
  title: string | null;
  description: string | null;
  specs: VariantSpecs | null;
  price: number | null;
  compare_at_price: number | null;
  currency: string | null;
  stock: number | null;
  weight_grams: number | null;
  is_default: boolean | null;
  status: VariantStatus | null;
  is_purchasable: boolean | null;
  created_at: string | null;
}

export interface PublicSettings {
  store_name: string | null;
  support_email: string | null;
  support_phone: string | null;
  free_shipping_above: number | null;
  flat_shipping_rate: number | null;
  cod_enabled: boolean | null;
}

export interface CustomerCreditBalance {
  customer_id: string | null;
  balance: number | null;
}

export interface AdminSalesDaily {
  day: string | null;
  orders: number | null;
  revenue: number | null;
  discounts: number | null;
  average_order_value: number | null;
}

export interface AdminLowStock {
  variant_id: string | null;
  product_id: string | null;
  product_name: string | null;
  sku: string | null;
  title: string | null;
  stock: number | null;
  low_stock_threshold: number | null;
}

/* ---------- Name -> row type, for generic helpers ---------- */

export interface Tables {
  categories: Category;
  products: Product;
  product_options: ProductOption;
  product_option_values: ProductOptionValue;
  product_variants: ProductVariant;
  variant_option_values: VariantOptionValue;
  product_images: ProductImage;
  collections: Collection;
  collection_products: CollectionProduct;
  product_relations: ProductRelation;
  customers: Customer;
  addresses: Address;
  communication_preferences: CommunicationPreference;
  staff_users: StaffUser;
  carts: Cart;
  cart_items: CartItem;
  orders: Order;
  order_items: OrderItem;
  payments: Payment;
  order_events: OrderEvent;
  inventory_movements: InventoryMovement;
  shipments: Shipment;
  shipment_items: ShipmentItem;
  return_requests: ReturnRequest;
  return_items: ReturnItem;
  refunds: Refund;
  discounts: Discount;
  discount_redemptions: DiscountRedemption;
  invoice_sequences: InvoiceSequence;
  invoices: Invoice;
  invoice_lines: InvoiceLine;
  gift_cards: GiftCard;
  gift_card_transactions: GiftCardTransaction;
  credit_ledger: CreditLedgerEntry;
  shipping_zones: ShippingZone;
  serviceable_pincodes: ServiceablePincode;
  shipping_rates: ShippingRate;
  blocklist: BlocklistEntry;
  reviews: Review;
  wishlist_items: WishlistItem;
  stock_alerts: StockAlert;
  price_history: PriceHistoryEntry;
  notifications: Notification;
  message_log: MessageLogEntry;
  message_templates: MessageTemplateRow;
  support_tickets: SupportTicket;
  ticket_messages: TicketMessage;
  product_enquiries: ProductEnquiry;
  audit_logs: AuditLog;
  store_settings: StoreSettings;
  idempotency_keys: IdempotencyKey;
  webhook_events: WebhookEvent;
  auth_attempts: AuthAttempt;
  job_runs: JobRun;
  storage_gc_queue: StorageGcQueueEntry;
  storage_orphan_sightings: StorageOrphanSighting;
  storefront_variants: StorefrontVariant;
  public_settings: PublicSettings;
  customer_credit_balances: CustomerCreditBalance;
  admin_sales_daily: AdminSalesDaily;
  admin_low_stock: AdminLowStock;
}

export type TableName = keyof Tables;
export type Row<T extends TableName> = Tables[T];
