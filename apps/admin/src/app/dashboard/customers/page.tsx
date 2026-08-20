import { ROLES } from "@ecom/schema/enums";

import { customersApi } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { parseListParams } from "@/lib/list-params";

import { CustomersEmpty, CustomersError, CustomersTable } from "./_components/customers-table";

export const metadata = { title: "Customers" };

/**
 * The pattern every other list screen copies:
 *
 *   read the URL -> gate the role -> ask the resource -> render
 *
 * No client state, no useEffect, no loading flag. The page IS the query, so a
 * filtered page is a URL someone can send to a colleague and the back button
 * works because navigation is what changed it.
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
  const result = await customersApi.list(params);

  // The API's own words. This app does not restate them.
  if (!result.ok) return <CustomersError error={result.error} />;

  const { items, total } = result.data;
  if (items.length === 0) return <CustomersEmpty query={params.q} />;

  return <CustomersTable items={items} total={total} params={params} />;
}
