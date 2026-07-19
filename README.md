# E-commerce schema

Production-ready Postgres schema for an e-commerce app with full product
variant support — Amazon / Apple-style configurations where each variant
carries its own price, description, specs, stock, and images.

Built for Postgres 15+ / Supabase. Single file, runs top to bottom.

## What's inside

`ecommerce-schema-full.sql` — 49 tables:

- **Catalog** — products → options → option values → variants (SKUs), variant-pinned images, categories, curated collections, related products / cross-sells, price history
- **Commerce** — customers, addresses, guest-capable carts, orders with line-item snapshots and UTM attribution, payments
- **Money & compliance** — discount codes with redemption tracking, refunds tied to specific gateway payments, GST invoices with gap-free numbering and CGST/SGST/IGST breakup, gift cards, store-credit wallet ledger
- **Goods** — inventory movement ledger (reservations included), shipments with partial fulfilment and RTO status, RMA returns, shipping zones with pincode serviceability and COD surcharge, COD risk blocklist
- **Trust & engagement** — verified-purchase reviews, wishlists, back-in-stock alerts
- **Operations** — staff roles, audit log, order event timeline, transactional message outbox (email / SMS / WhatsApp), consent preferences, single-row store settings
- **Support** — unified ticket inbox (web / email / WhatsApp / phone) with threaded messages, internal notes and SLA timestamps, plus product & bulk enquiries with order-conversion tracking

## Usage

```sh
psql "$DATABASE_URL" -f ecommerce-schema-full.sql
```

Or paste into the Supabase SQL editor, or save as a migration.

## Key design decisions

- The **variant is the unit of sale** — carts and orders reference `variant_id`, and simple products get one default variant so checkout logic stays uniform
- Order items **snapshot** product name, SKU, and price at purchase time, so invoices stay historically accurate as the catalog changes
- `inventory_movements` is the **source of truth for stock**; `variant.stock` is a cached total updated in the same transaction
- `message_log` doubles as a **transactional outbox**, so order confirmations survive email-provider hiccups
- Duplicate option combinations are blocked by a unique index on a canonical `options_signature` set by app code