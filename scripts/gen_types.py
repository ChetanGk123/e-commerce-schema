#!/usr/bin/env python3
"""
Generates types/database.types.ts by introspecting a live database.

Run via `make types`, which builds a throwaway container from the migrations
first. Introspection rather than hand-editing, because nullability is the
detail humans get wrong: a column that is NOT NULL in Postgres but optional
in TypeScript produces null-checks that can never fire, and the reverse
produces runtime crashes TypeScript promised wouldn't happen.

CHECK-constraint columns are mapped to the unions in ./enums by the ENUMS
table below. Postgres reports them as plain `text`, so that mapping is the
one part of this file that must be maintained by hand -- if you add a
CHECK-constrained column, add it here too or it silently types as `string`.
"""

import subprocess
import sys

CONTAINER = "ecomm-verify"

# table -> exported interface name. Explicit because English plurals are not
# mechanically singularisable (addresses -> Address, not Addresse).
TABLES = {
    "categories": "Category",
    "products": "Product",
    "product_options": "ProductOption",
    "product_option_values": "ProductOptionValue",
    "product_variants": "ProductVariant",
    "variant_option_values": "VariantOptionValue",
    "product_images": "ProductImage",
    "collections": "Collection",
    "collection_products": "CollectionProduct",
    "product_relations": "ProductRelation",
    "customers": "Customer",
    "addresses": "Address",
    "communication_preferences": "CommunicationPreference",
    "staff_users": "StaffUser",
    "carts": "Cart",
    "cart_items": "CartItem",
    "orders": "Order",
    "order_items": "OrderItem",
    "payments": "Payment",
    "order_events": "OrderEvent",
    "inventory_movements": "InventoryMovement",
    "shipments": "Shipment",
    "shipment_items": "ShipmentItem",
    "return_requests": "ReturnRequest",
    "return_items": "ReturnItem",
    "refunds": "Refund",
    "discounts": "Discount",
    "discount_redemptions": "DiscountRedemption",
    "invoice_sequences": "InvoiceSequence",
    "invoices": "Invoice",
    "invoice_lines": "InvoiceLine",
    "gift_cards": "GiftCard",
    "gift_card_transactions": "GiftCardTransaction",
    "credit_ledger": "CreditLedgerEntry",
    "shipping_zones": "ShippingZone",
    "serviceable_pincodes": "ServiceablePincode",
    "shipping_rates": "ShippingRate",
    "blocklist": "BlocklistEntry",
    "reviews": "Review",
    "wishlist_items": "WishlistItem",
    "stock_alerts": "StockAlert",
    "price_history": "PriceHistoryEntry",
    "notifications": "Notification",
    "message_log": "MessageLogEntry",
    "support_tickets": "SupportTicket",
    "ticket_messages": "TicketMessage",
    "product_enquiries": "ProductEnquiry",
    "audit_logs": "AuditLog",
    "store_settings": "StoreSettings",
    "idempotency_keys": "IdempotencyKey",
    "webhook_events": "WebhookEvent",
}

VIEWS = {
    "storefront_variants": "StorefrontVariant",
    "public_settings": "PublicSettings",
    "customer_credit_balances": "CustomerCreditBalance",
}

# (table, column) -> TS type from ./enums
ENUMS = {
    ("products", "status"): "ProductStatus",
    ("product_variants", "status"): "VariantStatus",
    ("storefront_variants", "status"): "VariantStatus",
    ("product_relations", "kind"): "RelationKind",
    ("carts", "status"): "CartStatus",
    ("orders", "status"): "OrderStatus",
    ("payments", "status"): "PaymentStatus",
    ("payments", "provider"): "PaymentProvider",
    ("order_events", "actor_type"): "ActorType",
    ("order_events", "event"): "OrderEventType",
    ("inventory_movements", "reason"): "InventoryReason",
    ("shipments", "status"): "ShipmentStatus",
    ("return_requests", "status"): "ReturnStatus",
    ("return_requests", "resolution"): "ReturnResolution",
    ("return_requests", "reason"): "ReturnReason",
    ("refunds", "status"): "RefundStatus",
    ("discounts", "kind"): "DiscountKind",
    ("discounts", "applies_to"): "DiscountAppliesTo",
    ("invoices", "kind"): "InvoiceKind",
    ("gift_cards", "status"): "GiftCardStatus",
    ("credit_ledger", "reason"): "CreditReason",
    ("staff_users", "role"): "StaffRole",
    ("blocklist", "kind"): "BlocklistKind",
    ("reviews", "status"): "ReviewStatus",
    ("notifications", "recipient_type"): "RecipientType",
    ("notifications", "kind"): "NotificationKind",
    ("message_log", "channel"): "MessageChannel",
    ("message_log", "status"): "MessageStatus",
    ("message_log", "template"): "MessageTemplate",
    ("support_tickets", "channel"): "TicketChannel",
    ("support_tickets", "category"): "TicketCategory",
    ("support_tickets", "status"): "TicketStatus",
    ("support_tickets", "priority"): "TicketPriority",
    ("ticket_messages", "sender_type"): "ActorType",
    ("product_enquiries", "status"): "EnquiryStatus",
    ("audit_logs", "action"): "AuditAction",
    ("idempotency_keys", "scope"): "IdempotencyScope",
    ("webhook_events", "provider"): "WebhookProvider",
}

# (table, column) -> TS type for jsonb columns with a known shape
JSON_SHAPES = {
    ("orders", "shipping_address"): "AddressSnapshot",
    ("orders", "billing_address"): "AddressSnapshot",
    ("orders", "risk_flags"): "string[]",
    ("invoices", "billing_address"): "AddressSnapshot",
    ("product_variants", "specs"): "VariantSpecs",
    ("storefront_variants", "specs"): "VariantSpecs",
    ("audit_logs", "changes"): "AuditChanges",
    ("ticket_messages", "attachments"): "Attachment[]",
}

SCALARS = {
    "uuid": "string",
    "text": "string",
    "citext": "string",
    "character varying": "string",
    "character": "string",
    "bytea": "string",
    "numeric": "number",
    "integer": "number",
    "bigint": "number",
    "smallint": "number",
    "real": "number",
    "double precision": "number",
    "boolean": "boolean",
    "timestamp with time zone": "string",
    "timestamp without time zone": "string",
    "date": "string",
    "jsonb": "Record<string, unknown>",
    "json": "Record<string, unknown>",
    "interval": "string",
    "USER-DEFINED": "string",
}


def introspect():
    sql = """
    select c.table_name, c.column_name, c.data_type, c.is_nullable,
           coalesce(c.column_default, ''), c.is_generated, c.ordinal_position
    from information_schema.columns c
    where c.table_schema = 'public'
    order by c.table_name, c.ordinal_position;
    """
    out = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres",
         "-tAF", "\t", "-c", sql],
        capture_output=True, text=True, check=True,
    ).stdout

    cols = {}
    for line in out.strip().splitlines():
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        table, col, dtype, nullable, default, generated, _ = parts
        cols.setdefault(table, []).append({
            "name": col,
            "type": dtype,
            "nullable": nullable == "YES",
            "has_default": default != "",
            "generated": generated == "ALWAYS",
        })
    return cols


def ts_type(table, col):
    key = (table, col["name"])
    if key in JSON_SHAPES:
        base = JSON_SHAPES[key]
    elif key in ENUMS:
        base = ENUMS[key]
    else:
        base = SCALARS.get(col["type"], "unknown")
    return base + (" | null" if col["nullable"] else "")


def emit(name, table, cols, is_view=False):
    lines = [f"export interface {name} {{"]
    for c in cols:
        notes = []
        if c["generated"]:
            notes.append("generated, read-only")
        elif c["has_default"] and not is_view:
            notes.append("has default")
        comment = f"  // {', '.join(notes)}" if notes else ""
        lines.append(f"  {c['name']}: {ts_type(table, c)};{comment}")
    lines.append("}")
    return "\n".join(lines)


def main():
    cols = introspect()

    missing = [t for t in list(TABLES) + list(VIEWS) if t not in cols]
    if missing:
        sys.exit(f"not found in database: {', '.join(missing)}")

    extra = set(cols) - set(TABLES) - set(VIEWS)
    if extra:
        sys.exit("present in database but absent from the TABLES map "
                 f"(add them): {', '.join(sorted(extra))}")

    enum_names = sorted(set(ENUMS.values()))
    parts = [
        HEADER,
        "import type {\n  " + ",\n  ".join(enum_names) + ",\n} from './enums';\n",
        SHARED,
        "/* ---------- Tables ---------- */\n",
    ]
    for table, name in TABLES.items():
        parts.append(emit(name, table, cols[table]) + "\n")

    parts.append("/* ---------- Views ---------- */\n")
    for view, name in VIEWS.items():
        parts.append(emit(name, view, cols[view], is_view=True) + "\n")

    merged = dict(TABLES)
    merged.update(VIEWS)
    parts.append(TABLE_MAP.format(
        rows="\n".join(f"  {t}: {n};" for t, n in merged.items())
    ))

    with open("types/database.types.ts", "w") as f:
        f.write("\n".join(parts))

    print(f"==> types/database.types.ts ({len(TABLES)} tables, {len(VIEWS)} views)")


HEADER = '''/**
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
'''

SHARED = '''/* ---------- Shared JSON shapes ---------- */

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
'''

TABLE_MAP = '''/* ---------- Name -> row type, for generic helpers ---------- */

export interface Tables {{
{rows}
}}

export type TableName = keyof Tables;
export type Row<T extends TableName> = Tables[T];
'''

if __name__ == "__main__":
    main()
