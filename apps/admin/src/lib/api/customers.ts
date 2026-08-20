import { api } from "@/lib/api/client";
import { unwrap } from "@/lib/api/result";
import { type ListParams, toQuery } from "@/lib/list-params";

/**
 * Customers, as the screens ask for them.
 *
 * HOW A CALL BELOW MAPS TO AN HTTP REQUEST, since it is not obvious:
 *
 *   client.admin.customers.$get()   ->   GET /admin/customers
 *   ^^^^^^ ^^^^^ ^^^^^^^^^ ^^^^
 *   client  path  segments   verb
 *
 * `client` is a typed client built from the API's own route table, so the
 * path is written as properties rather than as a string. There is no URL to
 * mistype and no endpoint constant to keep in step: rename the route in
 * apps/api and this stops compiling.
 *
 * Each route is declared in apps/api/src/routes/ -- this one in account.ts,
 * as `listCustomers`. That declaration is also where the response shape
 * comes from, which is why nothing here says what a customer looks like.
 */
export const customersApi = {
  /** GET /admin/customers — a page of customers, newest first. */
  async list(params: ListParams) {
    const client = await api();
    const response = await client.admin.customers.$get({ query: toQuery(params) });
    return unwrap(response);
  },
};

/**
 * The row and page shapes, read back off the call above.
 *
 * Not written by hand on purpose: they resolve to the schema apps/api
 * validates with, so a field added there appears here with no edit, and one
 * removed fails the build instead of arriving as undefined at runtime.
 */
type ListOk = Extract<Awaited<ReturnType<typeof customersApi.list>>, { ok: true }>;
export type CustomerPage = ListOk["data"];
export type Customer = CustomerPage["items"][number];
