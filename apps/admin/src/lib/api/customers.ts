import { api } from "@/lib/api/client";
import { type Result, unwrap } from "@/lib/api/result";
import type { ListParams } from "@/lib/list-params";

/**
 * Customers, as the screens want to call them.
 *
 * The transport lives one layer down. A page should read as "list the
 * customers on this page", not as a query object with notes about coercion
 * and empty strings -- those are facts about HTTP, and this is where they
 * stop being the caller's problem.
 *
 * No return type is written by hand. It is inferred from the route's own zod
 * schema through AppType, so adding a column in apps/api reaches the table
 * here with no edit and removing one fails the build.
 */
export const customersApi = {
  async list(params: ListParams) {
    const res = await (await api()).admin.customers.$get({
      query: {
        // Omitted, not empty: the route requires min(2), so `q=""` would 400
        // a page that simply has no search term.
        ...(params.q ? { q: params.q } : {}),
        // Numbers, not strings. The route declares these z.coerce.number(),
        // so the inferred INPUT type is number even though they travel as
        // query text.
        limit: params.limit,
        offset: params.offset,
      },
    });
    return unwrap(res);
  },
};

/** For components that take rows as props. Inferred, never redeclared. */
type ListOk = Extract<Awaited<ReturnType<typeof customersApi.list>>, { ok: true }>;
export type CustomerPage = ListOk["data"];
export type Customer = CustomerPage["items"][number];

export type { Result };
