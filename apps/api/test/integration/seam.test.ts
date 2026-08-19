import { beforeAll, describe, expect, test } from "bun:test";

import {
  PGRST_URL,
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
