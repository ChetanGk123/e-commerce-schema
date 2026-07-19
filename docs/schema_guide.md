# The Store's Database, Explained

*A plain-English companion to `ecommerce-schema-full.sql`. No technical background needed.*

This database is the store's entire back office in digital form: the product catalogue, the order book, the stock register, the invoice book, the complaint register, and the accounts ledger. It's organised into **49 tables**, and this guide explains what each one does and why it exists.

---

## 1. How to read this guide

A **table** is best imagined as one register or ledger book. Each **row** in a table is one entry in that register — one product, one order, one payment.

Every row gets an **id** — a unique serial number, like the number printed on a bill. Tables refer to each other using these numbers instead of copying information. An order doesn't rewrite the customer's name and address; it just notes the customer's id, the way a shop bill might say "Account No. 42" instead of copying the whole account. This is what keeps everything connected: given any order, the database can instantly find the customer, the products, the payment, the shipment, and the invoice that belong to it.

A few words that appear throughout, in plain terms:

| Word | What it means here |
|---|---|
| **SKU** | "Stock Keeping Unit" — the code for one exact sellable item, e.g. `MBA-M3-16-512-MID` |
| **Snapshot** | A frozen copy taken at a moment in time, kept even if the original changes later |
| **Ledger** | A register where entries are only ever *added*, never edited — like a bank passbook |
| **Flag** | A simple yes/no marker on a row |

---

## 2. The big picture

The 49 tables fall into natural groups, the same way a shop's paperwork does:

| Area | What lives there |
|---|---|
| **The catalogue** | What we sell — products, their variations, photos, prices |
| **People** | Customers, their addresses, and the staff who run the store |
| **Shopping** | Carts, wishlists, and "tell me when it's back" requests |
| **Orders & money** | The order book, payments, discounts, refunds, GST invoices, gift cards, store credit |
| **Goods** | The stock register, shipments, and returns |
| **Conversations** | Notifications, emails/SMS/WhatsApp, support tickets, sales enquiries |
| **Running the shop** | Shipping charges, fraud protection, audit records, store settings |

---

## 3. The life of one order (the story that ties it together)

The easiest way to understand the database is to follow one purchase through it. Meet Priya, who buys a laptop.

1. **She browses.** The product page for "MacBook Air" comes from the `products` table. The choice buttons — Chip, Memory, Colour — come from `product_options` and `product_option_values`. When she picks *M3, 16GB, Midnight*, the site looks up which exact item matches that combination (via `variant_option_values`) and finds it in `product_variants`: its own price, its own description, its own stock count. The photos, including the Midnight-specific ones, come from `product_images`.

2. **She adds it to her cart.** A row appears in `carts` and one in `cart_items`. She hasn't logged in yet, so the cart is tied to her browser session — it survives even if she leaves and comes back tomorrow.

3. **She checks out.** She enters her pincode; `serviceable_pincodes` confirms delivery is possible and Cash-on-Delivery is allowed there. `shipping_rates` calculates the delivery charge for her zone. She applies coupon `DIWALI20`, which is checked against `discounts` (is it active? has she used it before? is the order big enough?).

4. **The order is created.** A row in `orders` records the totals, her address, and — importantly — a *snapshot* of everything. Each item becomes a row in `order_items` that copies the product name, SKU, and today's price. If the price changes next week, her bill stays exactly as it was — just like a printed paper bill doesn't change when the price board does. The coupon use is recorded in `discount_redemptions`, and a quick fraud check writes a risk score onto the order (see §11).

5. **Stock is set aside.** A "reservation" entry goes into `inventory_movements`, the stock ledger, so nobody else can buy the last unit while her payment is processing.

6. **She pays.** A row in `payments` tracks the Razorpay payment from "created" to "captured". The reservation converts into a "sale" in the stock ledger.

7. **The store confirms.** An order-confirmation message is written into `message_log` and a worker sends it by WhatsApp and email. A GST invoice is generated: a permanent, numbered document in `invoices` with its line-by-line tax breakup in `invoice_lines` (see §9).

8. **The parcel ships.** A row in `shipments` holds the courier and tracking number. Every step — paid, packed, shipped, delivered — is also written into `order_events`, which is what powers the tracking timeline Priya sees.

9. **Something's wrong.** The colour isn't what she expected, so she raises a return: a `return_requests` row, with the specific item in `return_items`. The store approves it. When the laptop arrives back, a "return" entry goes into the stock ledger, a *credit note* is issued in `invoices`, and either money goes back via `refunds` or store credit is added to her wallet in `credit_ledger`.

10. **She reviews it anyway.** Her 4-star review in `reviews` is linked to her actual purchase, which is why it carries the "Verified buyer" badge.

Ten tables of paperwork — and not a single register was overwritten. That's the whole philosophy: **record everything, erase nothing.**

---

## 4. The catalogue — what we sell

**`categories`** — The shop's departments: Electronics → Laptops. Categories can sit inside other categories, like shelves inside aisles.

**`products`** — One row per product *family*: "MacBook Air". It holds the shared story — brand, general description, the GST tax code (HSN) and rate. Notice what it *doesn't* hold: a price. That's deliberate.

**`product_options`** and **`product_option_values`** — The questions and the answers. Options are the questions a buyer must answer ("Which colour?"), values are the possible answers ("Midnight", "Silver", "Starlight"). These two tables exist purely to draw the choice buttons on the product page.

**`product_variants`** — The heart of the catalogue. One row per *exact sellable configuration*: "MacBook Air, M3, 16GB, 512GB, Midnight — ₹1,34,900, 6 in stock, SKU MBA-M3-16-512-MID". Price, stock, specifications, and even a variant-specific description live here. **Everything a customer actually buys is a variant** — even a simple product with no choices gets one default variant, so the checkout never needs a special case.

**`variant_option_values`** — The matchmaker. It records that variant #123 = M3 + 16GB + Midnight. When Priya clicks her three buttons, this table is how the site finds the right variant and swaps in its price.

**`product_images`** — The photo album. Each photo belongs to a product and can optionally be pinned to one variant, so choosing "Midnight" shows the Midnight photos.

**`collections`** and **`collection_products`** — Hand-picked shop windows: "Diwali Sale", "New Arrivals". A product can appear in many collections; this pair of tables records who's in which window and in what order.

**`product_relations`** — "Goes well with." Links products to their accessories, upgrades, and frequently-bought-together partners, powering the cross-sell strip on the product page.

**`price_history`** — Every time a variant's price changes, a row records the old and new price, when, and by whom. This powers "price dropped!" alerts for wishlisted items and lets the admin see pricing over time.

---

## 5. People

**`customers`** — One row per shopper: name, email, phone. Login and passwords are handled by the authentication system (Supabase), not stored here.

**`addresses`** — A customer's saved delivery addresses ("Home", "Office"), with one marked as default.

**`staff_users`** — The people who run the store, each with a role: owner, admin, manager, support, or warehouse. The admin console decides what each role is allowed to see and do.

**`audit_logs`** — The "who changed what" register for staff actions. If a price was edited from ₹999 to ₹899, this table remembers which staff member did it and when. Essential the first time something looks off.

---

## 6. Shopping — before the order exists

**`carts`** and **`cart_items`** — The trolley. A cart belongs either to a logged-in customer or to a guest's browser session, and its items each point at a variant with a quantity. Carts that sit untouched for a few hours are exactly how "you left something behind!" WhatsApp nudges get triggered.

**`wishlist_items`** — Saved-for-later items, one row per customer per variant.

**`stock_alerts`** — "Notify me when it's back." When a sold-out variant is restocked, everyone waiting in this table gets a message, and the row is marked as notified.

---

## 7. Orders & payments — the order book

**`orders`** — The master order book. One row per order with the totals (subtotal, discount, shipping, GST, grand total), the order status (pending → paid → packed → shipped → delivered), a snapshot of the delivery address, the coupon code used, where the customer came from (see §12), and a fraud-risk score.

**`order_items`** — The lines on the bill. Each row snapshots the product name, variant title, SKU, and unit price *at the moment of purchase*. This is why old orders stay accurate forever, no matter how the catalogue changes.

**`payments`** — One row per payment attempt: which gateway (Razorpay, COD), the gateway's reference number, and the status from "created" through "captured" (or "failed"). An order can have more than one — a failed attempt followed by a successful one, for example.

**`discounts`** — The coupon book: code, type (percentage / fixed amount / free shipping), minimum order, usage limits, validity dates, and what it applies to (the whole order, a collection, or one product).

**`discount_redemptions`** — Who used which coupon on which order, and how much it actually saved. This is how "one use per customer" is enforced and how support answers "did my coupon apply?".

**`refunds`** — Money going back. Each refund points at the *original payment* (because the gateway refunds against a specific payment), optionally at the return that caused it, and tracks the gateway's refund status.

---

## 8. Goods — stock, shipping, and returns

**`inventory_movements`** — The stock register, and the single source of truth for stock. Every change is a signed entry: +50 purchase, −1 sale, +1 return, −2 damaged, −1 reserved, +1 released. The convenient `stock` number shown on each variant is just a running total kept in sync with this ledger. Because it's a ledger, stock can never silently "drift" — every unit is accounted for, and any discrepancy can be traced entry by entry.

**`shipments`** and **`shipment_items`** — The dispatch register. A shipment records the courier, tracking number, and delivery status — including `rto` (Return To Origin, when a COD parcel comes back undelivered, a routine hazard of Indian logistics). One order can ship in several boxes, which is why shipment items exist: they say which order lines, and how many of each, went in which box.

**`return_requests`**, **`return_items`**, and the loop back — The complaint-and-return flow. A request records the reason and moves through requested → approved → pickup scheduled → received → refunded. Return items list exactly what's coming back and its condition on arrival. The resolution is either a refund (§7), a replacement, or store credit (§10).

---

## 9. GST invoicing — the legal paperwork

**`invoices`** — The invoice book. Unlike everything else, invoices are *legal documents*: once issued they are never edited or deleted. Each one snapshots the customer's details, the seller's GSTIN, and the full tax breakup. Whether tax splits into CGST + SGST (buyer in the same state) or IGST (different state) is decided by the "place of supply" recorded here. Corrections are never made by changing an invoice — a **credit note** (also a row in this table) is issued against the original, exactly like tearing nothing out of a numbered bill book.

**`invoice_lines`** — The line-by-line detail: each item's HSN code, taxable value, GST rate, and the tax amounts. This is precisely the detail the accountant needs for GSTR-1 filing.

**`invoice_sequences`** — A tiny but legally important table: one counter per financial year that hands out invoice numbers **in order, with no gaps** — a GST requirement that ordinary database numbering can't guarantee.

---

## 10. Gift cards & the wallet

**`gift_cards`** — Each card has a code, an initial value, and a remaining balance, plus who bought it and for whom.

**`gift_card_transactions`** — Every top-up or redemption on a card, with the balance after each — a mini-passbook per card.

**`credit_ledger`** — The customer's wallet, kept as a proper ledger: +₹500 return credit, −₹500 spent on order #1042, each entry with its reason and expiry. The wallet balance is always *the sum of the entries* — there is no editable "balance" field anywhere, because for money the store owes people, a passbook that can't lose a rupee beats a number that could be accidentally overwritten. This same ledger is ready to hold loyalty points later.

---

## 11. Shipping charges & fraud protection

**`shipping_zones`** — Delivery regions: "Karnataka", "Metros", "North East", "Rest of India".

**`serviceable_pincodes`** — The master list of pincodes the store delivers to (imported from the courier's own list), which zone each belongs to, and whether COD is allowed there. This answers the "Deliver to 560001?" check on the product page.

**`shipping_rates`** — The rate card: for each zone, the charge by parcel weight and order value, the COD surcharge, and the estimated delivery days. If nothing matches, the store's flat rate applies.

**`blocklist`** — Protection against repeat offenders. Phone numbers, emails, or pincodes with a history of refusing COD parcels (each refusal costs the store two-way courier fees) can be listed here, permanently or temporarily. At checkout, this list plus past history produces the risk score written on the order — a high score might mean asking for online payment instead of COD.

---

## 12. Conversations — talking to customers

**`notifications`** — The in-app bell icon, for both customers ("Your order shipped!") and staff ("Stock low on 3 items").

**`message_log`** — Every email, SMS, and WhatsApp the store sends, with its template, recipient, and delivery status. It's written *before* sending (as "queued") in the same breath as the order itself, and a background worker does the actual sending — so even if the email service hiccups, no confirmation is ever lost; it simply stays queued until it goes through. Delivery reports from the provider update each row to delivered or bounced.

**`communication_preferences`** — Each customer's consent, per channel: order updates default ON; marketing defaults OFF until they opt in — which is what India's data-protection law (DPDP) expects.

**`support_tickets`** and **`ticket_messages`** — The complaint register and its conversation threads. Every channel — contact form, email, WhatsApp, phone, Instagram — lands in this one inbox. Each ticket has a category, priority, an assigned staff member, and a status that says *whose court the ball is in* ("pending customer" vs "pending internal"). Messages within a ticket can be marked internal — staff-only notes the customer never sees. The time-to-first-reply is recorded, because that's the one support number worth watching.

**`product_enquiries`** — Sales leads, kept separate from complaints: "What's the price for 50 units?", "Can this be customised?". Each moves through new → replied → quoted → converted, and when a deal closes, the resulting order is linked back — so the store knows exactly what fraction of enquiries turn into sales.

---

## 13. Running the shop

**`order_events`** — The diary of each order: every status change, note, and payment event, with who (or what) caused it. It powers both the customer's tracking timeline and the support team's view of "what exactly happened with this order".

**`store_settings`** — A single-row table of store-wide switches: store name, support contacts, free-shipping threshold, whether COD is on, and a flexible box for everything else.

---

## 14. The five rules behind the design

1. **The variant is what's sold.** A product is the poster; a variant is the box on the shelf. Carts, orders, and stock always deal in variants — never in products directly.

2. **Orders remember everything.** Names, SKUs, and prices are copied onto the order at purchase time. A paper bill doesn't change when the price board does; neither do these.

3. **Money lives in ledgers.** Stock, wallet credit, and gift-card balances are all sums of entries, never editable numbers. Ledgers can be audited; overwritten numbers can't.

4. **Invoices are permanent.** Numbered without gaps, never edited, never deleted. Mistakes get a credit note, not an eraser.

5. **History is sacred.** Order events, audit logs, price history, message logs — the database is designed so that "what happened?" always has an answer.

---

## Glossary

| Term | Meaning |
|---|---|
| **COD** | Cash on Delivery — pay the courier when the parcel arrives |
| **RTO** | Return To Origin — an undelivered parcel coming back to the store |
| **GSTIN** | A business's GST registration number |
| **HSN code** | The government's classification code for a type of goods, printed on invoices |
| **CGST / SGST / IGST** | The GST split: Central + State tax for same-state sales, Integrated tax for inter-state |
| **Credit note** | The official "negative invoice" issued for a return, instead of editing the original |
| **RMA** | Return Merchandise Authorisation — the formal return-approval process |
| **UTM tags** | Little labels in ad links (source / medium / campaign) that reveal which ad brought a buyer |
| **Outbox** | The pattern of saving a message in the database first, sending it second — so nothing is lost |