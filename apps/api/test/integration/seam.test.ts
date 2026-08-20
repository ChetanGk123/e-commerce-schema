import { beforeAll, describe, expect, test } from "bun:test";

import {
  ALLOWED_ORIGIN,
  OUTAGE_PASSWORD,
  PGRST_URL,
  STORAGE_PUBLIC_URL,
  configureEnv,
  mintToken,
  sql,
  sqlValue,
  stackIsUp,
  startKongStandIn,
} from "./harness";

/**
 * The seam. Run with `make test-api`.
 *
 * Skipped when the stack is not up, so `bun test` and CI stay green
 * without Docker -- a suite that fails on a laptop with no containers
 * gets deleted, and then none of this is tested at all.
 *
 * What belongs here and nowhere else: anything that is only true if the
 * API and the database agree. A renamed RPC parameter, a select list RLS
 * refuses, an error code that stops matching the constraint that raises
 * it. Both other suites pass while any of those is broken.
 */
const up = await stackIsUp();

if (!up) {
  console.log("[integration] stack not up -- skipping. Run `make test-api`.");
}

describe.skipIf(!up)("API <-> database seam", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  const CUSTOMER = "aaaaaaaa-0000-4000-8000-000000000001";
  const OTHER = "aaaaaaaa-0000-4000-8000-000000000002";
  const STAFF = "bbbbbbbb-0000-4000-8000-000000000001";

  beforeAll(async () => {
    const kong = startKongStandIn();
    await configureEnv(kong.url);
    ({ app } = await import("../../src/app"));

    // Identities the seed deliberately omits: they must equal
    // auth.users.id, so only something that knows the ids can make them.
    await sql(`
      insert into auth.users (id, email) values
        ('${CUSTOMER}', 'buyer@test.local'),
        ('${OTHER}',    'other@test.local'),
        ('${STAFF}',    'staff@test.local')
      on conflict (id) do nothing;

      insert into customers (id, email, full_name) values
        ('${CUSTOMER}', 'buyer@test.local', 'Buyer'),
        ('${OTHER}',    'other@test.local', 'Other')
      on conflict (id) do nothing;

      insert into staff_users (id, email, role, full_name, is_active) values
        ('${STAFF}', 'staff@test.local', 'owner', 'Owner', true)
      on conflict (id) do nothing;
    `);
  });

  const asUser = async (id: string) => ({
    Authorization: `Bearer ${await mintToken("authenticated", id)}`,
  });

  test("the storefront reads real rows, and cost_price is not among them", async () => {
    const res = await app.request("/catalog/products?limit=5");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };

    // The seed loaded a catalog. An empty list here would mean the select
    // list or RLS is wrong, and every assertion below would pass vacuously.
    expect(body.items.length).toBeGreaterThan(0);
    // Proven against a live RLS policy, not against a select list constant:
    // storefront_variants does not project it and product_variants has no
    // public policy, so the anon role cannot reach it by any route.
    expect(JSON.stringify(body)).not.toMatch(/cost/i);
  });

  test("a draft product is invisible to the storefront", async () => {
    await sql(`
      insert into products (id, name, slug, description, status)
      values ('cccccccc-0000-4000-8000-000000000001', 'Secret Prototype',
              'secret-prototype', 'unreleased', 'draft')
      on conflict (id) do nothing;
    `);
    const res = await app.request("/catalog/products?q=prototype");
    const body = (await res.json()) as { items: { slug: string }[] };
    expect(body.items.map((i) => i.slug)).not.toContain("secret-prototype");
  });

  test("checkout places a real order -- the RPC's parameters match", async () => {
    // The single highest-value assertion in this file. checkout() takes
    // eleven parameters; rename one and every other suite stays green
    // while no order can be placed at all.
    const variant = await firstSellableVariant(app);

    const res = await app.request("/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Required, and rightly: checkout claims this key in the same
        // transaction that reserves the stock.
        "Idempotency-Key": `seam-order-${crypto.randomUUID()}`,
        ...(await asUser(CUSTOMER)),
      },
      body: JSON.stringify({
        items: [{ variant_id: variant, quantity: 1 }],
        email: "buyer@test.local",
        contact_phone: "9876543210",
        shipping_address: {
          line1: "1 Test Street",
          city: "Bengaluru",
          state: "Karnataka",
          postal_code: "560001",
          country: "IN",
        },
        payment_method: "cod",
      }),
    });

    const body = await res.json();
    expect({ status: res.status, body }).toMatchObject({ status: 201 });
    expect((body as { orderNumber: string }).orderNumber).toBeTruthy();
    expect((body as { grandTotal: number }).grandTotal).toBeGreaterThan(0);
  });

  test("ordering more than exists is refused as a mapped code, not a 500", async () => {
    const variant = await firstSellableVariant(app);
    const res = await app.request("/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `seam-oversell-${crypto.randomUUID()}`,
        ...(await asUser(CUSTOMER)),
      },
      body: JSON.stringify({
        items: [{ variant_id: variant, quantity: 99_999 }],
        email: "buyer@test.local",
        contact_phone: "9876543210",
        shipping_address: {
          line1: "1 Test Street",
          city: "Bengaluru",
          state: "Karnataka",
          postal_code: "560001",
          country: "IN",
        },
        payment_method: "cod",
      }),
    });

    // errors.ts maps this from the constraint's real message. If the
    // constraint is renamed, this is the test that notices -- the unit
    // fixtures would still pass, being copies of the old string.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).not.toBe("unmapped_db_error");
    expect(body.error.code).not.toBe("internal_error");
    expect(body.error.message).not.toMatch(/constraint|relation|violates/i);
  });

  test("one customer cannot read another's orders", async () => {
    const mine = await app.request("/orders", { headers: await asUser(CUSTOMER) });
    const theirs = await app.request("/orders", { headers: await asUser(OTHER) });
    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(200);

    const m = (await mine.json()) as { items: { id: string }[] };
    const t = (await theirs.json()) as { items: { id: string }[] };
    expect(m.items.length).toBeGreaterThan(0);
    // The customer who has not ordered sees nothing, whatever the other
    // has placed.
    expect(t.items).toHaveLength(0);
  });

  test("staff see cost_price where the storefront cannot", async () => {
    const res = await app.request("/admin/products?limit=5", {
      headers: { Authorization: `Bearer ${await mintToken("authenticated", STAFF)}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items.length).toBeGreaterThan(0);
  });

  test("a customer's token is refused by the admin surface", async () => {
    // Valid auth, no staff_users row. The 403 is the system working, and
    // it is RLS plus requireStaff agreeing -- which only a real database
    // can demonstrate.
    const res = await app.request("/admin/products", { headers: await asUser(CUSTOMER) });
    expect(res.status).toBe(403);
  });
});

/** Whatever the seed made sellable, rather than a hard-coded uuid. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function firstSellableVariant(app: any): Promise<string> {
  const list = await app.request("/catalog/products?limit=1");
  const { items } = (await list.json()) as { items: { slug: string }[] };
  const detail = await app.request(`/catalog/products/${items[0]!.slug}`);
  const product = (await detail.json()) as {
    variants: { id: string; stock: number }[];
  };
  const sellable = product.variants.find((v) => v.stock > 0) ?? product.variants[0]!;
  return sellable.id;
}

/**
 * The catalog writes, which until now did not exist: the store could be
 * read through this API and changed only in SQL.
 *
 * These belong here rather than in the unit suite because what makes them
 * correct is what the database does afterwards -- the audit row, the
 * price history, the draft staying invisible. A handler test would prove
 * only that a JSON body was accepted.
 */
describe.skipIf(!up)("catalog writes", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  const STAFF = "bbbbbbbb-0000-4000-8000-000000000001";
  let staffAuth: Record<string, string>;
  let productId: string;

  beforeAll(async () => {
    const kong = startKongStandIn();
    await configureEnv(kong.url);
    ({ app } = await import("../../src/app"));
    await sql(`
      insert into auth.users (id, email) values ('${STAFF}', 'staff@test.local')
        on conflict (id) do nothing;
      insert into staff_users (id, email, role, full_name, is_active) values
        ('${STAFF}', 'staff@test.local', 'owner', 'Owner', true)
        on conflict (id) do nothing;
    `);
    staffAuth = { Authorization: `Bearer ${await mintToken("authenticated", STAFF)}` };
  });

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...staffAuth },
      body: JSON.stringify(body),
    });

  const patch = (path: string, body: unknown) =>
    app.request(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...staffAuth },
      body: JSON.stringify(body),
    });

  test("a new product is created as a draft, whatever the caller wants", async () => {
    const res = await post("/admin/products", {
      name: "Seam Test Widget",
      slug: "seam-test-widget",
      brand: "Testco",
      description: "Created through the API, which was not possible before.",
      // Ignored: status is not an input on create.
      status: "active",
    });
    expect(res.status).toBe(201);
    productId = ((await res.json()) as { id: string }).id;

    expect(await sqlValue(`select status from products where id = '${productId}'`)).toBe("draft");
  });

  test("a draft is invisible to the storefront until it is published", async () => {
    const before = await app.request("/catalog/products?q=widget");
    const hidden = (await before.json()) as { items: { slug: string }[] };
    expect(hidden.items.map((i) => i.slug)).not.toContain("seam-test-widget");

    expect((await patch(`/admin/products/${productId}`, { status: "active" })).status).toBe(200);

    const after = await app.request("/catalog/products?q=widget");
    const shown = (await after.json()) as { items: { slug: string }[] };
    expect(shown.items.map((i) => i.slug)).toContain("seam-test-widget");
  });

  test("a variant makes it sellable, and starts with no stock", async () => {
    const res = await post(`/admin/products/${productId}/variants`, {
      sku: "SEAM-WIDGET-1",
      title: "Standard",
      price: 499,
      compare_at_price: 799,
      cost_price: 250,
    });
    expect(res.status).toBe(201);

    const variantId = ((await res.json()) as { id: string }).id;
    // inventory_movements is the source of truth; the variant is a cache
    // of it, so a brand new one is zero and takes stock through the ledger.
    expect(await sqlValue(`select stock from product_variants where id = '${variantId}'`)).toBe("0");
    expect(
      await sqlValue(`select is_purchasable from product_variants where id = '${variantId}'`),
    ).toBe("f");
  });

  test("repricing writes price history, in the same transaction", async () => {
    const variantId = await sqlValue(
      `select id from product_variants where sku = 'SEAM-WIDGET-1'`,
    );
    expect((await patch(`/admin/variants/${variantId}`, { price: 549 })).status).toBe(200);

    // The trigger, not the handler. A disputed order price has to be
    // answerable months later, and nothing in the route writes this row.
    const history = await sqlValue(
      `select count(*) from price_history where variant_id = '${variantId}'`,
    );
    expect(Number(history)).toBeGreaterThan(0);
    expect(await sqlValue(`select price from product_variants where id = '${variantId}'`)).toBe(
      "549.00",
    );
  });

  test("a duplicate slug is a 409, not a 500 quoting the index", async () => {
    const res = await post("/admin/products", {
      name: "Seam Test Widget Again",
      slug: "seam-test-widget",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).not.toMatch(/constraint|index|relation/i);
  });

  test("the price change is attributed to the staff member who made it", async () => {
    // api-plan.md rates this High: on the service key auth.uid() is null,
    // so every price edit is recorded as having been made by nobody. The
    // only thing standing between this API and that is caller.db.
    //
    // Asserted on product_variants, not products: audit_row() is attached
    // to what carries money -- variants, discounts, gift cards, staff,
    // settings -- and a product's name and description are not that.
    const variantId = await sqlValue(
      `select id from product_variants where sku = 'SEAM-WIDGET-1'`,
    );
    const attributed = await sqlValue(
      `select count(*) from audit_logs
        where table_name = 'product_variants' and record_id = '${variantId}'
          and staff_id = '${STAFF}'`,
    );
    expect(Number(attributed)).toBeGreaterThan(0);
  });

  test("a customer cannot create a product", async () => {
    const res = await app.request("/admin/products", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await mintToken("authenticated", "aaaaaaaa-0000-4000-8000-000000000001")}`,
      },
      body: JSON.stringify({ name: "Nope", slug: "nope" }),
    });
    expect(res.status).toBe(403);
  });
});

/**
 * Discounts, store settings and shipping rates -- the three surfaces that
 * `setup.md` configured by SQL at install and nothing could change since.
 *
 * Each one is here rather than in the unit suite for the same reason: the
 * rules that make them safe live in the database. The overlap constraint
 * on rate bands, the CHECK that stops a spent code being oversold, the
 * audit row on a changed GSTIN -- none of that exists in the handler.
 */
describe.skipIf(!up)("store configuration writes", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  const STAFF = "bbbbbbbb-0000-4000-8000-000000000001";
  let staffAuth: Record<string, string>;

  beforeAll(async () => {
    const kong = startKongStandIn();
    await configureEnv(kong.url);
    ({ app } = await import("../../src/app"));
    await sql(`
      insert into auth.users (id, email) values ('${STAFF}', 'staff@test.local')
        on conflict (id) do nothing;
      insert into staff_users (id, email, role, full_name, is_active) values
        ('${STAFF}', 'staff@test.local', 'owner', 'Owner', true)
        on conflict (id) do nothing;
    `);
    staffAuth = { Authorization: `Bearer ${await mintToken("authenticated", STAFF)}` };
  });

  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", ...staffAuth },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test("a discount can be created and then withdrawn", async () => {
    const created = await send("POST", "/admin/discounts", {
      code: "seamtest10",
      kind: "percent",
      value: 10,
      max_uses: 1,
    });
    expect(created.status).toBe(201);
    const d = (await created.json()) as { id: string; code: string; usedCount: number };

    // The schema upper-cases it, and citext makes the uniqueness
    // case-insensitive on top of that.
    expect(d.code).toBe("SEAMTEST10");
    expect(d.usedCount).toBe(0);

    // Same code in a different case is still the same code.
    const dupe = await send("POST", "/admin/discounts", {
      code: "SeamTest10",
      kind: "percent",
      value: 5,
    });
    expect(dupe.status).toBe(409);

    const off = await send("PATCH", `/admin/discounts/${d.id}`, { is_active: false });
    expect(off.status).toBe(200);
    expect((await off.json()) as { isActive: boolean }).toMatchObject({ isActive: false });
  });

  test("used_count cannot be set through the API", async () => {
    // The counter moves only in the transaction that redeems the code;
    // discounts_within_max_uses is what stops a single-use code being
    // claimed twice. An endpoint that could wind it back would undo that.
    const res = await send("POST", "/admin/discounts", {
      code: "seamcounter",
      kind: "fixed",
      value: 50,
      used_count: 99,
    });
    expect(res.status).toBe(201);
    expect(await sqlValue(`select used_count from discounts where code = 'SEAMCOUNTER'`)).toBe("0");
  });

  test("the GSTIN on every future invoice can be corrected, and is audited", async () => {
    const res = await send("PATCH", "/admin/settings", {
      seller_gstin: "29ABCDE1234F1Z5",
      seller_state_code: "29",
      cod_enabled: false,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      sellerGstin: "29ABCDE1234F1Z5",
      codEnabled: false,
    });

    const audited = await sqlValue(
      `select count(*) from audit_logs
        where table_name = 'store_settings' and staff_id = '${STAFF}'`,
    );
    expect(Number(audited)).toBeGreaterThan(0);
  });

  test("a state code that disagrees with the GSTIN is refused before the database sees it", async () => {
    // Invoices are immutable once issued and numbered gap-free, so a
    // wrong seller state is not something a later edit repairs.
    const res = await send("PATCH", "/admin/settings", {
      seller_gstin: "29ABCDE1234F1Z5",
      seller_state_code: "07",
    });
    expect(res.status).toBe(400);
  });

  test("an overlapping rate band is refused by the exclusion constraint", async () => {
    const zone = await send("POST", "/admin/shipping/zones", {
      name: `Seam Zone ${crypto.randomUUID().slice(0, 8)}`,
    });
    expect(zone.status).toBe(201);
    const zoneId = ((await zone.json()) as { id: string }).id;

    const first = await send("POST", "/admin/shipping/rates", {
      zone_id: zoneId,
      min_weight_grams: 0,
      max_weight_grams: 1000,
      rate: 60,
    });
    expect(first.status).toBe(201);

    // Straddles the first band. rates_no_overlap is a GiST exclusion
    // constraint, so this is refused by the database, not by the handler.
    const clash = await send("POST", "/admin/shipping/rates", {
      zone_id: zoneId,
      min_weight_grams: 500,
      max_weight_grams: 2000,
      rate: 90,
    });
    expect(clash.status).toBe(409);
    const body = (await clash.json()) as { error: { message: string } };
    expect(body.error.message).not.toMatch(/constraint|gist|exclude/i);

    // Retiring the first one makes room, which is the documented way to
    // replace a band.
    const rateId = ((await first.json()) as { id: string }).id;
    expect((await send("PATCH", `/admin/shipping/rates/${rateId}`, { is_active: false })).status).toBe(200);
    const replacement = await send("POST", "/admin/shipping/rates", {
      zone_id: zoneId,
      min_weight_grams: 500,
      max_weight_grams: 2000,
      rate: 90,
    });
    expect(replacement.status).toBe(201);
  });

  test("adding a pincode makes it serviceable to the storefront", async () => {
    const zone = await send("POST", "/admin/shipping/zones", {
      name: `Seam Pin Zone ${crypto.randomUUID().slice(0, 8)}`,
    });
    const zoneId = ((await zone.json()) as { id: string }).id;
    await send("POST", "/admin/shipping/rates", {
      zone_id: zoneId,
      min_weight_grams: 0,
      rate: 75,
      delivery_days: 4,
    });

    // Unlisted means unserviceable: checkout refuses it outright.
    const before = await app.request("/shipping/quote?pincode=799001&weight_grams=500&order_total=500");
    expect((await before.json()) as { serviceable: boolean }).toMatchObject({ serviceable: false });

    const put = await send("PUT", "/admin/shipping/pincodes/799001", {
      zone_id: zoneId,
      cod_allowed: true,
      courier: "Seam Couriers",
    });
    expect(put.status).toBe(200);

    const after = await app.request("/shipping/quote?pincode=799001&weight_grams=500&order_total=500");
    expect((await after.json()) as { serviceable: boolean; rate: number }).toMatchObject({
      serviceable: true,
      rate: 75,
    });
  });
});

/**
 * The end of the order lifecycle, which did not previously have one.
 *
 * The interesting case is partial fulfilment: an order shipped in two
 * parcels must not tell the customer it arrived when the first one
 * lands. That rule lives in admin_update_shipment(), counts rows in
 * another table, and cannot be asserted anywhere but here.
 */
describe.skipIf(!up)("delivery closes the order", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  const STAFF = "bbbbbbbb-0000-4000-8000-000000000001";
  const BUYER = "aaaaaaaa-0000-4000-8000-000000000001";
  let staffAuth: Record<string, string>;

  beforeAll(async () => {
    const kong = startKongStandIn();
    await configureEnv(kong.url);
    ({ app } = await import("../../src/app"));
    await sql(`
      insert into auth.users (id, email) values
        ('${STAFF}', 'staff@test.local'), ('${BUYER}', 'buyer@test.local')
        on conflict (id) do nothing;
      insert into customers (id, email, full_name) values
        ('${BUYER}', 'buyer@test.local', 'Buyer') on conflict (id) do nothing;
      insert into staff_users (id, email, role, full_name, is_active) values
        ('${STAFF}', 'staff@test.local', 'owner', 'Owner', true)
        on conflict (id) do nothing;

      -- The settings block above switches COD off store-wide, and these
      -- orders pay by COD. Asserted independently of test order rather
      -- than by hoping this file keeps running top to bottom.
      update store_settings set cod_enabled = true where id = 1;
    `);
    staffAuth = { Authorization: `Bearer ${await mintToken("authenticated", STAFF)}` };
  });

  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", ...staffAuth },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /** A paid order with two line items, so it can be shipped in two parcels. */
  async function paidOrderWithTwoItems(): Promise<{ orderId: string; itemIds: string[] }> {
    const list = await app.request("/catalog/products?limit=1");
    const { items } = (await list.json()) as { items: { slug: string }[] };
    const detail = await app.request(`/catalog/products/${items[0]!.slug}`);
    const product = (await detail.json()) as { variants: { id: string; stock: number }[] };
    const sellable = product.variants.filter((v) => v.stock > 1).slice(0, 2);
    expect(sellable.length).toBeGreaterThan(1);

    const res = await app.request("/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `deliver-${crypto.randomUUID()}`,
        Authorization: `Bearer ${await mintToken("authenticated", BUYER)}`,
      },
      body: JSON.stringify({
        items: sellable.map((v) => ({ variant_id: v.id, quantity: 1 })),
        email: "buyer@test.local",
        contact_phone: "9876543210",
        shipping_address: {
          line1: "1 Test Street",
          city: "Bengaluru",
          state: "Karnataka",
          postal_code: "560001",
          country: "IN",
        },
        payment_method: "cod",
      }),
    });
    expect(res.status).toBe(201);
    // orderId, not id -- the checkout response names it for what it is.
    const orderId = ((await res.json()) as { orderId: string }).orderId;

    // COD is captured by staff, which is what makes the order shippable.
    // The key is required here, not optional: capturing twice would take
    // the stock twice.
    const captured = await app.request(`/admin/orders/${orderId}/capture-cod`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `capture-${crypto.randomUUID()}`,
        ...staffAuth,
      },
    });
    expect(captured.status).toBe(200);

    const ids = await sqlValue(
      `select string_agg(id::text, ',') from order_items where order_id = '${orderId}'`,
    );
    return { orderId, itemIds: ids.split(",") };
  }

  test("one parcel of two does not mark the order delivered", async () => {
    const { orderId, itemIds } = await paidOrderWithTwoItems();

    const first = await send("POST", `/admin/orders/${orderId}/shipments`, {
      items: [{ order_item_id: itemIds[0], quantity: 1 }],
      carrier: "Seam Couriers",
    });
    expect(first.status).toBe(201);
    const second = await send("POST", `/admin/orders/${orderId}/shipments`, {
      items: [{ order_item_id: itemIds[1], quantity: 1 }],
      carrier: "Seam Couriers",
    });
    expect(second.status).toBe(201);

    const firstId = ((await first.json()) as { id: string }).id;
    const secondId = ((await second.json()) as { id: string }).id;

    const one = await send("PATCH", `/admin/shipments/${firstId}`, { status: "delivered" });
    expect(one.status).toBe(200);
    // Half the order is still in transit. Telling the customer it arrived
    // would be a lie, and the kind that generates a support ticket.
    expect((await one.json()) as { orderStatus: string }).toMatchObject({
      orderStatus: "shipped",
    });

    const two = await send("PATCH", `/admin/shipments/${secondId}`, { status: "delivered" });
    expect((await two.json()) as { orderStatus: string }).toMatchObject({
      orderStatus: "delivered",
    });

    expect(await sqlValue(`select status from orders where id = '${orderId}'`)).toBe("delivered");
    expect(
      await sqlValue(
        `select count(*) from order_events where order_id = '${orderId}' and event = 'delivered'`,
      ),
    ).toBe("1");
    expect(
      await sqlValue(`select delivered_at is not null from shipments where id = '${secondId}'`),
    ).toBe("t");
  });

  test("the customer sees the delivery on their own order", async () => {
    const mine = await app.request("/orders", {
      headers: { Authorization: `Bearer ${await mintToken("authenticated", BUYER)}` },
    });
    const body = (await mine.json()) as { items: { status: string }[] };
    expect(body.items.some((o) => o.status === "delivered")).toBe(true);
  });

  test("repeating a status is a no-op, not an error", async () => {
    // A courier webhook redelivering "delivered" is the ordinary case.
    const shipmentId = await sqlValue(
      `select id from shipments where status = 'delivered' order by updated_at desc limit 1`,
    );
    const again = await send("PATCH", `/admin/shipments/${shipmentId}`, { status: "delivered" });
    expect(again.status).toBe(200);

    const orderId = await sqlValue(`select order_id from shipments where id = '${shipmentId}'`);
    // Still exactly one timeline entry: a duplicate would show the
    // customer their order was delivered twice.
    expect(
      await sqlValue(
        `select count(*) from order_events where order_id = '${orderId}' and event = 'delivered'`,
      ),
    ).toBe("1");
  });
});

/**
 * The role matrix (migration 0023).
 *
 * These are the tests that justify the migration: every one of them
 * passed *before* it, because staff_all let any active staff member do
 * anything. They are written against PostgREST directly rather than
 * through the API, because that is the door the README's caveat was
 * about -- an admin UI that hides a button proves nothing when the JWT
 * works against the database on its own.
 */
describe.skipIf(!up)("staff roles are enforced by the database, not the UI", () => {
  const OWNER = "bbbbbbbb-0000-4000-8000-000000000001";
  const PACKER = "bbbbbbbb-0000-4000-8000-000000000009";
  const AGENT = "bbbbbbbb-0000-4000-8000-00000000000a";
  let pgrst: string;

  beforeAll(async () => {
    pgrst = PGRST_URL!;
    await sql(`
      insert into auth.users (id, email) values
        ('${OWNER}',  'owner@test.local'),
        ('${PACKER}', 'packer@test.local'),
        ('${AGENT}',  'agent@test.local')
        on conflict (id) do nothing;
      insert into staff_users (id, email, role, full_name, is_active) values
        ('${OWNER}',  'owner@test.local',  'owner',     'Owner',  true),
        ('${PACKER}', 'packer@test.local', 'warehouse', 'Packer', true),
        ('${AGENT}',  'agent@test.local',  'support',   'Agent',  true)
        on conflict (id) do update set role = excluded.role, is_active = true;
    `);
  });

  /** Straight at PostgREST, the way anyone holding a staff JWT can. */
  const direct = async (
    who: string,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const token = await mintToken("authenticated", who);
    return fetch(`${pgrst}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  };

  test("a packer cannot promote themselves to owner", async () => {
    // The sharp edge. Before this migration staff_all allowed it: one
    // PostgREST call, no admin UI involved, and the account came back as
    // an owner on its next request.
    const res = await direct(PACKER, `/staff_users?id=eq.${PACKER}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "owner" }),
    });
    // PostgREST reports a blocked UPDATE as "no rows matched" rather than
    // an error, so the row itself is the assertion.
    expect(await sqlValue(`select role from staff_users where id = '${PACKER}'`)).toBe("warehouse");
    expect([200, 204, 404]).toContain(res.status);
  });

  test("a packer cannot read the rest of the team", async () => {
    const res = await direct(PACKER, "/staff_users?select=id,role");
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string }[];
    // Their own row and nothing else -- requireStaff needs that one, and
    // denying it would lock every non-owner out of the admin surface.
    expect(rows.map((r) => r.id)).toEqual([PACKER]);
  });

  test("an owner still manages the team", async () => {
    const res = await direct(OWNER, "/staff_users?select=id");
    const rows = (await res.json()) as { id: string }[];
    expect(rows.length).toBeGreaterThan(1);
  });

  test("a packer cannot read anyone else's customer record", async () => {
    const res = await direct(PACKER, "/customers?select=id,email,phone");
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string }[];

    // Not zero rows: the signup trigger gives every auth.users row a
    // customers row, staff included, and own_profile_r lets anyone read
    // their own. What must not be there is anybody else -- picking needs
    // the address snapshot on the order, not every address a customer
    // has ever used, nor their phone number.
    expect(rows.every((r) => r.id === PACKER)).toBe(true);
    expect(rows.map((r) => r.id)).not.toContain("aaaaaaaa-0000-4000-8000-000000000001");
  });

  test("a support agent can, because that is the job", async () => {
    const res = await direct(AGENT, "/customers?select=id");
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBeGreaterThan(0);
  });

  test("neither a packer nor an agent can mint a gift card", async () => {
    for (const who of [PACKER, AGENT]) {
      const before = await sqlValue("select count(*) from gift_cards");
      await direct(who, "/gift_cards", {
        method: "POST",
        body: JSON.stringify({ code: `LIABILITY-${who.slice(-4)}`, initial_balance: 5000 }),
      });
      // A gift card is a liability the store has to honour.
      expect(await sqlValue("select count(*) from gift_cards")).toBe(before);
    }
  });

  test("nor change the GSTIN that goes on every invoice", async () => {
    const before = await sqlValue("select coalesce(seller_gstin, '') from store_settings where id = 1");
    await direct(PACKER, "/store_settings?id=eq.1", {
      method: "PATCH",
      body: JSON.stringify({ seller_gstin: "07AAAAA0000A1Z5" }),
    });
    expect(await sqlValue("select coalesce(seller_gstin, '') from store_settings where id = 1")).toBe(before);
  });

  test("but both can still read the settings their screens need", async () => {
    // Denying the read would break the store name and the COD flag on
    // every screen, which is the failure mode this matrix is shaped to
    // avoid.
    const res = await direct(PACKER, "/store_settings?select=store_name,cod_enabled");
    expect(((await res.json()) as unknown[]).length).toBe(1);
  });

  test("a packer still has the tables the job needs", async () => {
    for (const path of ["/orders?select=id&limit=1", "/inventory_movements?select=id&limit=1", "/shipments?select=id&limit=1"]) {
      const res = await direct(PACKER, path);
      expect(`${path}: ${res.status}`).toBe(`${path}: 200`);
    }
  });
});

/**
 * Variant configurations -- the thing README.md leads with and nothing
 * could reach. Every product created through this API was a simple one
 * with a single unconfigured variant until now.
 *
 * Two of these assert refusals that are structural rather than
 * validated: the composite foreign keys make cross-product
 * contamination impossible, and the unique index on
 * (product_id, options_signature) makes a duplicate combination
 * impossible. Neither has a line of TypeScript behind it, which is
 * exactly why they belong here.
 */
describe.skipIf(!up)("products can be configured", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  const STAFF = "bbbbbbbb-0000-4000-8000-000000000001";
  let staffAuth: Record<string, string>;
  let productId: string;
  let otherProductId: string;
  let colourValues: { id: string; value: string }[];

  beforeAll(async () => {
    const kong = startKongStandIn();
    await configureEnv(kong.url);
    ({ app } = await import("../../src/app"));
    await sql(`
      insert into auth.users (id, email) values ('${STAFF}', 'staff@test.local')
        on conflict (id) do nothing;
      insert into staff_users (id, email, role, full_name, is_active) values
        ('${STAFF}', 'staff@test.local', 'owner', 'Owner', true)
        on conflict (id) do update set role = 'owner', is_active = true;
    `);
    staffAuth = { Authorization: `Bearer ${await mintToken("authenticated", STAFF)}` };
  });

  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", ...staffAuth },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const newProduct = async (slug: string) => {
    const res = await send("POST", "/admin/products", { name: slug, slug });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  const newVariant = async (product: string, sku: string) => {
    const res = await send("POST", `/admin/products/${product}/variants`, { sku, price: 999 });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  test("an option arrives with its values in one call", async () => {
    productId = await newProduct(`configurable-${crypto.randomUUID().slice(0, 8)}`);
    const res = await send("POST", `/admin/products/${productId}/options`, {
      name: "Colour",
      values: ["Midnight", "Starlight"],
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { values: { id: string; value: string }[] };
    colourValues = body.values;
    expect(colourValues).toHaveLength(2);

    // An option with no values configures nothing, so the route refuses
    // to create one.
    const empty = await send("POST", `/admin/products/${productId}/options`, {
      name: "Size",
      values: [],
    });
    expect(empty.status).toBe(400);
  });

  test("a variant becomes a combination, and gets a signature for it", async () => {
    const variantId = await newVariant(productId, `CFG-${crypto.randomUUID().slice(0, 6)}`);
    const res = await send("PUT", `/admin/variants/${variantId}/options`, {
      option_value_ids: [colourValues[0]!.id],
    });
    expect(res.status).toBe(200);

    // Maintained by the statement trigger, not by the handler.
    const body = (await res.json()) as { optionsSignature: string | null };
    expect(body.optionsSignature).toBe(colourValues[0]!.id);
  });

  test("two variants cannot claim the same combination", async () => {
    const second = await newVariant(productId, `CFG-${crypto.randomUUID().slice(0, 6)}`);
    // The unique index on (product_id, options_signature) refuses this.
    // No application cooperation involved, which is the point.
    const clash = await send("PUT", `/admin/variants/${second}/options`, {
      option_value_ids: [colourValues[0]!.id],
    });
    expect(clash.status).toBe(409);

    // The other value is free, so the same variant configures fine.
    const ok = await send("PUT", `/admin/variants/${second}/options`, {
      option_value_ids: [colourValues[1]!.id],
    });
    expect(ok.status).toBe(200);
  });

  test("an option value from another product cannot be attached at all", async () => {
    otherProductId = await newProduct(`other-${crypto.randomUUID().slice(0, 8)}`);
    const theirs = await send("POST", `/admin/products/${otherProductId}/options`, {
      name: "Colour",
      values: ["Graphite"],
    });
    const theirValue = ((await theirs.json()) as { values: { id: string }[] }).values[0]!.id;

    const mine = await newVariant(productId, `CFG-${crypto.randomUUID().slice(0, 6)}`);
    const res = await send("PUT", `/admin/variants/${mine}/options`, {
      option_value_ids: [theirValue],
    });

    // Structurally impossible rather than validated: both composite FKs
    // must resolve to the same product_id. errors.ts already carried a
    // rule written for this exact refusal, before anything could cause it.
    expect(res.status).toBe(422);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "cross_product_option" },
    });
    expect(
      await sqlValue(`select count(*) from variant_option_values where variant_id = '${mine}'`),
    ).toBe("0");
  });

  test("the configuration shows up on the admin product detail", async () => {
    const res = await send("GET", `/admin/products/${productId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      options: { name: string; values: { value: string }[] }[];
      variants: { optionValueIds: string[] }[];
    };
    expect(body.options.map((o) => o.name)).toContain("Colour");
    expect(body.options[0]!.values.map((v) => v.value).sort()).toEqual(["Midnight", "Starlight"]);
    expect(body.variants.some((v) => v.optionValueIds.length > 0)).toBe(true);
  });

  test("clearing the combination clears the signature too", async () => {
    const variantId = await newVariant(productId, `CFG-${crypto.randomUUID().slice(0, 6)}`);
    await send("PUT", `/admin/variants/${variantId}/options`, {
      option_value_ids: [colourValues[0]!.id],
    });
    const cleared = await send("PUT", `/admin/variants/${variantId}/options`, {
      option_value_ids: [],
    });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()) as { optionsSignature: null }).toMatchObject({
      optionsSignature: null,
    });
  });
});

/**
 * Categories and collections.
 *
 * The storefront has read both since B4, from whatever setup.md seeded
 * at install; a store that started selling something new could not file
 * it anywhere. The cycle guard (migration 0024) is here rather than in
 * the route for the usual reason -- the categories in this store were
 * created in psql, and a guard the API holds is a guard psql does not.
 */
describe.skipIf(!up)("a catalog can be organised", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  const STAFF = "bbbbbbbb-0000-4000-8000-000000000001";
  let staffAuth: Record<string, string>;

  beforeAll(async () => {
    const kong = startKongStandIn();
    await configureEnv(kong.url);
    ({ app } = await import("../../src/app"));
    await sql(`
      insert into auth.users (id, email) values ('${STAFF}', 'staff@test.local')
        on conflict (id) do nothing;
      insert into staff_users (id, email, role, full_name, is_active) values
        ('${STAFF}', 'staff@test.local', 'owner', 'Owner', true)
        on conflict (id) do update set role = 'owner', is_active = true;
    `);
    staffAuth = { Authorization: `Bearer ${await mintToken("authenticated", STAFF)}` };
  });

  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", ...staffAuth },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const uniq = () => crypto.randomUUID().slice(0, 8);

  test("a category tree can be built, and cannot eat itself", async () => {
    const parent = await send("POST", "/admin/categories", {
      name: "Laptops",
      slug: `laptops-${uniq()}`,
    });
    expect(parent.status).toBe(201);
    const parentId = ((await parent.json()) as { id: string }).id;

    const child = await send("POST", "/admin/categories", {
      name: "Ultrabooks",
      slug: `ultrabooks-${uniq()}`,
      parent_id: parentId,
    });
    expect(child.status).toBe(201);
    const childId = ((await child.json()) as { id: string }).id;

    // A -> B -> A. categories_no_self_parent never saw this one: it only
    // stops a category being its own direct parent.
    const cycle = await send("PATCH", `/admin/categories/${parentId}`, {
      parent_id: childId,
    });
    expect(cycle.status).toBe(422);
    expect((await cycle.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "category_cycle" },
    });

    // The tree is untouched by the attempt.
    expect(await sqlValue(`select coalesce(parent_id::text, '') from categories where id = '${parentId}'`)).toBe("");
  });

  test("a category can be moved back to the top level", async () => {
    const top = await send("POST", "/admin/categories", { name: "Audio", slug: `audio-${uniq()}` });
    const topId = ((await top.json()) as { id: string }).id;
    const leaf = await send("POST", "/admin/categories", {
      name: "Headphones",
      slug: `headphones-${uniq()}`,
      parent_id: topId,
    });
    const leafId = ((await leaf.json()) as { id: string }).id;

    // null is a value here, not an absent field -- the usual "drop
    // undefined" filter would silently ignore it.
    const moved = await send("PATCH", `/admin/categories/${leafId}`, { parent_id: null });
    expect(moved.status).toBe(200);
    expect((await moved.json()) as { parentId: null }).toMatchObject({ parentId: null });
  });

  test("a collection's membership is set as a whole, in order", async () => {
    const created = await send("POST", "/admin/collections", {
      name: "Festive Picks",
      slug: `festive-${uniq()}`,
    });
    expect(created.status).toBe(201);
    const collectionId = ((await created.json()) as { id: string }).id;

    const products = (
      (await (await app.request("/catalog/products?limit=3")).json()) as {
        items: { id: string }[];
      }
    ).items.map((p) => p.id);
    expect(products.length).toBeGreaterThan(1);

    const set = await send("PUT", `/admin/collections/${collectionId}/products`, {
      product_ids: products,
    });
    expect(set.status).toBe(200);

    // The array index is the position, so this is also how it is sorted.
    expect(
      await sqlValue(
        `select string_agg(product_id::text, ',' order by position)
           from collection_products where collection_id = '${collectionId}'`,
      ),
    ).toBe(products.join(","));

    // Reversing the array reorders it, without a second endpoint.
    await send("PUT", `/admin/collections/${collectionId}/products`, {
      product_ids: [...products].reverse(),
    });
    expect(
      await sqlValue(
        `select string_agg(product_id::text, ',' order by position)
           from collection_products where collection_id = '${collectionId}'`,
      ),
    ).toBe([...products].reverse().join(","));
  });

  test("hiding a collection takes it off the storefront without deleting it", async () => {
    const created = await send("POST", "/admin/collections", {
      name: "Staff Only",
      slug: `staff-only-${uniq()}`,
    });
    const { id, slug } = (await created.json()) as { id: string; slug: string };

    const visible = (await (await app.request("/catalog/collections")).json()) as {
      items: { slug: string }[];
    };
    expect(visible.items.map((c) => c.slug)).toContain(slug);

    expect((await send("PATCH", `/admin/collections/${id}`, { is_active: false })).status).toBe(200);

    // public_read on collections is gated on is_active, so this is RLS
    // hiding it rather than a filter in the handler.
    const after = (await (await app.request("/catalog/collections")).json()) as {
      items: { slug: string }[];
    };
    expect(after.items.map((c) => c.slug)).not.toContain(slug);
    expect(await sqlValue(`select count(*) from collections where id = '${id}'`)).toBe("1");
  });
});

/**
 * Guest order tracking.
 *
 * Guests are a supported way to buy here, and until now that was the end
 * of it: no account to sign into, no route that would answer, so the
 * order was invisible to the person who placed it the moment they closed
 * the confirmation email.
 *
 * The scoping is in the query rather than in RLS -- a guest order has no
 * customer_id, so no policy could grant it -- which makes "does the match
 * actually require both halves" a question only a real database answers.
 */
describe.skipIf(!up)("a guest can find their own order", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  const GUEST_EMAIL = "guest-tracker@test.local";
  let orderNumber: string;

  beforeAll(async () => {
    const kong = startKongStandIn();
    await configureEnv(kong.url);
    ({ app } = await import("../../src/app"));
    await sql(`update store_settings set cod_enabled = true where id = 1;`);

    const list = await app.request("/catalog/products?limit=1");
    const { items } = (await list.json()) as { items: { slug: string }[] };
    const detail = await app.request(`/catalog/products/${items[0]!.slug}`);
    const product = (await detail.json()) as { variants: { id: string; stock: number }[] };
    const sellable = product.variants.find((v) => v.stock > 0)!;

    // No Authorization header at all: this is a guest checkout, which
    // writes no customers row and leaves orders.customer_id null.
    const res = await app.request("/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `guest-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        items: [{ variant_id: sellable.id, quantity: 1 }],
        email: GUEST_EMAIL,
        contact_phone: "9876543210",
        shipping_address: {
          line1: "1 Test Street",
          city: "Bengaluru",
          state: "Karnataka",
          postal_code: "560001",
          country: "IN",
        },
        payment_method: "cod",
      }),
    });
    expect(res.status).toBe(201);
    orderNumber = ((await res.json()) as { orderNumber: string }).orderNumber;
  });

  const track = (number: string, email: string) =>
    app.request(`/orders/track?order_number=${encodeURIComponent(number)}&email=${encodeURIComponent(email)}`);

  test("the order really is a guest order, with nobody to sign in as", async () => {
    // If this had a customer_id the test below would prove nothing --
    // it would just be an ordinary order read.
    expect(
      await sqlValue(`select coalesce(customer_id::text, '') from orders where order_number = '${orderNumber}'`),
    ).toBe("");
  });

  test("number plus email returns it, with the timeline", async () => {
    const res = await track(orderNumber, GUEST_EMAIL);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orderNumber: string;
      items: unknown[];
      events: unknown[];
      status: string;
    };
    expect(body.orderNumber).toBe(orderNumber);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.events.length).toBeGreaterThan(0);
  });

  test("the email is matched case-insensitively, because people type it", async () => {
    // orders.email is citext, so this costs nothing and saves a support
    // ticket from anyone whose mail client capitalised the address.
    const res = await track(orderNumber, GUEST_EMAIL.toUpperCase());
    expect(res.status).toBe(200);
  });

  test("the order number alone is not enough", async () => {
    // next_order_number() uses an ordinary sequence, so numbers are close
    // to consecutive and the next one is guessable. The email is the
    // second factor.
    const res = await track(orderNumber, "someone-else@test.local");
    expect(res.status).toBe(404);
  });

  test("a wrong email and an unknown order are indistinguishable", async () => {
    // Otherwise this is an oracle for "has this address ordered here",
    // answerable from a guessed order number.
    const wrongEmail = await track(orderNumber, "someone-else@test.local");
    const noSuchOrder = await track("ORD-0000-00000", GUEST_EMAIL);
    expect(noSuchOrder.status).toBe(wrongEmail.status);

    // Everything except requestId, which is unique per request by design
    // and is the one difference a caller is meant to see.
    const codeAndMessage = async (r: Response) => {
      const { error } = (await r.json()) as { error: { code: string; message: string } };
      return { code: error.code, message: error.message };
    };
    expect(await codeAndMessage(noSuchOrder)).toEqual(await codeAndMessage(wrongEmail));
  });

  test("no internal fields ride along", async () => {
    const body = await (await track(orderNumber, GUEST_EMAIL)).text();
    // The customer projection is deliberately a different shape from the
    // admin one: risk scores, UTM columns and internal notes are absent
    // from the select list, not filtered afterwards.
    for (const leak of ["risk_score", "riskScore", "risk_flags", "utm_", "customerId"]) {
      expect(body).not.toContain(leak);
    }
  });
});

/**
 * Store credit, spent.
 *
 * credit_ledger has carried an 'order_payment' reason since the
 * baseline and the table's comment has said "spend it at checkout by
 * adding a payments row with provider = 'store_credit'". Nothing did:
 * staff could grant credit, a return could resolve to it, a gift card
 * could be redeemed into it, and the customer could watch the balance
 * and never spend a rupee.
 *
 * Every assertion here needs a real database. The balance is a sum over
 * a ledger, the debit and the order have to land in one transaction, and
 * whether capture_payment() still refuses a wrong amount after the rules
 * changed is not something a handler test can answer.
 */
describe.skipIf(!up)("store credit pays for orders", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  const STAFF = "bbbbbbbb-0000-4000-8000-000000000001";
  const RICH = "aaaaaaaa-0000-4000-8000-00000000000c";
  let variantId: string;
  let unitPrice: number;

  beforeAll(async () => {
    const kong = startKongStandIn();
    await configureEnv(kong.url);
    ({ app } = await import("../../src/app"));
    await sql(`
      insert into auth.users (id, email) values
        ('${STAFF}', 'staff@test.local'), ('${RICH}', 'rich@test.local')
        on conflict (id) do nothing;
      insert into customers (id, email, full_name) values
        ('${RICH}', 'rich@test.local', 'Rich') on conflict (id) do nothing;
      insert into staff_users (id, email, role, full_name, is_active) values
        ('${STAFF}', 'staff@test.local', 'owner', 'Owner', true)
        on conflict (id) do update set role = 'owner', is_active = true;
      update store_settings set cod_enabled = true where id = 1;
    `);

    const list = await app.request("/catalog/products?limit=1");
    const { items } = (await list.json()) as { items: { slug: string }[] };
    const detail = await app.request(`/catalog/products/${items[0]!.slug}`);
    const product = (await detail.json()) as {
      variants: { id: string; stock: number; price: number }[];
    };
    const sellable = product.variants.find((v) => v.stock > 3)!;
    variantId = sellable.id;
    unitPrice = sellable.price;
  });

  const grant = (amount: number) =>
    sql(`insert into credit_ledger (customer_id, delta, reason, note)
         values ('${RICH}', ${amount}, 'goodwill', 'test grant');`);

  const balance = async () =>
    Number(
      await sqlValue(
        `select coalesce(sum(delta), 0) from credit_ledger
          where customer_id = '${RICH}' and (expires_at is null or expires_at > now())`,
      ),
    );

  const buy = async (quantity: number, useCredit: boolean) => {
    const res = await app.request("/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `credit-${crypto.randomUUID()}`,
        Authorization: `Bearer ${await mintToken("authenticated", RICH)}`,
      },
      body: JSON.stringify({
        items: [{ variant_id: variantId, quantity }],
        email: "rich@test.local",
        contact_phone: "9876543210",
        shipping_address: {
          line1: "1 Test Street",
          city: "Bengaluru",
          state: "Karnataka",
          postal_code: "560001",
          country: "IN",
        },
        payment_method: "cod",
        use_credit: useCredit,
      }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, number | string> };
  };

  test("credit is not spent unless it is asked for", async () => {
    await grant(50);
    const before = await balance();
    const { status, body } = await buy(1, false);
    expect(status).toBe(201);
    // A customer with a balance may be saving it.
    expect(body.creditApplied).toBe(0);
    expect(await balance()).toBe(before);
  });

  test("a partial balance pays part of the order, and the rest is still owed", async () => {
    const before = await balance();
    expect(before).toBeGreaterThan(0);

    const { status, body } = await buy(2, true);
    expect(status).toBe(201);
    const grand = Number(body.grandTotal);
    expect(grand).toBeGreaterThan(before);

    // Capped at the balance, not at what was asked for.
    expect(body.creditApplied).toBe(before);
    expect(await balance()).toBe(0);

    // grandTotal still states the order's full value: credit is a way of
    // paying it, not a discount on it, and the invoice has to agree.
    const orderId = body.orderId as string;
    expect(await sqlValue(`select grand_total from orders where id = '${orderId}'`)).toBe(
      grand.toFixed(2),
    );

    // The gateway is owed the difference, and that is what its row says.
    expect(
      await sqlValue(
        `select amount from payments where order_id = '${orderId}' and provider = 'cod'`,
      ),
    ).toBe((grand - before).toFixed(2));
    expect(
      await sqlValue(
        `select amount from payments where order_id = '${orderId}' and provider = 'store_credit'`,
      ),
    ).toBe(before.toFixed(2));

    // Still pending: most of it has not been paid.
    expect(await sqlValue(`select status from orders where id = '${orderId}'`)).toBe("pending");
  });

  test("the debit is on the ledger, against the order it paid for", async () => {
    const spend = await sqlValue(
      `select count(*) from credit_ledger
        where customer_id = '${RICH}' and reason = 'order_payment'
          and delta < 0 and order_id is not null`,
    );
    expect(Number(spend)).toBeGreaterThan(0);
  });

  test("credit covering the whole order pays it outright", async () => {
    // Enough for one unit, with room to spare.
    await grant(unitPrice * 5);
    const { status, body } = await buy(1, true);
    expect(status).toBe(201);

    const grand = Number(body.grandTotal);
    expect(body.creditApplied).toBe(grand);
    // No gateway involved, so there is nothing to wait for.
    expect(body.status).toBe("paid");

    const orderId = body.orderId as string;
    // paymentId points at the credit payment rather than being null:
    // there is a payment, it is just not one anybody has to go and make.
    expect(
      await sqlValue(`select provider from payments where id = '${body.paymentId}'`),
    ).toBe("store_credit");
    expect(await sqlValue(`select status from orders where id = '${orderId}'`)).toBe("paid");
    expect(
      await sqlValue(
        `select status from payments where order_id = '${orderId}' and provider = 'store_credit'`,
      ),
    ).toBe("captured");
    // No cod row at all: the gateway was never owed anything.
    expect(
      await sqlValue(`select count(*) from payments where order_id = '${orderId}' and provider = 'cod'`),
    ).toBe("0");

    // capture_payment() ran, so the reservation became a sale rather than
    // sitting until it expired.
    expect(
      await sqlValue(
        `select count(*) from inventory_movements where order_id = '${orderId}' and reason = 'sale'`,
      ),
    ).toBe("1");
  });

  test("asking to spend credit you do not have is not an error", async () => {
    // Spend whatever the test above left over, rather than assuming a
    // zero balance: the seed's prices are large, so a grant sized off one
    // of them leaves change behind.
    const left = await balance();
    if (left > 0) {
      await sql(`insert into credit_ledger (customer_id, delta, reason, note)
                 values ('${RICH}', ${-left}, 'adjustment', 'test drain');`);
    }
    expect(await balance()).toBe(0);
    const { status, body } = await buy(1, true);
    expect(status).toBe(201);
    expect(body.creditApplied).toBe(0);
    expect(body.status).toBe("pending");
  });

  test("a guest asking for credit gets none, and still checks out", async () => {
    const res = await app.request("/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `guestcredit-${crypto.randomUUID()}` },
      body: JSON.stringify({
        items: [{ variant_id: variantId, quantity: 1 }],
        email: "nobody@test.local",
        contact_phone: "9876543210",
        shipping_address: {
          line1: "1 Test Street", city: "Bengaluru", state: "Karnataka",
          postal_code: "560001", country: "IN",
        },
        payment_method: "cod",
        use_credit: true,
      }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()) as { creditApplied: number }).toMatchObject({ creditApplied: 0 });
  });
});

/**
 * The three gaps left in the account and support surfaces.
 *
 * Cancelling is the one with teeth: it releases a stock hold, and
 * whether the hold actually came back is a question only the ledger
 * answers.
 */
describe.skipIf(!up)("customers can manage their own account", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  const STAFF = "bbbbbbbb-0000-4000-8000-000000000001";
  const ME = "aaaaaaaa-0000-4000-8000-00000000000d";
  const OTHER = "aaaaaaaa-0000-4000-8000-00000000000e";
  let variantId: string;

  const auth = async (who: string) => ({
    Authorization: `Bearer ${await mintToken("authenticated", who)}`,
  });

  beforeAll(async () => {
    const kong = startKongStandIn();
    await configureEnv(kong.url);
    ({ app } = await import("../../src/app"));
    await sql(`
      insert into auth.users (id, email) values
        ('${STAFF}', 'staff@test.local'), ('${ME}', 'me@test.local'), ('${OTHER}', 'nosy@test.local')
        on conflict (id) do nothing;
      insert into customers (id, email, full_name) values
        ('${ME}', 'me@test.local', 'Me'), ('${OTHER}', 'nosy@test.local', 'Nosy')
        on conflict (id) do nothing;
      insert into staff_users (id, email, role, full_name, is_active) values
        ('${STAFF}', 'staff@test.local', 'owner', 'Owner', true)
        on conflict (id) do update set role = 'owner', is_active = true;
      update store_settings set cod_enabled = true where id = 1;
    `);

    const list = await app.request("/catalog/products?limit=1");
    const { items } = (await list.json()) as { items: { slug: string }[] };
    const detail = await app.request(`/catalog/products/${items[0]!.slug}`);
    const product = (await detail.json()) as { variants: { id: string; stock: number }[] };
    variantId = product.variants.find((v) => v.stock > 2)!.id;
  });

  const order = async () => {
    const res = await app.request("/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `cancel-${crypto.randomUUID()}`,
        ...(await auth(ME)),
      },
      body: JSON.stringify({
        items: [{ variant_id: variantId, quantity: 1 }],
        email: "me@test.local",
        contact_phone: "9876543210",
        shipping_address: {
          line1: "1 Test Street", city: "Bengaluru", state: "Karnataka",
          postal_code: "560001", country: "IN",
        },
        payment_method: "cod",
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { orderId: string };
  };

  const cancel = async (who: string, id: string) =>
    app.request(`/orders/${id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await auth(who)) },
      body: JSON.stringify({ reason: "changed my mind" }),
    });

  test("cancelling a pending order gives the stock back", async () => {
    const { orderId } = await order();
    const held = await sqlValue(
      `select count(*) from inventory_movements
        where order_id = '${orderId}' and reason = 'reservation'`,
    );
    expect(Number(held)).toBeGreaterThan(0);

    const res = await cancel(ME, orderId);
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: "cancelled" });

    // The hold is released, not merely forgotten: without this the units
    // sit unsellable until release_expired_reservations() sweeps them.
    expect(
      await sqlValue(
        `select count(*) from inventory_movements
          where order_id = '${orderId}' and reason = 'release'`,
      ),
    ).toBe(held);
  });

  test("someone else's order is a 404, not a 403", async () => {
    const { orderId } = await order();
    // 403 would confirm the id exists, which is a way to enumerate them.
    expect((await cancel(OTHER, orderId)).status).toBe(404);
    expect(await sqlValue(`select status from orders where id = '${orderId}'`)).toBe("pending");
  });

  test("a paid order is not the customer's to cancel", async () => {
    const { orderId } = await order();
    const captured = await app.request(`/admin/orders/${orderId}/capture-cod`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `cap-${crypto.randomUUID()}`,
        ...(await auth(STAFF)),
      },
    });
    expect(captured.status).toBe(200);

    // Money has changed hands; unwinding it is a refund decision with a
    // person attached, which is what the staff route is for.
    const res = await cancel(ME, orderId);
    expect(res.status).toBe(422);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "order_not_cancellable" },
    });
  });

  test("an address can be corrected without being retyped", async () => {
    const created = await app.request("/account/addresses", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await auth(ME)) },
      body: JSON.stringify({
        line1: "1 Typo Street", city: "Bengaluru", state: "Karnataka",
        postal_code: "560001", country: "IN", is_default: true,
      }),
    });
    expect(created.status).toBe(201);
    const addressId = ((await created.json()) as { id: string }).id;

    const fixed = await app.request(`/account/addresses/${addressId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await auth(ME)) },
      body: JSON.stringify({ line1: "1 Correct Street" }),
    });
    expect(fixed.status).toBe(200);
    // The default flag survives, which retyping the address would lose.
    expect((await fixed.json()) as { line1: string; isDefault: boolean }).toMatchObject({
      line1: "1 Correct Street",
      isDefault: true,
    });

    // Another customer cannot reach it, and gets 404 rather than 403.
    const theirs = await app.request(`/account/addresses/${addressId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(await auth(OTHER)) },
      body: JSON.stringify({ line1: "Mine now" }),
    });
    expect(theirs.status).toBe(404);
  });

  test("staff can open a customer, with everything the phone call needs", async () => {
    const res = await app.request(`/admin/customers/${ME}`, { headers: await auth(STAFF) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      profile: { email: string };
      addresses: unknown[];
      creditBalance: number;
      orders: { orderNumber: string }[];
    };
    expect(body.profile.email).toBe("me@test.local");
    expect(body.addresses.length).toBeGreaterThan(0);
    expect(body.orders.length).toBeGreaterThan(0);
    expect(typeof body.creditBalance).toBe("number");
  });

  test("a packer cannot open one", async () => {
    // The role matrix denies warehouse the customers table, and this
    // route reads it as the caller, so RLS answers before the handler.
    const packer = "bbbbbbbb-0000-4000-8000-000000000009";
    await sql(`
      insert into auth.users (id, email) values ('${packer}', 'packer@test.local')
        on conflict (id) do nothing;
      insert into staff_users (id, email, role, full_name, is_active) values
        ('${packer}', 'packer@test.local', 'warehouse', 'Packer', true)
        on conflict (id) do update set role = 'warehouse', is_active = true;
    `);
    const res = await app.request(`/admin/customers/${ME}`, { headers: await auth(packer) });
    expect(res.status).toBe(404);
  });
});

/**
 * Operational alerts.
 *
 * The dedupe is the part worth testing: this runs on a sixty-second
 * loop, so a condition that persists must raise once and then stay
 * quiet. Get that wrong and the notification feed becomes the outage.
 */
describe.skipIf(!up)("silent failures reach a person", () => {
  const OWNER = "bbbbbbbb-0000-4000-8000-000000000001";
  const PACKER = "bbbbbbbb-0000-4000-8000-000000000009";

  beforeAll(async () => {
    await sql(`
      insert into auth.users (id, email) values
        ('${OWNER}', 'owner@test.local'), ('${PACKER}', 'packer@test.local')
        on conflict (id) do nothing;
      insert into staff_users (id, email, role, full_name, is_active) values
        ('${OWNER}',  'owner@test.local',  'owner',     'Owner',  true),
        ('${PACKER}', 'packer@test.local', 'warehouse', 'Packer', true)
        on conflict (id) do update set role = excluded.role, is_active = true;
      delete from notifications where kind like 'ops_%';
    `);
  });

  const raise = (kind: string) =>
    sqlValue(
      `select raise_ops_alert('${kind}', 'Something is wrong', 'Details here', '{}'::jsonb)`,
    );

  const count = (kind: string) =>
    sqlValue(`select count(*) from notifications where kind = '${kind}'`);

  test("an alert reaches owners and admins, and only them", async () => {
    expect(Number(await raise("ops_test_one"))).toBeGreaterThan(0);

    // Not every staff member: an alert everyone receives is one nobody
    // owns, and a packer cannot act on a stuck payment callback anyway.
    expect(
      await sqlValue(
        `select count(*) from notifications
          where kind = 'ops_test_one' and recipient_id = '${PACKER}'`,
      ),
    ).toBe("0");
    expect(
      await sqlValue(
        `select count(*) from notifications
          where kind = 'ops_test_one' and recipient_id = '${OWNER}'`,
      ),
    ).toBe("1");
  });

  test("raising it again while it is unread says nothing", async () => {
    // This runs on a sixty-second loop. Without the cooldown a stuck
    // outbox would insert an alert per admin per tick.
    const before = await count("ops_test_one");
    expect(await raise("ops_test_one")).toBe("0");
    expect(await count("ops_test_one")).toBe(before);
  });

  test("once it has been read and the problem returns, it speaks again", async () => {
    // Read means someone looked. If the condition comes back after that
    // they need telling again -- silence would be indistinguishable from
    // the problem having been fixed.
    await sql(`update notifications set read_at = now() where kind = 'ops_test_one';`);
    expect(Number(await raise("ops_test_one"))).toBeGreaterThan(0);
  });

  test("a deactivated admin stops being told", async () => {
    await sql(`
      delete from notifications where kind = 'ops_test_two';
      update staff_users set is_active = false where id = '${OWNER}';
    `);
    const told = Number(await raise("ops_test_two"));
    await sql(`update staff_users set is_active = true where id = '${OWNER}';`);
    expect(told).toBe(0);
  });
});

/**
 * Catalog caching.
 *
 * The header is one line; the 304 is where this goes wrong quietly. Hono
 * rebuilds the response from a small allowlist of headers, so anything
 * not on that list vanishes on revalidation only -- the 200 keeps
 * working, the 304 does not, and the callers it breaks are exactly the
 * ones whose cache was working.
 */
describe.skipIf(!up)("the storefront catalog is cacheable", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeAll(async () => {
    const kong = startKongStandIn();
    await configureEnv(kong.url);
    ({ app } = await import("../../src/app"));
  });

  test("a catalog page is public and carries an ETag", async () => {
    const res = await app.request("/catalog/products?limit=5");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]+"$/);
  });

  test("the same page hashes the same twice, or no cache ever hits", async () => {
    // A digest that changes per request -- a timestamp in the body, a
    // request id echoed into it -- would leave the header in place and
    // the 304 permanently unreachable.
    const a = await app.request("/catalog/products?limit=5");
    const b = await app.request("/catalog/products?limit=5");
    expect(b.headers.get("etag")).toBe(a.headers.get("etag"));
  });

  test("If-None-Match answers 304 with no body", async () => {
    const first = await app.request("/catalog/products?limit=5");
    const tag = first.headers.get("etag")!;

    const second = await app.request("/catalog/products?limit=5", {
      headers: { "If-None-Match": tag },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    // Both are required on a 304: without Cache-Control the browser has
    // nothing to refresh the entry's lifetime with and asks again next
    // time, which is most of the saving gone.
    expect(second.headers.get("etag")).toBe(tag);
    expect(second.headers.get("cache-control")).toBe("public, max-age=60");
  });

  test("a stale ETag gets the whole body back", async () => {
    const res = await app.request("/catalog/products?limit=5", {
      headers: { "If-None-Match": '"0000000000000000000000000000000000000000"' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  test("the 304 keeps the CORS headers a browser needs to accept it", async () => {
    const headers = { Origin: ALLOWED_ORIGIN };
    const first = await app.request("/catalog/products?limit=5", { headers });
    expect(first.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);

    const second = await app.request("/catalog/products?limit=5", {
      headers: { ...headers, "If-None-Match": first.headers.get("etag")! },
    });
    expect(second.status).toBe(304);
    // Drop this and the browser rejects its own cached copy on
    // revalidation, which reads as an intermittent CORS failure.
    expect(second.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(second.headers.get("access-control-allow-credentials")).toBe("true");
    expect(second.headers.get("vary")).toMatch(/Origin/);
  });

  test("a product nobody sells is not cached as missing", async () => {
    const res = await app.request("/catalog/products/no-such-product-here");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("an order is never cacheable", async () => {
    // The catalog rule is scoped to /catalog. If it ever leaked wider,
    // this is the assertion that fails first.
    const res = await app.request("/orders", {
      headers: {
        Authorization: `Bearer ${await mintToken("authenticated", "aaaaaaaa-0000-4000-8000-000000000001")}`,
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("etag")).toBeNull();
  });
});

/**
 * Sign-in lockout.
 *
 * The IP limiter is off in this harness (RATE_LIMIT_PER_MINUTE=0), so
 * every 429 below comes from the account -- which is the whole point.
 * The attack this defends against is the one that never trips a per-IP
 * budget.
 */
describe.skipIf(!up)("an account can be locked, and only by real failures", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeAll(async () => {
    const kong = startKongStandIn();
    await configureEnv(kong.url);
    ({ app } = await import("../../src/app"));
    await sql("delete from auth_attempts");
  });

  const signIn = (email: string, password = "wrong-password") =>
    app.request("/auth/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

  const failures = (email: string) =>
    sqlValue(`select coalesce(max(failures), -1) from auth_attempts where email = '${email}'`);

  const lockedUntil = (email: string) =>
    sqlValue(`select coalesce(auth_lock_check('${email}')::text, '')`);

  test("nine wrong passwords are a bad morning; the tenth is a lockout", async () => {
    const email = "lockme@test.local";
    for (let i = 0; i < 9; i++) {
      expect((await signIn(email)).status).toBe(401);
    }
    // Still answering honestly at nine. A lockout that fires early is one
    // that fires on customers.
    expect(await lockedUntil(email)).toBe("");
    expect(Number(await failures(email))).toBe(9);

    expect((await signIn(email)).status).toBe(401);
    expect(await lockedUntil(email)).not.toBe("");

    // And the next attempt never reaches the auth service at all.
    const after = await signIn(email);
    expect(after.status).toBe(429);
    expect(((await after.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
  });

  test("locking resets the count, so one typo later does not re-lock", async () => {
    // Otherwise a fifteen-minute inconvenience becomes a permanent one for
    // anybody being targeted: the lock lifts, they mistype once, and they
    // are locked again.
    expect(Number(await failures("lockme@test.local"))).toBe(0);
  });

  test("an address with no account locks exactly the same way", async () => {
    // If it did not, the lockout would be the enumeration oracle every
    // other 401 in this service is written to avoid: ten attempts, and
    // 429-instead-of-401 tells you who banks here.
    const email = "nobody-has-this@test.local";
    for (let i = 0; i < 10; i++) await signIn(email);
    expect((await signIn(email)).status).toBe(429);
  });

  test("the lock is per address, not per attacker", async () => {
    // Twenty failures from this process did not touch a third account.
    // Said the other way round: this is the distinction the IP limiter
    // cannot make.
    const email = "untouched@test.local";
    expect(await lockedUntil(email)).toBe("");
    expect((await signIn(email)).status).toBe(401);
  });

  test("an auth service having a bad afternoon locks nobody out", async () => {
    // The dangerous failure mode. A 5xx from GoTrue is not a wrong
    // password, and counting it would lock every account that tried at
    // exactly the moment nobody can sign in anyway.
    const email = "outage@test.local";
    for (let i = 0; i < 12; i++) {
      expect((await signIn(email, OUTAGE_PASSWORD)).status).toBe(401);
    }
    expect(await failures(email)).toBe("-1");
    expect(await lockedUntil(email)).toBe("");
  });

  test("a stale run starts over rather than accumulating", async () => {
    // Two typos on Monday and two on Friday are not an attack. The window
    // is idle-based, so fifteen quiet minutes reset it.
    const email = "slowtyper@test.local";
    await signIn(email);
    await signIn(email);
    expect(Number(await failures(email))).toBe(2);

    await sql(
      `update auth_attempts set last_at = now() - interval '20 minutes' where email = '${email}'`,
    );
    await signIn(email);
    expect(Number(await failures(email))).toBe(1);
  });

  test("a completed password reset is the way out of somebody else's lockout", async () => {
    const email = "victim@test.local";
    await sql(
      `insert into auth_attempts (email, failures, locked_until)
       values ('${email}', 0, now() + interval '15 minutes')
       on conflict (email) do update
         set locked_until = excluded.locked_until, failures = 0`,
    );
    expect((await signIn(email)).status).toBe(429);

    // The route calls this once Supabase has accepted the new password.
    // That the function lifts the lock is the half that belongs here; the
    // reset flow itself needs a real GoTrue.
    await sqlValue(`select auth_clear_failures('${email}')`);
    expect(await lockedUntil(email)).toBe("");
    expect((await signIn(email)).status).toBe(401);
  });

  test("the sweeper drops what has gone quiet and keeps a live lock", async () => {
    // auth_attempts grows with the attacker's word list, so this is not
    // housekeeping -- it is what stops the defence being the exhaustion.
    await sql(`
      delete from auth_attempts;
      insert into auth_attempts (email, failures, last_at, locked_until) values
        ('old@test.local',    3, now() - interval '2 hours', null),
        ('recent@test.local', 3, now(),                      null),
        ('held@test.local',   0, now() - interval '2 hours', now() + interval '10 minutes');
    `);
    expect(await sqlValue("select sweep_auth_attempts()")).toBe("1");
    expect(
      await sqlValue("select string_agg(email, ',' order by email) from auth_attempts"),
    ).toBe("held@test.local,recent@test.local");
  });

  test("a warehouse account cannot read who is being attacked", async () => {
    // The same PII line the role matrix draws on `customers`. This is a
    // list of addresses somebody is currently trying passwords against.
    const packer = "bbbbbbbb-0000-4000-8000-000000000009";
    await sql(`
      insert into auth.users (id, email) values ('${packer}', 'packer@test.local')
        on conflict (id) do nothing;
      insert into staff_users (id, email, role, full_name, is_active) values
        ('${packer}', 'packer@test.local', 'warehouse', 'Packer', true)
        on conflict (id) do update set role = 'warehouse', is_active = true;
    `);
    const res = await fetch(`${PGRST_URL}/auth_attempts?select=email`, {
      headers: { Authorization: `Bearer ${await mintToken("authenticated", packer)}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

/**
 * Image garbage collection, layer 1 (docs/image-management.md T1).
 *
 * The premise the whole design rests on: product_images has two ON
 * DELETE CASCADE foreign keys, so image rows disappear without the API
 * ever seeing it. If a cascade did not fire a statement-level trigger
 * with a transition table, none of this would work and the objects would
 * be orphaned in silence -- so that is the first thing asserted here.
 */
describe.skipIf(!up)("deleted images queue their objects", () => {
  const PRODUCT = "11111111-0000-4000-8000-00000000ff01";
  const VARIANT = "11111111-0000-4000-8000-00000000ff02";

  const queued = async () =>
    (
      await sqlValue(
        "select coalesce(string_agg(url, ',' order by url), '') from storage_gc_queue",
      )
    )
      .split(",")
      .filter(Boolean);

  test("a cascading product delete queues every one of its images", async () => {
    await sql(`
      delete from storage_gc_queue;
      insert into products (id, slug, name, status)
        values ('${PRODUCT}', 'gc-cascade', 'GC Cascade', 'active');
      insert into product_images (product_id, url, position) values
        ('${PRODUCT}', 'https://img.test/a.jpg', 0),
        ('${PRODUCT}', 'https://img.test/b.jpg', 1),
        ('${PRODUCT}', 'https://img.test/c.jpg', 2);
    `);
    expect(await queued()).toEqual([]);

    // The delete the API cannot see. One statement, three image rows.
    await sql(`delete from products where id = '${PRODUCT}'`);

    expect(await queued()).toEqual([
      "https://img.test/a.jpg",
      "https://img.test/b.jpg",
      "https://img.test/c.jpg",
    ]);
  });

  test("a cascading variant delete queues the variant's image too", async () => {
    // The second foreign key, and the easier one to forget: deleting a
    // colourway takes its photographs with it.
    await sql(`
      delete from storage_gc_queue;
      insert into products (id, slug, name, status)
        values ('${PRODUCT}', 'gc-variant', 'GC Variant', 'active');
      insert into product_variants (id, product_id, sku, price, status)
        values ('${VARIANT}', '${PRODUCT}', 'GC-SKU-1', 100, 'active');
      insert into product_images (product_id, variant_id, url, position)
        values ('${PRODUCT}', '${VARIANT}', 'https://img.test/variant.jpg', 0);
    `);

    await sql(`delete from product_variants where id = '${VARIANT}'`);
    expect(await queued()).toEqual(["https://img.test/variant.jpg"]);

    await sql(`delete from products where id = '${PRODUCT}'`);
  });

  test("an object another row still displays is not queued", async () => {
    // Nothing forbids two rows carrying one URL, and a hand-written
    // insert in psql is how it happens. Queueing on the first delete
    // would collect a photograph still on a live product page.
    await sql(`
      delete from storage_gc_queue;
      insert into products (id, slug, name, status)
        values ('${PRODUCT}', 'gc-shared', 'GC Shared', 'active');
      insert into product_images (product_id, url, position) values
        ('${PRODUCT}', 'https://img.test/shared.jpg', 0),
        ('${PRODUCT}', 'https://img.test/shared.jpg', 1);
    `);

    await sql(`delete from product_images where product_id = '${PRODUCT}' and position = 0`);
    expect(await queued()).toEqual([]);

    // ...and queued once the last one goes.
    await sql(`delete from product_images where product_id = '${PRODUCT}'`);
    expect(await queued()).toEqual(["https://img.test/shared.jpg"]);

    await sql(`delete from products where id = '${PRODUCT}'`);
  });

  test("queueing the same object twice is one row, not two", async () => {
    await sql(`
      delete from storage_gc_queue;
      insert into products (id, slug, name, status)
        values ('${PRODUCT}', 'gc-dupe', 'GC Dupe', 'active');
      insert into product_images (product_id, url, position)
        values ('${PRODUCT}', 'https://img.test/once.jpg', 0);
    `);
    await sql(`delete from product_images where product_id = '${PRODUCT}'`);

    // Re-added and deleted again: the object still needs deleting once.
    await sql(`
      insert into product_images (product_id, url, position)
        values ('${PRODUCT}', 'https://img.test/once.jpg', 0);
      delete from product_images where product_id = '${PRODUCT}';
    `);
    expect(await sqlValue("select count(*) from storage_gc_queue")).toBe("1");

    await sql(`delete from products where id = '${PRODUCT}'`);
  });

  test("a warehouse account cannot read the backlog", async () => {
    // The same PII line drawn everywhere else: these URLs map the
    // catalog, including products deleted before they ever launched.
    const packer = "bbbbbbbb-0000-4000-8000-000000000009";
    const res = await fetch(`${PGRST_URL}/storage_gc_queue?select=url`, {
      headers: { Authorization: `Bearer ${await mintToken("authenticated", packer)}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

/**
 * Image garbage collection, layer 2 (docs/image-management.md T2).
 *
 * The queue says what to collect; this is the part that takes a batch
 * and reports back. Two things carry the risk and both are asserted:
 * claiming must cancel anything that has been referenced again since it
 * was queued, and settling must only drop a row once the object is
 * genuinely gone.
 */
describe.skipIf(!up)("the collection queue drains", () => {
  const PRODUCT = "11111111-0000-4000-8000-00000000ff03";

  const rows = () =>
    sqlValue(
      "select coalesce(string_agg(url || ':' || attempts, ',' order by url), '') from storage_gc_queue",
    );

  const claim = (limit = 50, giveUp = 20) =>
    sqlValue(
      `select coalesce(string_agg(url, ',' order by url), '') from claim_storage_gc(${limit}, ${giveUp})`,
    );

  test("claiming returns the batch and spends an attempt", async () => {
    // Incremented on claim, not on failure: a worker that dies mid-batch
    // still burns one, so a row that reliably kills the process cannot
    // be retried forever.
    await sql(`
      delete from storage_gc_queue;
      insert into storage_gc_queue (url) values
        ('https://img.test/one.jpg'), ('https://img.test/two.jpg');
    `);
    expect(await claim()).toBe("https://img.test/one.jpg,https://img.test/two.jpg");
    expect(await rows()).toBe("https://img.test/one.jpg:1,https://img.test/two.jpg:1");
  });

  test("a URL referenced again is cancelled, not collected", async () => {
    // The failure this prevents is the expensive one: an image
    // re-uploaded between the removal and the sweep would otherwise be
    // taken off a live product page by a queue row nobody remembers.
    await sql(`
      delete from storage_gc_queue;
      insert into products (id, slug, name, status)
        values ('${PRODUCT}', 'gc-claim', 'GC Claim', 'active');
      insert into storage_gc_queue (url) values ('https://img.test/rescued.jpg');
      insert into product_images (product_id, url, position)
        values ('${PRODUCT}', 'https://img.test/rescued.jpg', 0);
    `);

    expect(await claim()).toBe("");
    expect(await sqlValue("select count(*) from storage_gc_queue")).toBe("0");

    await sql(`delete from product_images where product_id = '${PRODUCT}'`);
    await sql(`delete from products where id = '${PRODUCT}'`);
  });

  test("a row that has run out of attempts is left alone, not retried", async () => {
    await sql(`
      delete from storage_gc_queue;
      insert into storage_gc_queue (url, attempts) values ('https://img.test/stuck.jpg', 20);
    `);
    expect(await claim(50, 20)).toBe("");
    // Still there, with its history intact. Nothing here throws away the
    // evidence that something has been failing.
    expect(await sqlValue("select count(*) from storage_gc_queue")).toBe("1");
  });

  test("settling gone removes the row; settling failed keeps it and says why", async () => {
    await sql(`
      delete from storage_gc_queue;
      insert into storage_gc_queue (url) values
        ('https://img.test/done.jpg'), ('https://img.test/kept.jpg');
    `);
    await sqlValue(
      `select settle_storage_gc((select id from storage_gc_queue where url = 'https://img.test/done.jpg'), true)`,
    );
    await sqlValue(
      `select settle_storage_gc((select id from storage_gc_queue where url = 'https://img.test/kept.jpg'), false, '500 storage said no')`,
    );

    expect(await sqlValue("select url from storage_gc_queue")).toBe("https://img.test/kept.jpg");
    expect(await sqlValue("select last_error from storage_gc_queue")).toBe("500 storage said no");
  });
});

/**
 * The rule the whole retry policy rests on: an object that is already
 * absent counts as collected.
 *
 * Get this wrong and a queue row retries twenty times against a key that
 * cannot be removed twice, then gives up and raises an alert about an
 * object that was gone all along.
 */
describe.skipIf(!up)("storage deletion tells apart gone from failed", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let storage: any;

  beforeAll(async () => {
    const kong = startKongStandIn();
    await configureEnv(kong.url);
    storage = await import("../../src/storage");
  });

  test("a successful delete is gone", async () => {
    expect((await storage.deleteObject("products/p/ok.jpg")).gone).toBe(true);
  });

  test("an object that was never there is also gone", async () => {
    // 404 is the desired end state, not a failure.
    expect((await storage.deleteObject("products/p/missing.jpg")).gone).toBe(true);
  });

  test("storage having a bad afternoon is not gone", async () => {
    const res = await storage.deleteObject("products/p/broken.jpg");
    expect(res.gone).toBe(false);
    // The reason has to survive into last_error, or the queue fills with
    // rows nobody can diagnose.
    expect(res.detail).toContain("500");
  });

  test("a URL from another host resolves to no object at all", async () => {
    // The sweeper settles these as done without calling storage: there is
    // nothing of ours to collect, and retrying twenty times against
    // somebody else's CDN is the wrong kind of persistence.
    expect(storage.pathFromUrl("https://someone-else.example/img.jpg")).toBeNull();
    expect(storage.pathFromUrl(`${STORAGE_PUBLIC_URL}/products/p/a.jpg`)).toBe(
      "products/p/a.jpg",
    );
  });
});
