# The Store's Database, Explained

*A plain-English companion to the migrations in `supabase/migrations/`. No technical background needed.*

This database is the store's entire back office in digital form: the product catalogue, the order book, the stock register, the invoice book, the complaint register, and the accounts ledger. It's organised into **51 tables**, and this guide explains what each one does and why it exists.

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
| **Rule** | A constraint the database itself refuses to break, no matter which program is asking |

That last one matters more than it sounds, and §15 explains why.

---

## 2. The big picture

The 51 tables fall into natural groups, the same way a shop's paperwork does:

| Area | What lives there |
|---|---|
| **The catalogue** | What we sell — products, their variations, photos, prices |
| **People** | Customers, their addresses, and the staff who run the store |
| **Shopping** | Carts, wishlists, and "tell me when it's back" requests |
| **Orders & money** | The order book, payments, discounts, refunds, GST invoices, gift cards, store credit |
| **Goods** | The stock register, shipments, and returns |
| **Conversations** | Notifications, emails/SMS/WhatsApp, support tickets, sales enquiries |
| **Running the shop** | Shipping charges, fraud protection, audit records, store settings |
| **Plumbing** | Two behind-the-scenes registers that stop the store charging anyone twice (§13) |

---

## 3. The life of one order (the story that ties it together)

The easiest way to understand the database is to follow one purchase through it. Meet Priya, who buys a laptop.

1. **She browses.** The product page for "MacBook Air" comes from the `products` table. The choice buttons — Chip, Memory, Colour — come from `product_options` and `product_option_values`. When she picks *M3, 16GB, Midnight*, the site looks up which exact item matches that combination (via `variant_option_values`) and finds it in `product_variants`: its own price, its own description, its own stock count. The photos, including the Midnight-specific ones, come from `product_images`.

2. **She adds it to her cart.** A row appears in `carts` and one in `cart_items`. She hasn't logged in yet, so the cart is tied to her browser session — it survives even if she leaves and comes back tomorrow.

3. **She checks out.** She enters her pincode; `serviceable_pincodes` confirms delivery is possible and Cash-on-Delivery is allowed there. `shipping_rates` calculates the delivery charge for her zone. She applies coupon `DIWALI20`, which is checked against `discounts` (is it active? has she used it before? is the order big enough?).

4. **Her phone stutters and she taps "Pay" twice.** Nothing bad happens. The first tap claimed a row in `idempotency_keys`; the second tap finds that row and is handed back the first tap's answer instead of creating a second order. This is new, and it is the difference between a good day and a support queue full of duplicate charges.

5. **The order is created.** A row in `orders` records the totals, her address, and — importantly — a *snapshot* of everything, including her email, so the order stays contactable even if her account is later closed. Each item becomes a row in `order_items` that copies the product name, SKU, and today's price. If the price changes next week, her bill stays exactly as it was — just like a printed paper bill doesn't change when the price board does. The coupon use is recorded in `discount_redemptions`, and a quick fraud check writes a risk score onto the order (see §11).

6. **Stock is set aside.** A "reservation" entry goes into `inventory_movements`, the stock ledger, so nobody else can buy the last unit while her payment is processing. Every reservation now carries an expiry time — if the payment is abandoned and the release never happens, a scheduled sweeper puts that unit back on sale instead of stranding it forever.

7. **She pays.** A row in `payments` tracks the Razorpay payment from "created" to "captured". The reservation converts into a "sale" in the stock ledger. Razorpay then tells the store the payment succeeded — sometimes several times over, because payment gateways retry until they get an answer. Each of those messages is recorded once in `webhook_events`, so a repeated notification is recognised and ignored rather than capturing the money twice.

8. **The store confirms.** An order-confirmation message is written into `message_log` and a worker sends it by WhatsApp and email. A GST invoice is generated: a permanent, numbered document in `invoices` with its line-by-line tax breakup in `invoice_lines` (see §9).

9. **The parcel ships.** A row in `shipments` holds the courier and tracking number. Every step — paid, packed, shipped, delivered — is also written into `order_events`, which is what powers the tracking timeline Priya sees.

10. **Something's wrong.** The colour isn't what she expected, so she raises a return: a `return_requests` row, with the specific item in `return_items`. The store approves it. When the laptop arrives back, a "return" entry goes into the stock ledger, a *credit note* is issued in `invoices`, and either money goes back via `refunds` or store credit is added to her wallet in `credit_ledger`.

11. **She reviews it anyway.** Her 4-star review in `reviews` is linked to her actual purchase, which is why it carries the "Verified buyer" badge — and which is why she cannot award that badge to herself (§14).

A dozen tables of paperwork — and not a single register was overwritten. That's the whole philosophy: **record everything, erase nothing.**

---

## 4. The catalogue — what we sell

**`categories`** — The shop's departments: Electronics → Laptops. Categories can sit inside other categories, like shelves inside aisles.

**`products`** — One row per product *family*: "MacBook Air". It holds the shared story — brand, general description, the GST tax code (HSN) and rate. Notice what it *doesn't* hold: a price. That's deliberate.

**`product_options`** and **`product_option_values`** — The questions and the answers. Options are the questions a buyer must answer ("Which colour?"), values are the possible answers ("Midnight", "Silver", "Starlight"). These two tables exist purely to draw the choice buttons on the product page.

**`product_variants`** — The heart of the catalogue. One row per *exact sellable configuration*: "MacBook Air, M3, 16GB, 512GB, Midnight — ₹1,34,900, 6 in stock, SKU MBA-M3-16-512-MID". Price, stock, specifications, and even a variant-specific description live here. **Everything a customer actually buys is a variant** — even a simple product with no choices gets one default variant, so the checkout never needs a special case.

Two small things worth knowing. First, exactly one variant per product can be the default; the database refuses a second, so the product page always knows which configuration to show first. Second, "is this buyable?" is no longer something anyone can set by hand — it's worked out from the stock count and the status together, so the shelf label can never disagree with the shelf.

**`variant_option_values`** — The matchmaker. It records that variant #123 = M3 + 16GB + Midnight. When Priya clicks her three buttons, this table is how the site finds the right variant and swaps in its price.

This table also carries a quiet safeguard: it is now impossible to build a MacBook variant out of a T-shirt's "Size: XL" option. The database checks that every part of a variant belongs to the same product, and rejects anything else outright. The same protection stops a photo being pinned to another product's variant.

**`product_images`** — The photo album. Each photo belongs to a product and can optionally be pinned to one variant, so choosing "Midnight" shows the Midnight photos.

**`collections`** and **`collection_products`** — Hand-picked shop windows: "Diwali Sale", "New Arrivals". A product can appear in many collections; this pair of tables records who's in which window and in what order.

**`product_relations`** — "Goes well with." Links products to their accessories, upgrades, and frequently-bought-together partners, powering the cross-sell strip on the product page.

**`price_history`** — Every time a variant's price changes, a row records the old and new price, when, and by whom. This powers "price dropped!" alerts for wishlisted items and lets the admin see pricing over time.

---

## 5. People

**`customers`** — One row per shopper: name, email, phone. Login and passwords are handled by the authentication system (Supabase), not stored here.

Two details matter. A customer's id **is** their login id — the same number, not a copy — which is how the database knows that the person asking to see an order is the person who placed it. And email is now treated case-insensitively, so `Priya@example.com` and `priya@example.com` are recognised as one person rather than quietly becoming two accounts.

**Closing an account.** Indian data-protection law (DPDP) gives people the right to be erased; GST law requires the store to keep invoices and order records for years. These pull in opposite directions, so the database does not simply delete a customer. A dedicated procedure scrubs the personal details — name, email, phone, saved addresses — while leaving the commercial record intact. Deleting a customer outright is *refused*, on purpose, because doing so would also erase their store-credit balance, which is money the shop owes them.

**`addresses`** — A customer's saved delivery addresses ("Home", "Office"), with exactly one marked as default — the database now enforces that "exactly".

**`staff_users`** — The people who run the store, each with a role: owner, admin, manager, support, or warehouse.

> **A known limitation, stated plainly.** The roles are recorded, but the database does not currently act on them. Every active staff member has full access to every table. In practice that means a warehouse packer's login can, if used through the raw data interface rather than the admin screens, read cost prices, every customer's personal details, and the store's settings — regardless of what the admin console chooses to display. The database draws the line between staff and non-staff, and no further. Deciding what each role may do is, for now, the admin application's job. Two things limit the damage: the permanent registers (§15) refuse changes from staff as well, and `audit_logs` records who touched what. Teaching the database the roles themselves is the single most valuable improvement left.

**`audit_logs`** — The "who changed what" register for staff actions. If a price was edited from ₹999 to ₹899, this table remembers which staff member did it and when. It now fills itself automatically for the sensitive tables — prices, discounts, gift cards, staff accounts, the blocklist and store settings — rather than relying on the application to remember to write to it. Essential the first time something looks off.

---

## 6. Shopping — before the order exists

**`carts`** and **`cart_items`** — The trolley. A cart belongs either to a logged-in customer or to a guest's browser session, and its items each point at a variant with a quantity. Carts that sit untouched for a few hours are exactly how "you left something behind!" WhatsApp nudges get triggered. A cart now records whether it turned into an order, which is what makes "how many abandoned carts did we recover?" an answerable question. Old guest trolleys are swept away on a schedule — left alone, they would eventually become the largest thing in the database, because every passing bot creates one.

**`wishlist_items`** — Saved-for-later items, one row per customer per variant.

**`stock_alerts`** — "Notify me when it's back." When a sold-out variant is restocked, everyone waiting in this table gets a message, and the row is marked as notified. One person can only be waiting once per item, so a restock sends one email per person rather than one per time they clicked the button.

---

## 7. Orders & payments — the order book

**`orders`** — The master order book. One row per order with the totals (subtotal, discount, shipping, GST, grand total), the order status (pending → paid → packed → shipped → delivered), a snapshot of the delivery address, the buyer's contact details, the coupon code used, where the customer came from (see §12), and a fraud-risk score.

The totals are now checked by the database itself: the grand total must equal subtotal − discount + shipping + tax. Any arithmetic slip is refused at the door rather than discovered on a customer's bill.

**`order_items`** — The lines on the bill. Each row snapshots the product name, variant title, SKU, and unit price *at the moment of purchase*. This is why old orders stay accurate forever, no matter how the catalogue changes.

**`payments`** — One row per payment attempt: which gateway (Razorpay, COD), the gateway's reference number, and the status from "created" through "captured" (or "failed"). An order can have more than one — a failed attempt followed by a successful one, for example. A gateway's reference number can only appear once, which is what makes a repeated notification from Razorpay harmless.

**`discounts`** — The coupon book: code, type (percentage / fixed amount / free shipping), minimum order, usage limits, validity dates, and what it applies to (the whole order, a collection, or one product).

Usage limits are now genuinely enforced. Previously, two people checking out at the same moment could each be told a single-use code was unused, and both would get the discount. The database now counts redemptions as they happen and refuses the one that would go over the limit — including per-customer limits.

**`discount_redemptions`** — Who used which coupon on which order, and how much it actually saved. This is how "one use per customer" is enforced and how support answers "did my coupon apply?".

**`refunds`** — Money going back. Each refund points at the *original payment* (because the gateway refunds against a specific payment), optionally at the return that caused it, and tracks the gateway's refund status.

---

## 8. Goods — stock, shipping, and returns

**`inventory_movements`** — The stock register, and the single source of truth for stock. Every change is a signed entry: +50 purchase, −1 sale, +1 return, −2 damaged, −1 reserved, +1 released. The convenient `stock` number shown on each variant is just a running total kept in sync with this ledger. Because it's a ledger, stock can never silently "drift" — every unit is accounted for, and any discrepancy can be traced entry by entry.

Two additions. Reservations carry an expiry, and a scheduled job returns expired holds to the shelf. And each reservation can be released only once — previously nothing stopped two "release" entries for the same hold, which would have invented stock out of nothing.

**`shipments`** and **`shipment_items`** — The dispatch register. A shipment records the courier, tracking number, and delivery status — including `rto` (Return To Origin, when a COD parcel comes back undelivered, a routine hazard of Indian logistics). One order can ship in several boxes, which is why shipment items exist: they say which order lines, and how many of each, went in which box. You can no longer dispatch more of an item than was actually ordered; the database counts across every box and refuses the excess.

**`return_requests`**, **`return_items`**, and the loop back — The complaint-and-return flow. A request records the reason and moves through requested → approved → pickup scheduled → received → refunded. Return items list exactly what's coming back and its condition on arrival. The resolution is either a refund (§7), a replacement, or store credit (§10). As with shipments, you cannot return more than was bought — and a return can only ever contain items from its own order.

---

## 9. GST invoicing — the legal paperwork

**`invoices`** — The invoice book. Unlike everything else, invoices are *legal documents*: once issued they are never edited or deleted. Each one snapshots the customer's details, the seller's GSTIN, and the full tax breakup. Whether tax splits into CGST + SGST (buyer in the same state) or IGST (different state) is decided by the "place of supply" recorded here. Corrections are never made by changing an invoice — a **credit note** (also a row in this table) is issued against the original, exactly like tearing nothing out of a numbered bill book.

The tax arithmetic is now checked by the database: CGST and SGST must match each other, they can never coexist with IGST, and the totals must add up. There is also room for the government's e-invoicing details (the IRN, acknowledgement number and signed QR code), which larger sellers are required to obtain — blank until the tax portal issues them, and permanent once it has.

**`invoice_lines`** — The line-by-line detail: each item's HSN code, taxable value, GST rate, and the tax amounts. This is precisely the detail the accountant needs for GSTR-1 filing.

**`invoice_sequences`** — A tiny but legally important table: one counter per financial year that hands out invoice numbers **in order, with no gaps** — a GST requirement that ordinary database numbering can't guarantee.

Order numbers and ticket numbers work differently on purpose: they use ordinary numbering and may skip the occasional number. Making them gap-free would force every checkout in the shop to queue behind a single lock, and there's no law requiring it.

---

## 10. Gift cards & the wallet

**`gift_cards`** — Each card has an initial value and a remaining balance, plus who bought it and for whom.

The code itself is no longer stored. A gift card code is like cash in an envelope: anyone who can read it can spend it, so a leaked backup or an over-shared screenshot is a direct loss. The database keeps only a scrambled fingerprint of the code, plus its last four characters so support can identify a card a customer reads out over the phone.

**`gift_card_transactions`** — Every top-up or redemption on a card, with the balance after each — a mini-passbook per card. The card's balance is now kept in step with this passbook automatically, and a card cannot be spent below zero.

**`credit_ledger`** — The customer's wallet, kept as a proper ledger: +₹500 return credit, −₹500 spent on order #1042, each entry with its reason and expiry. The wallet balance is always *the sum of the entries* — there is no editable balance field here at all, because for money the store owes people, a passbook that can't lose a rupee beats a number that could be accidentally overwritten. This same ledger is ready to hold loyalty points later.

---

## 11. Shipping charges & fraud protection

**`shipping_zones`** — Delivery regions: "Karnataka", "Metros", "North East", "Rest of India".

**`serviceable_pincodes`** — The master list of pincodes the store delivers to (imported from the courier's own list), which zone each belongs to, and whether COD is allowed there. This answers the "Deliver to 560001?" check on the product page.

**`shipping_rates`** — The rate card: for each zone, the charge by parcel weight and order value, the COD surcharge, and the estimated delivery days. If nothing matches, the store's flat rate applies.

Rate bands can no longer overlap. Previously two rules could both apply to the same basket, and which one the customer saw came down to chance; now the database refuses to accept a rate card that is ambiguous in the first place.

**`blocklist`** — Protection against repeat offenders. Phone numbers, emails, or pincodes with a history of refusing COD parcels (each refusal costs the store two-way courier fees) can be listed here, permanently or temporarily. At checkout, this list plus past history produces the risk score written on the order — a high score might mean asking for online payment instead of COD.

Phone numbers must be written in the full international form. This sounds pedantic and is not: a blocklist holding `9876543210` while checkout looks up `+919876543210` blocks nobody at all, and the only way you find out is the courier bill.

---

## 12. Conversations — talking to customers

**`notifications`** — The in-app bell icon, for both customers ("Your order shipped!") and staff ("Stock low on 3 items"). Customers can mark their own notifications as read — and nothing else about them, which was not previously true.

**`message_log`** — Every email, SMS, and WhatsApp the store sends, with its template, recipient, and delivery status. It's written *before* sending (as "queued") in the same breath as the order itself, and a background worker does the actual sending — so even if the email service hiccups, no confirmation is ever lost; it simply stays queued until it goes through. Delivery reports from the provider update each row to delivered or bounced.

**`communication_preferences`** — Each customer's consent, per channel: order updates default ON; marketing defaults OFF until they opt in — which is what India's data-protection law (DPDP) expects.

**`support_tickets`** and **`ticket_messages`** — The complaint register and its conversation threads. Every channel — contact form, email, WhatsApp, phone, Instagram — lands in this one inbox. Each ticket has a category, priority, an assigned staff member, and a status that says *whose court the ball is in* ("pending customer" vs "pending internal"). Messages within a ticket can be marked internal — staff-only notes the customer never sees. The time-to-first-reply is recorded, because that's the one support number worth watching.

Customers open tickets at normal priority and cannot assign them, mark them resolved, or attach someone else's order. Left unchecked, every ticket arrives marked "urgent" and the priority field stops meaning anything.

**`product_enquiries`** — Sales leads, kept separate from complaints: "What's the price for 50 units?", "Can this be customised?". Each moves through new → replied → quoted → converted, and when a deal closes, the resulting order is linked back — so the store knows exactly what fraction of enquiries turn into sales.

---

## 13. Plumbing — the two registers nobody sees

These are new, and they exist because of the two ways money goes wrong at the edges of a shop: the customer's phone retries a request, or the payment provider retries a notification.

**`idempotency_keys`** — A short-lived note saying "this exact request has already been handled, and here is what we answered." A shopper who double-taps "Pay", or whose mobile connection silently resends the request, gets the original answer back instead of a second order. Entries expire after a day; they exist to absorb retries over seconds and minutes, not to be kept.

**`webhook_events`** — A record of every notification received from a payment gateway, courier, or messaging provider. These services retry until they get an acknowledgement, and are not always careful about it. Recording each one before acting on it is what makes a repeat delivery a harmless no-op rather than a second charge or a duplicate refund.

---

## 14. Running the shop

**`order_events`** — The diary of each order: every status change, note, and payment event, with who (or what) caused it. It powers both the customer's tracking timeline and the support team's view of "what exactly happened with this order".

**`reviews`** — Ratings and written reviews, moderated before they appear. Two rules are worth spelling out, because both were previously only wishes. A review starts life awaiting moderation and a customer cannot publish their own; and the "Verified buyer" badge is worked out from the linked purchase rather than being a box anyone can tick — the database checks that the purchase is genuinely theirs and genuinely for that product.

**`store_settings`** — A single-row table of store-wide switches: store name, support contacts, GST registration, free-shipping threshold, whether COD is on, and a flexible box for everything else. That flexible box is for ordinary configuration only — passwords and API keys belong in a secrets manager, not in a table every staff member can read and every backup contains in plain text.

**Scheduled housekeeping.** A handful of jobs run on a timer rather than during a deployment: returning expired stock reservations to the shelf, sweeping old guest carts, and trimming expired retry notes. The one that matters commercially is the reservation sweeper — without it, a payment abandoned at exactly the wrong moment holds a unit of stock hostage indefinitely.

---

## 15. The six rules behind the design

1. **The variant is what's sold.** A product is the poster; a variant is the box on the shelf. Carts, orders, and stock always deal in variants — never in products directly.

2. **Orders remember everything.** Names, SKUs, and prices are copied onto the order at purchase time. A paper bill doesn't change when the price board does; neither do these.

3. **Money lives in ledgers.** Stock, wallet credit, and gift-card balances are all sums of entries, never numbers typed in by hand. Ledgers can be audited; overwritten numbers can't.

4. **Invoices are permanent.** Numbered without gaps, never edited, never deleted. Mistakes get a credit note, not an eraser.

5. **History is sacred.** Order events, audit logs, price history, message logs — the database is designed so that "what happened?" always has an answer.

6. **The database enforces its own rules.** This is the one that changed most. A rule written only in the application's code is a rule that holds until someone writes a second program, runs a quick fix by hand, or clicks something unexpected in an admin panel. So the rules that cost money now live in the database itself: stock cannot go negative, a coupon cannot exceed its limit, a permanent register cannot be edited by anyone at all — not staff, not the admin dashboard, not a script with full access. The point of putting a rule here rather than in code is that it then applies to programs nobody has written yet.

These rules are tested rather than asserted. Running `make test` performs thirty-eight checks that each *try* to break one of them — overselling, reusing a spent coupon, editing an invoice, publishing an unapproved review — and confirms the database says no.

---

# Part II — Using the database

*Everything above is the tour. This part is the manual, and it does assume you write code.*

The recurring theme: this database refuses things. That is the point of it, but it means the order you do things in matters, and a few operations that look obvious are wrong. Each section below shows the working version.

---

## 16. Getting set up

```sh
make verify    # apply every migration to a throwaway container
make test      # then run the 38 invariant checks
make seed      # then load a demo catalogue
make psql      # open a shell on it
```

Deploying for real is the Supabase CLI:

```sh
supabase db push
```

Then load the scheduled jobs once — they are **not** migrations, and pushing them repeatedly is harmless but pointless:

```sh
psql "$DATABASE_URL" -f supabase/jobs/retention.sql
```

---

## 17. Two doors, and which one to use

Everything reaches this database through one of two doors, and choosing wrongly is the most common way to create a security hole.

| | Browser (anon / authenticated key) | Server (service key) |
|---|---|---|
| Row Level Security | **applies** | **bypassed entirely** |
| Safe for | reading the catalogue, reading your own orders, editing your own profile, writing a cart | everything involving money or stock |
| Never use for | anything where the client picks a price, a status, or a quantity that costs money | anything reachable directly from a browser |

The rule in one line: **if getting it wrong costs money, it happens on the server.**

Order creation, payment capture, invoice issuing, coupon validation, gift-card redemption and stock movement are all server-side. Not because the browser policies are weak, but because those operations need to read prices the client must not choose.

A useful consequence: you can hand the browser the anon key with confidence, because a customer literally cannot insert an approved review or a pre-refunded return. §24 lists what it will refuse.

---

## 18. Creating a product

Four steps, and step three has a trap.

```sql
-- 1. The product family
insert into products (id, category_id, brand, name, slug, hsn_code, gst_rate, status)
values ('...', '...', 'Apple', 'MacBook Air', 'macbook-air', '8471', 18.00, 'draft')
returning id;

-- 2. The questions and their answers.
--    product_option_values carries product_id: that is what makes it
--    impossible to attach this option to a different product later.
insert into product_options (id, product_id, name, position)
values ('opt-colour', 'prod-mba', 'Colour', 0);

insert into product_option_values (id, option_id, product_id, value, position)
values ('val-midnight', 'opt-colour', 'prod-mba', 'Midnight', 0);

-- 3. The sellable unit. Note stock is NOT set here -- see step 4.
insert into product_variants
  (id, product_id, sku, title, specs, price, compare_at_price, cost_price,
   weight_grams, is_default)
values ('var-1', 'prod-mba', 'MBA-M3-16-512-MID', 'M3 / 16GB / 512GB / Midnight',
        '{"chip":"M3","ram_gb":16,"ssd_gb":512}'::jsonb,
        134900, 149900, 98000, 1240, true);
```

**The trap.** Attach a variant's option values in **one statement**, not several:

```sql
-- RIGHT
insert into variant_option_values (variant_id, option_value_id, product_id) values
  ('var-1', 'val-m3',       'prod-mba'),
  ('var-1', 'val-16gb',     'prod-mba'),
  ('var-1', 'val-midnight', 'prod-mba');
```

The database computes each variant's "fingerprint" — the sorted list of its option values — once per statement, and uses it to reject two variants claiming the same combination. Insert the rows one at a time and the half-built fingerprint of the variant you are creating can collide with the finished fingerprint of one that already exists, and you get a duplicate-key error that makes no sense. One statement per variant, and it never happens.

Publishing is a separate step, on purpose. A `draft` product and its variants are invisible to the storefront — the `storefront_variants` view checks the *product's* status, not just the variant's:

```sql
update products set status = 'active' where id = 'prod-mba';
```

---

## 19. Stock: never write the number

```sql
-- WRONG. There is a stock column, and updating it is always a bug.
update product_variants set stock = stock + 50 where id = 'var-1';

-- RIGHT. Write the ledger; the trigger updates the cached number.
insert into inventory_movements (variant_id, quantity, reason, note, created_by)
values ('var-1', 50, 'purchase', 'PO-2026-114', 'staff-uuid');
```

Corrections are new entries, never edits — the ledger physically refuses `UPDATE` and `DELETE`, for every role including the service key:

```sql
insert into inventory_movements (variant_id, quantity, reason, note)
values ('var-1', -2, 'adjustment', 'stock count 2026-08-01: two units unaccounted for');
```

---

## 20. Taking an order

The whole sequence, in **one transaction**. Every step matters, and the order of the first two is not negotiable.

```sql
begin;

-- 1. Claim the idempotency key FIRST. If this returns no row, this exact
--    request has already been handled: fetch the stored response and return
--    it instead of doing any of the following.
insert into idempotency_keys (key, scope, request_hash, customer_id)
values ($1, 'checkout', $2, $3)
on conflict (key) do nothing
returning key;

-- 2. Reserve the stock. Negative quantity, and expires_at is mandatory --
--    a hold nothing ever releases strands that unit forever.
--    If stock is insufficient, CHECK (stock >= 0) fails here and the whole
--    transaction rolls back. That IS the oversell guard.
insert into inventory_movements (variant_id, quantity, reason, expires_at)
values ('var-1', -1, 'reservation', now() + interval '15 minutes')
returning id;                          -- keep this: it is the reservation id

-- 3. The order. order_number defaults from next_order_number().
--    email is required even for guests, so the order stays contactable.
--    The totals must balance or the insert is refused.
insert into orders (customer_id, email, phone, subtotal, discount_total,
                    shipping_total, tax_total, grand_total,
                    coupon_code, shipping_address)
values ($1, 'buyer@example.com', '+919876543210',
        134900, 13490, 0, 21854, 143264,
        'DIWALI20', $2::jsonb)
returning id, order_number;

-- 4. Line items. Do NOT insert line_total -- it is generated.
insert into order_items (order_id, variant_id, product_name, variant_title,
                         sku, unit_price, quantity)
values ('ord-1', 'var-1', 'MacBook Air', 'M3 / 16GB / 512GB / Midnight',
        'MBA-M3-16-512-MID', 134900, 1);

-- 5. Record the coupon use. This trigger increments the counter and
--    refuses the redemption if it would exceed either limit.
insert into discount_redemptions (discount_id, order_id, customer_id, amount)
values ('disc-diwali', 'ord-1', $1, 13490);

-- 6. Queue the confirmation in the same transaction as the order.
--    If the email provider is down, the row simply stays 'queued'.
insert into message_log (customer_id, order_id, channel, template, recipient, payload)
values ($1, 'ord-1', 'email', 'order_confirmation', 'buyer@example.com', $3::jsonb);

-- 7. Store the response so a retry of step 1 can replay it.
update idempotency_keys
set response_status = 201, response_body = $4::jsonb, completed_at = now()
where key = $1;

commit;
```

**On payment capture**, convert the hold into a sale. Two rows, because the reservation already took the stock down and the ledger must stay honest about what happened:

```sql
begin;
-- Give back the hold. reservation_id consumes it -- and can only ever
-- consume it once, so a double release is impossible.
insert into inventory_movements (variant_id, quantity, reason, order_id, reservation_id)
values ('var-1', 1, 'release', 'ord-1', 'res-1');

-- Then take it as a sale.
insert into inventory_movements (variant_id, quantity, reason, order_id)
values ('var-1', -1, 'sale', 'ord-1');

update payments set status = 'captured' where id = 'pay-1';
update orders   set status = 'paid'     where id = 'ord-1';

insert into order_events (order_id, event, from_status, to_status, actor_type)
values ('ord-1', 'payment_captured', 'pending', 'paid', 'system');
commit;
```

**On payment failure**, release only:

```sql
insert into inventory_movements (variant_id, quantity, reason, order_id, reservation_id)
values ('var-1', 1, 'release', 'ord-1', 'res-1');
```

And if your worker dies before doing either, `release_expired_reservations()` does it for you on its next run. That is the entire reason `expires_at` is mandatory.

---

## 21. Receiving a webhook

Record first, act second. Gateways retry until they get a 2xx, and cheerfully send the same event twice.

```sql
insert into webhook_events (provider, event_id, event_type, payload, signature_verified)
values ('razorpay', $1, 'payment.captured', $2::jsonb, true)
on conflict (provider, event_id) do nothing
returning id;
```

No row back means you have already processed this event — acknowledge with a 200 and do nothing else. A row means it is genuinely new; do the work, then:

```sql
update webhook_events set processed_at = now() where id = $1;
```

Verify the provider's signature *before* the insert, and record the result. An unverified callback that reached your handler is worth knowing about.

---

## 22. Issuing a GST invoice

The number and the invoice must be created in the **same transaction**. That is what makes the numbering gap-free: a rollback takes the number back with it.

```sql
begin;

select next_invoice_number();          -- 'INV/2026-27/00042', current FY

insert into invoices (invoice_number, order_id, customer_name, customer_gstin,
                      billing_address, seller_gstin, place_of_supply,
                      taxable_value, cgst_total, sgst_total, igst_total, grand_total)
values ('INV/2026-27/00042', 'ord-1', 'Priya S', null,
        $1::jsonb, '29ABCDE1234F1Z5', '29',
        121410, 10927, 10927, 0, 143264);

insert into invoice_lines (invoice_id, description, hsn_code, quantity, unit_price,
                           taxable_value, gst_rate, cgst_amount, sgst_amount,
                           igst_amount, line_total)
values ('inv-1', 'MacBook Air M3 16GB 512GB Midnight', '8471', 1, 134900,
        121410, 18.00, 10927, 10927, 0, 143264);

commit;
```

The database checks the tax arithmetic: CGST must equal SGST, IGST cannot coexist with them, and the totals must add up. Compare `place_of_supply` against `store_settings.seller_state_code` to decide which pair to use — same state means CGST+SGST, different means IGST.

Getting one wrong is not fixable. Issue a credit note against it:

```sql
insert into invoices (invoice_number, order_id, kind, parent_invoice_id, ...)
values (next_invoice_number(), 'ord-1', 'credit_note', 'inv-1', ...);
```

The only updates an invoice will accept are `pdf_url` and the e-invoicing fields, and the IRN is final once the tax portal has set it.

---

## 23. Returns, refunds, and store credit

A customer can open a return from the browser, but only in its initial state:

```sql
insert into return_requests (order_id, customer_id, reason)
values ('ord-1', $1, 'wrong_item');            -- status defaults to 'requested'

-- order_id is required here so the composite key can prove this line item
-- belongs to this return's order.
insert into return_items (return_id, order_item_id, order_id, quantity)
values ('ret-1', 'oi-1', 'ord-1', 1);
```

Everything after that is staff-side. On receipt:

```sql
begin;
update return_requests
set status = 'received', resolution = 'store_credit', resolved_at = now()
where id = 'ret-1';

insert into inventory_movements (variant_id, quantity, reason, order_id, note)
values ('var-1', 1, 'return', 'ord-1', 'RMA ret-1, resalable');

-- Store credit is a ledger entry. There is no balance column to update.
insert into credit_ledger (customer_id, delta, reason, order_id, return_id, created_by)
values ($1, 134900, 'return_credit', 'ord-1', 'ret-1', 'staff-uuid');
commit;
```

Read a balance from the view, never by summing by hand:

```sql
select balance from customer_credit_balances where customer_id = $1;
```

A cash refund instead points at the original payment, because that is what the gateway refunds against:

```sql
insert into refunds (order_id, payment_id, return_id, amount, provider_ref)
values ('ord-1', 'pay-1', 'ret-1', 134900, 'rfnd_SYNTHETIC123');
```

---

## 24. Gift cards

The code is never stored, so both issuing and redeeming go through the hash:

```sql
-- Issue
insert into gift_cards (code_hash, last4, initial_balance, balance,
                        purchaser_id, recipient_email)
values (digest($1, 'sha256'), upper(right($1, 4)), 5000, 5000, $2, $3);

-- Redeem: look up by hash, server-side only
select id, balance from gift_cards
where code_hash = digest($1, 'sha256')
  and status = 'active'
  and (expires_at is null or expires_at > now());

-- Spend. balance_after must agree with the ledger or the insert is refused.
insert into gift_card_transactions (gift_card_id, order_id, delta, balance_after)
values ('gc-1', 'ord-1', -2000, 3000);
```

---

## 25. Storefront queries

The whole product page in one round trip:

```sql
select
  p.name, p.description, p.brand,
  (select jsonb_agg(jsonb_build_object(
      'name', o.name,
      'values', (select jsonb_agg(ov.value order by ov.position)
                 from product_option_values ov where ov.option_id = o.id)
    ) order by o.position)
   from product_options o where o.product_id = p.id)            as options,
  (select jsonb_agg(jsonb_build_object(
      'id', v.id, 'sku', v.sku, 'title', v.title,
      'price', v.price, 'compare_at_price', v.compare_at_price,
      'stock', v.stock, 'buyable', v.is_purchasable,
      'description', coalesce(v.description, p.description),
      'specs', v.specs,
      'option_value_ids', (select jsonb_agg(vov.option_value_id)
                           from variant_option_values vov
                           where vov.variant_id = v.id)
    ))
   from storefront_variants v where v.product_id = p.id)        as variants
from products p
where p.slug = 'macbook-air' and p.status = 'active';
```

Read variants through `storefront_variants`, not `product_variants` — the view hides `cost_price` and excludes unreleased products. The base table is staff-only and will simply return nothing to a customer.

Fuzzy search, no external infrastructure:

```sql
select id, name from products
where status = 'active' and name % $1        -- 'iphone chrger' finds 'iPhone charger'
order by similarity(name, $1) desc limit 20;
```

"Deliver to 560001?", and what it costs:

```sql
select sp.cod_allowed, sr.rate, sr.cod_surcharge, sr.delivery_days
from serviceable_pincodes sp
join shipping_rates sr on sr.zone_id = sp.zone_id and sr.is_active
where sp.pincode = '560001'
  and $1 between sr.min_weight_grams
              and coalesce(sr.max_weight_grams, 2147483647)
  and $2 >= sr.min_order_total
  and ($2 < sr.max_order_total or sr.max_order_total is null);
```

That returns at most one row — rate bands cannot overlap. If it returns none, fall back to `store_settings.flat_shipping_rate`.

---

## 26. What it will refuse, and what that means

The errors you will actually hit, and what each is telling you:

| Message contains | What went wrong |
|---|---|
| `product_variants_stock_check` | Overselling. Stock cannot go below zero — you tried to sell more than you have. |
| `orders_totals_balance` | Your arithmetic. `grand_total` must equal subtotal − discount + shipping + tax. |
| `discounts_within_max_uses` | The coupon is spent. Someone else took the last use while you were checking. |
| `is append-only` | You tried to `UPDATE` or `DELETE` a ledger. Insert a correcting entry instead. |
| `invoices are immutable` | Edit an invoice; issue a credit note. |
| `violates foreign key ... variant_option_values` | Cross-product contamination — an option value from a different product. |
| `uniq_variant_combo` | Two variants with the same option combination, **or** you inserted option values one row at a time (§18). |
| `new row violates row-level security` | The browser tried to set a column it may not choose — a review's `status`, a ticket's `priority`. Do it server-side. |
| `null value in column "id" of relation "customers"` | You created a customer without supplying `auth.uid()`. Their id *is* their login id. |
| `update or delete on table "customers" violates` | Call `anonymize_customer()` first. Deleting would destroy their store credit. |

---

## 27. Six things never to do

1. **Never `update product_variants set stock = ...`.** Write `inventory_movements`. The number is a cache.
2. **Never create an order without an idempotency key.** A double-tap becomes a double order, and you will hear about it from the customer, not your logs.
3. **Never act on a webhook before recording it.** Gateways retry; without `webhook_events` a retry captures twice.
4. **Never call `next_invoice_number()` outside the transaction that inserts the invoice.** The number leaks and the sequence gains a gap the GST rules do not permit.
5. **Never put secrets in `store_settings.config`.** Every staff member can read that table and it is in every backup in plain text.
6. **Never delete a customer.** `anonymize_customer()` scrubs the personal data and keeps the records law requires you to keep — including the money you owe them.

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
| **IRN** | Invoice Reference Number — the government's stamp on an electronically-filed invoice |
| **RMA** | Return Merchandise Authorisation — the formal return-approval process |
| **UTM tags** | Little labels in ad links (source / medium / campaign) that reveal which ad brought a buyer |
| **Outbox** | The pattern of saving a message in the database first, sending it second — so nothing is lost |
| **Idempotent** | Safe to repeat: doing it twice leaves the same result as doing it once |
| **Webhook** | A message another company's system sends yours when something happens at their end |
| **Migration** | One numbered, ordered step in building the database, so any copy can be rebuilt identically |
