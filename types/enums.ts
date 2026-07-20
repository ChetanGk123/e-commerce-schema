/**
 * enums.ts — every enum in ecommerce-schema-full.sql, ready for the frontend.
 *
 * Pattern: `as const` arrays + derived literal-union types.
 *   - Iterate the arrays to render <select> options, filter chips, and tabs.
 *   - Use the types on props, state, and API payloads for compile-time safety.
 *
 * Section 1 mirrors the database CHECK constraints exactly (28 columns) —
 * if a value changes here, it must change in the schema too, and vice versa.
 * Section 2 covers free-text columns with conventional values: the database
 * does not enforce these, so their types also accept any other string.
 * Section 3 has display labels for the user-facing lifecycles.
 */

/* ======================================================================
 * 1. Database-enforced enums (CHECK constraints)
 * ====================================================================*/

/* ---------- Catalog ---------- */

/** products.status */
export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/** product_variants.status */
export const VARIANT_STATUSES = ['active', 'out_of_stock', 'archived'] as const;
export type VariantStatus = (typeof VARIANT_STATUSES)[number];

/** product_relations.kind */
export const RELATION_KINDS = ['related', 'upsell', 'cross_sell', 'accessory'] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

/* ---------- Orders, payments & money ---------- */

/** orders.status */
export const ORDER_STATUSES = [
  'pending',
  'paid',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** payments.status */
export const PAYMENT_STATUSES = ['created', 'authorized', 'captured', 'failed', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** discounts.kind */
export const DISCOUNT_KINDS = ['percent', 'fixed', 'free_shipping'] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];

/** discounts.applies_to */
export const DISCOUNT_APPLIES_TO = ['order', 'collection', 'product'] as const;
export type DiscountAppliesTo = (typeof DISCOUNT_APPLIES_TO)[number];

/** refunds.status */
export const REFUND_STATUSES = ['initiated', 'processed', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** invoices.kind */
export const INVOICE_KINDS = ['tax_invoice', 'credit_note'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

/* ---------- Goods: stock, shipping, returns ---------- */

/** inventory_movements.reason */
export const INVENTORY_REASONS = [
  'purchase',
  'sale',
  'return',
  'adjustment',
  'damage',
  'reservation',
  'release',
] as const;
export type InventoryReason = (typeof INVENTORY_REASONS)[number];

/** shipments.status */
export const SHIPMENT_STATUSES = [
  'label_created',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'rto',
  'lost',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** return_requests.status */
export const RETURN_STATUSES = [
  'requested',
  'approved',
  'rejected',
  'pickup_scheduled',
  'received',
  'refunded',
  'closed',
] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

/** return_requests.resolution */
export const RETURN_RESOLUTIONS = ['refund', 'replacement', 'store_credit'] as const;
export type ReturnResolution = (typeof RETURN_RESOLUTIONS)[number];

/* ---------- Wallet & gift cards ---------- */

/** gift_cards.status */
export const GIFT_CARD_STATUSES = ['active', 'redeemed', 'disabled', 'expired'] as const;
export type GiftCardStatus = (typeof GIFT_CARD_STATUSES)[number];

/** credit_ledger.reason */
export const CREDIT_REASONS = [
  'return_credit',
  'goodwill',
  'promotion',
  'gift_card_redemption',
  'order_payment',
  'expiry',
  'adjustment',
] as const;
export type CreditReason = (typeof CREDIT_REASONS)[number];

/* ---------- People & operations ---------- */

/** staff_users.role */
export const STAFF_ROLES = ['owner', 'admin', 'manager', 'support', 'warehouse'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** order_events.actor_type + ticket_messages.sender_type (same trio) */
export const ACTOR_TYPES = ['system', 'customer', 'staff'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** notifications.recipient_type */
export const RECIPIENT_TYPES = ['customer', 'staff'] as const;
export type RecipientType = (typeof RECIPIENT_TYPES)[number];

/** reviews.status */
export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** blocklist.kind */
export const BLOCKLIST_KINDS = ['phone', 'email', 'pincode', 'ip'] as const;
export type BlocklistKind = (typeof BLOCKLIST_KINDS)[number];

/* ---------- Messaging ---------- */

/** message_log.channel */
export const MESSAGE_CHANNELS = ['email', 'sms', 'whatsapp', 'push'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

/** message_log.status */
export const MESSAGE_STATUSES = ['queued', 'sent', 'delivered', 'bounced', 'failed'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/* ---------- Support & enquiries ---------- */

/** support_tickets.channel */
export const TICKET_CHANNELS = ['web', 'email', 'whatsapp', 'phone', 'instagram'] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];

/** support_tickets.category */
export const TICKET_CATEGORIES = [
  'order_issue',
  'payment',
  'shipping',
  'product_question',
  'return_refund',
  'complaint',
  'general',
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** support_tickets.status */
export const TICKET_STATUSES = [
  'open',
  'pending_customer',
  'pending_internal',
  'resolved',
  'closed',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** support_tickets.priority */
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** product_enquiries.status */
export const ENQUIRY_STATUSES = ['new', 'replied', 'quoted', 'converted', 'closed'] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

/* ======================================================================
 * 2. Conventions — free-text columns the database does NOT enforce.
 * The `| (string & {})` trick keeps IDE autocomplete for the known
 * values while still allowing any new string without a type error.
 * ====================================================================*/

/** payments.provider */
export const PAYMENT_PROVIDERS = ['razorpay', 'cod', 'store_credit', 'gift_card'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number] | (string & {});

/** message_log.template */
export const MESSAGE_TEMPLATES = [
  'order_confirmation',
  'shipping_update',
  'delivery_confirmation',
  'otp',
  'abandoned_cart',
  'back_in_stock',
  'price_drop',
  'refund_processed',
] as const;
export type MessageTemplate = (typeof MESSAGE_TEMPLATES)[number] | (string & {});

/** notifications.kind */
export const NOTIFICATION_KINDS = [
  'order_placed',
  'order_shipped',
  'order_delivered',
  'low_stock',
  'new_order',
  'new_ticket',
  'new_enquiry',
  'return_requested',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number] | (string & {});

/** order_events.event */
export const ORDER_EVENT_TYPES = [
  'status_changed',
  'note_added',
  'payment_captured',
  'payment_failed',
  'shipment_created',
  'refund_initiated',
] as const;
export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number] | (string & {});

/** audit_logs.action */
export const AUDIT_ACTIONS = ['create', 'update', 'delete', 'price_change'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number] | (string & {});

/** return_requests.reason */
export const RETURN_REASONS = [
  'damaged',
  'wrong_item',
  'not_as_described',
  'size_issue',
  'quality_issue',
  'changed_mind',
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number] | (string & {});

/* ======================================================================
 * 3. Display labels for the user-facing lifecycles
 * ====================================================================*/

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'Pending payment',
  paid: 'Paid',
  packed: 'Packed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  created: 'Awaiting payment',
  authorized: 'Authorised',
  captured: 'Paid',
  failed: 'Failed',
  refunded: 'Refunded',
};

export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, string> = {
  label_created: 'Label created',
  picked_up: 'Picked up',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  rto: 'Returned to origin (RTO)',
  lost: 'Lost in transit',
};

export const RETURN_STATUS_LABELS: Record<ReturnStatus, string> = {
  requested: 'Requested',
  approved: 'Approved',
  rejected: 'Rejected',
  pickup_scheduled: 'Pickup scheduled',
  received: 'Received at warehouse',
  refunded: 'Refunded',
  closed: 'Closed',
};

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Open',
  pending_customer: 'Waiting on customer',
  pending_internal: 'Waiting on team',
  resolved: 'Resolved',
  closed: 'Closed',
};

/** Fallback for everything else: 'pickup_scheduled' -> 'Pickup scheduled' */
export function formatEnumLabel(value: string): string {
  return value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}