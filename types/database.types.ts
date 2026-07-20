/**
 * database.types.ts — row types for every table in ecommerce-schema-full.sql.
 * Generated from the DDL, so column names and nullability match exactly.
 *
 * Conventions:
 *   - snake_case is kept: it is what Supabase/PostgREST returns over JSON.
 *   - `numeric` -> number (Supabase JSON). If you query with node-postgres
 *     directly, numeric arrives as a string -- adjust there, not here.
 *   - `timestamptz` -> string (ISO 8601 over the wire).
 *   - Enum-ish columns use the union types from ./enums. Note that
 *     `supabase gen types` would type them as plain `string`, because the
 *     schema enforces them with CHECK constraints, not Postgres enum types --
 *     this file is what restores type safety on those columns.
 */

import type {
  ProductStatus, VariantStatus, RelationKind, OrderStatus, PaymentStatus,
  PaymentProvider, DiscountKind, DiscountAppliesTo, RefundStatus, InvoiceKind,
  InventoryReason, ShipmentStatus, ReturnStatus, ReturnResolution, ReturnReason,
  GiftCardStatus, CreditReason, StaffRole, ActorType, OrderEventType,
  RecipientType, NotificationKind, ReviewStatus, BlocklistKind, MessageChannel,
  MessageStatus, MessageTemplate, TicketChannel, TicketCategory, TicketStatus,
  TicketPriority, EnquiryStatus, AuditAction,
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

/** File attached to a ticket message. */
export interface Attachment {
  url: string;
  name?: string;
  [key: string]: unknown;
}

/** Structured per-variant details, e.g. { chip: "M3", ram_gb: 16 }. */
export type VariantSpecs = Record<string, string | number | boolean | null>;

/** audit_logs.changes, e.g. { price: { old: 999, new: 899 } }. */
export type AuditChanges = Record<string, { old: unknown; new: unknown }>;

/* ---------- Table row types (in schema order) ---------- */

/** Row of `categories` */
export interface Category {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  position: number;
}

/** Row of `products` */
export interface Product {
  id: string;
  category_id: string | null;
  brand: string | null;
  name: string;
  slug: string;
  description: string | null;
  hsn_code: string | null;
  gst_rate: number | null;
  status: ProductStatus;
  created_at: string;
  updated_at: string;
}

/** Row of `product_options` */
export interface ProductOption {
  id: string;
  product_id: string;
  name: string;
  position: number;
}

/** Row of `product_option_values` */
export interface ProductOptionValue {
  id: string;
  option_id: string;
  value: string;
  position: number;
}

/** Row of `product_variants` */
export interface ProductVariant {
  id: string;
  product_id: string;
  sku: string;
  title: string | null;
  description: string | null;
  specs: VariantSpecs;
  price: number;
  compare_at_price: number | null;
  cost_price: number | null;
  currency: string;
  stock: number;
  weight_grams: number | null;
  barcode: string | null;
  is_default: boolean;
  status: VariantStatus;
  options_signature: string | null;
  created_at: string;
  updated_at: string;
}

/** Row of `variant_option_values` */
export interface VariantOptionValue {
  variant_id: string;
  option_value_id: string;
}

/** Row of `product_images` */
export interface ProductImage {
  id: string;
  product_id: string;
  variant_id: string | null;
  url: string;
  alt_text: string | null;
  position: number;
}

/** Row of `customers` */
export interface Customer {
  id: string;
  email: string | null;
  phone: string | null;
  full_name: string | null;
  created_at: string;
}

/** Row of `addresses` */
export interface Address {
  id: string;
  customer_id: string;
  label: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  is_default: boolean;
}

/** Row of `carts` */
export interface Cart {
  id: string;
  customer_id: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Row of `cart_items` */
export interface CartItem {
  id: string;
  cart_id: string;
  variant_id: string;
  quantity: number;
}

/** Row of `orders` */
export interface Order {
  id: string;
  order_number: string;
  customer_id: string | null;
  status: OrderStatus;
  subtotal: number;
  discount_total: number;
  shipping_total: number;
  tax_total: number;
  grand_total: number;
  currency: string;
  coupon_code: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  risk_score: number | null;
  risk_flags: string[];
  shipping_address: AddressSnapshot;
  placed_at: string;
}

/** Row of `order_items` */
export interface OrderItem {
  id: string;
  order_id: string;
  variant_id: string | null;
  product_name: string;
  variant_title: string;
  sku: string;
  unit_price: number;
  quantity: number;
  line_total: number;
}

/** Row of `payments` */
export interface Payment {
  id: string;
  order_id: string;
  provider: PaymentProvider;
  provider_ref: string | null;
  amount: number;
  status: PaymentStatus;
  created_at: string;
}

/** Row of `staff_users` */
export interface StaffUser {
  id: string;
  email: string;
  full_name: string | null;
  role: StaffRole;
  is_active: boolean;
  created_at: string;
}

/** Row of `audit_logs` */
export interface AuditLog {
  id: string;
  staff_id: string | null;
  action: AuditAction;
  table_name: string;
  record_id: string | null;
  changes: AuditChanges | null;
  created_at: string;
}

/** Row of `collections` */
export interface Collection {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  image_url: string | null;
  is_active: boolean;
  position: number;
}

/** Row of `collection_products` */
export interface CollectionProduct {
  collection_id: string;
  product_id: string;
  position: number;
}

/** Row of `discounts` */
export interface Discount {
  id: string;
  code: string;
  description: string | null;
  kind: DiscountKind;
  value: number;
  min_order_total: number | null;
  applies_to: DiscountAppliesTo;
  collection_id: string | null;
  product_id: string | null;
  max_uses: number | null;
  max_uses_per_customer: number | null;
  starts_at: string;
  ends_at: string | null;
  is_active: boolean;
  created_at: string;
}

/** Row of `discount_redemptions` */
export interface DiscountRedemption {
  id: string;
  discount_id: string;
  order_id: string;
  customer_id: string | null;
  amount: number;
  created_at: string;
}

/** Row of `inventory_movements` */
export interface InventoryMovement {
  id: string;
  variant_id: string;
  quantity: number;
  reason: InventoryReason;
  order_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

/** Row of `shipments` */
export interface Shipment {
  id: string;
  order_id: string;
  carrier: string | null;
  service: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  status: ShipmentStatus;
  shipped_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

/** Row of `shipment_items` */
export interface ShipmentItem {
  shipment_id: string;
  order_item_id: string;
  quantity: number;
}

/** Row of `return_requests` */
export interface ReturnRequest {
  id: string;
  order_id: string;
  customer_id: string | null;
  reason: ReturnReason;
  status: ReturnStatus;
  resolution: ReturnResolution | null;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
}

/** Row of `return_items` */
export interface ReturnItem {
  return_id: string;
  order_item_id: string;
  quantity: number;
  condition: string | null;
}

/** Row of `refunds` */
export interface Refund {
  id: string;
  order_id: string;
  payment_id: string | null;
  return_id: string | null;
  amount: number;
  provider_ref: string | null;
  status: RefundStatus;
  created_at: string;
}

/** Row of `reviews` */
export interface Review {
  id: string;
  product_id: string;
  variant_id: string | null;
  customer_id: string;
  order_item_id: string | null;
  rating: number;
  title: string | null;
  body: string | null;
  is_verified: boolean;
  status: ReviewStatus;
  created_at: string;
}

/** Row of `wishlist_items` */
export interface WishlistItem {
  customer_id: string;
  variant_id: string;
  created_at: string;
}

/** Row of `stock_alerts` */
export interface StockAlert {
  id: string;
  variant_id: string;
  customer_id: string | null;
  email: string | null;
  notified_at: string | null;
  created_at: string;
}

/** Row of `order_events` */
export interface OrderEvent {
  id: string;
  order_id: string;
  event: OrderEventType;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  actor_type: ActorType;
  actor_id: string | null;
  created_at: string;
}

/** Row of `notifications` */
export interface Notification {
  id: string;
  recipient_type: RecipientType;
  recipient_id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

/** Row of `message_log` */
export interface MessageLog {
  id: string;
  customer_id: string | null;
  order_id: string | null;
  channel: MessageChannel;
  template: MessageTemplate;
  recipient: string;
  payload: Record<string, unknown> | null;
  status: MessageStatus;
  provider: string | null;
  provider_ref: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
}

/** Row of `communication_preferences` */
export interface CommunicationPreferences {
  customer_id: string;
  order_updates_email: boolean;
  order_updates_sms: boolean;
  order_updates_whatsapp: boolean;
  marketing_email: boolean;
  marketing_sms: boolean;
  marketing_whatsapp: boolean;
  updated_at: string;
}

/** Row of `support_tickets` */
export interface SupportTicket {
  id: string;
  ticket_number: string;
  customer_id: string | null;
  order_id: string | null;
  channel: TicketChannel;
  category: TicketCategory;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  assigned_to: string | null;
  guest_name: string | null;
  guest_email: string | null;
  guest_phone: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Row of `ticket_messages` */
export interface TicketMessage {
  id: string;
  ticket_id: string;
  sender_type: ActorType;
  sender_id: string | null;
  body: string;
  is_internal: boolean;
  attachments: Attachment[];
  created_at: string;
}

/** Row of `product_enquiries` */
export interface ProductEnquiry {
  id: string;
  product_id: string | null;
  variant_id: string | null;
  customer_id: string | null;
  guest_name: string | null;
  guest_email: string | null;
  guest_phone: string | null;
  quantity: number | null;
  message: string;
  status: EnquiryStatus;
  assigned_to: string | null;
  converted_order_id: string | null;
  created_at: string;
}

/** Row of `invoice_sequences` */
export interface InvoiceSequence {
  fy: string;
  last_number: number;
}

/** Row of `invoices` */
export interface Invoice {
  id: string;
  invoice_number: string;
  order_id: string;
  kind: InvoiceKind;
  parent_invoice_id: string | null;
  customer_name: string;
  customer_gstin: string | null;
  billing_address: AddressSnapshot;
  seller_gstin: string;
  place_of_supply: string;
  taxable_value: number;
  cgst_total: number;
  sgst_total: number;
  igst_total: number;
  grand_total: number;
  pdf_url: string | null;
  issued_at: string;
}

/** Row of `invoice_lines` */
export interface InvoiceLine {
  id: string;
  invoice_id: string;
  description: string;
  hsn_code: string | null;
  quantity: number;
  unit_price: number;
  taxable_value: number;
  gst_rate: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  line_total: number;
}

/** Row of `gift_cards` */
export interface GiftCard {
  id: string;
  code: string;
  initial_balance: number;
  balance: number;
  currency: string;
  purchaser_id: string | null;
  purchase_order_id: string | null;
  recipient_email: string | null;
  message: string | null;
  status: GiftCardStatus;
  expires_at: string | null;
  created_at: string;
}

/** Row of `gift_card_transactions` */
export interface GiftCardTransaction {
  id: string;
  gift_card_id: string;
  order_id: string | null;
  delta: number;
  balance_after: number;
  created_at: string;
}

/** Row of `credit_ledger` */
export interface CreditLedgerEntry {
  id: string;
  customer_id: string;
  delta: number;
  reason: CreditReason;
  order_id: string | null;
  return_id: string | null;
  gift_card_id: string | null;
  expires_at: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

/** Row of `shipping_zones` */
export interface ShippingZone {
  id: string;
  name: string;
  position: number;
}

/** Row of `serviceable_pincodes` */
export interface ServiceablePincode {
  pincode: string;
  zone_id: string | null;
  cod_allowed: boolean;
  courier: string | null;
  updated_at: string;
}

/** Row of `shipping_rates` */
export interface ShippingRate {
  id: string;
  zone_id: string;
  min_weight_grams: number;
  max_weight_grams: number | null;
  min_order_total: number;
  rate: number;
  cod_surcharge: number;
  delivery_days: number | null;
  is_active: boolean;
}

/** Row of `blocklist` */
export interface BlocklistEntry {
  id: string;
  kind: BlocklistKind;
  value: string;
  reason: string | null;
  added_by: string | null;
  expires_at: string | null;
  created_at: string;
}

/** Row of `product_relations` */
export interface ProductRelation {
  product_id: string;
  related_product_id: string;
  kind: RelationKind;
  position: number;
}

/** Row of `price_history` */
export interface PriceHistoryEntry {
  id: string;
  variant_id: string;
  old_price: number | null;
  new_price: number;
  changed_by: string | null;
  created_at: string;
}

/** Row of `store_settings` */
export interface StoreSettings {
  id: number;
  store_name: string;
  support_email: string | null;
  support_phone: string | null;
  free_shipping_above: number | null;
  flat_shipping_rate: number | null;
  cod_enabled: boolean;
  config: Record<string, unknown>;
  updated_at: string;
}

/* ---------- Table registry (for generic helpers) ---------- */

export interface Tables {
  categories: Category;
  products: Product;
  product_options: ProductOption;
  product_option_values: ProductOptionValue;
  product_variants: ProductVariant;
  variant_option_values: VariantOptionValue;
  product_images: ProductImage;
  customers: Customer;
  addresses: Address;
  carts: Cart;
  cart_items: CartItem;
  orders: Order;
  order_items: OrderItem;
  payments: Payment;
  staff_users: StaffUser;
  audit_logs: AuditLog;
  collections: Collection;
  collection_products: CollectionProduct;
  discounts: Discount;
  discount_redemptions: DiscountRedemption;
  inventory_movements: InventoryMovement;
  shipments: Shipment;
  shipment_items: ShipmentItem;
  return_requests: ReturnRequest;
  return_items: ReturnItem;
  refunds: Refund;
  reviews: Review;
  wishlist_items: WishlistItem;
  stock_alerts: StockAlert;
  order_events: OrderEvent;
  notifications: Notification;
  message_log: MessageLog;
  communication_preferences: CommunicationPreferences;
  support_tickets: SupportTicket;
  ticket_messages: TicketMessage;
  product_enquiries: ProductEnquiry;
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
  product_relations: ProductRelation;
  price_history: PriceHistoryEntry;
  store_settings: StoreSettings;
}

export type TableName = keyof Tables;

/* ---------- Common composed shapes (typical joined queries) ---------- */

export interface ProductOptionWithValues extends ProductOption {
  values: ProductOptionValue[];
}

export interface VariantWithOptionValues extends ProductVariant {
  option_value_ids: string[];
}

/** Everything a product page needs. */
export interface ProductWithDetails extends Product {
  options: ProductOptionWithValues[];
  variants: VariantWithOptionValues[];
  images: ProductImage[];
}

export interface CartItemWithVariant extends CartItem {
  variant: ProductVariant & { product: Pick<Product, 'name' | 'slug'> };
}

/** Everything the order detail / tracking page needs. */
export interface OrderWithDetails extends Order {
  items: OrderItem[];
  payments: Payment[];
  shipments: Shipment[];
  events: OrderEvent[];
}

export interface TicketWithMessages extends SupportTicket {
  messages: TicketMessage[];
}