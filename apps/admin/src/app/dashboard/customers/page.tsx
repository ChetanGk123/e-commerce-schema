import { ROLES } from "@ecom/schema/enums";

import { api } from "@/lib/api";
import { readApiError } from "@/lib/api-error";
import { requireRole } from "@/lib/auth";
import { parseListParams } from "@/lib/list-params";

import { CustomersEmpty, CustomersError, CustomersTable } from "./_components/customers-table";

export const metadata = { title: "Customers" };

/**
 * The pattern every other list screen copies. Thin on purpose:
 *
 *   read the URL -> gate the role -> call the API -> hand rows to a component
 *
 * No client state, no useEffect, no loading flag. The page IS the query, so
 * a filtered page is a URL someone can send to a colleague, and the back
 * button works because navigation is what changed it.
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Support can read customers; warehouse cannot -- it sees no PII beyond a
  // shipping address. The nav hides this for them too, but hiding a link is
  // not a check: this is.
  await requireRole([ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER, ROLES.SUPPORT]);

  const params = parseListParams(await searchParams);

  const res = await (await api()).admin.customers.$get({
    query: {
      // Omitted rather than sent empty -- `q=""` fails the API's min(2) and
      // would 400 a page that simply has no search term.
      ...(params.q ? { q: params.q } : {}),
      // NUMBERS, not strings. The route declares these with
      // z.coerce.number(), so the inferred input type is number even though
      // they travel as query text -- tsc rejected String() here, which is
      // the typed client earning its place.
      limit: params.limit,
      offset: params.offset,
    },
  });

  if (!res.ok) {
    // The API's own words. This app does not restate them.
    return <CustomersError error={await readApiError(res)} />;
  }

  const { items, total } = await res.json();
  if (items.length === 0) return <CustomersEmpty query={params.q} />;

  return <CustomersTable items={items} total={total} params={params} />;
}
