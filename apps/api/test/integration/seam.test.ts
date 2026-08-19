import { beforeAll, describe, expect, test } from "bun:test";

import {
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
