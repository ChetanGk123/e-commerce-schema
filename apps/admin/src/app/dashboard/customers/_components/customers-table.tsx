import Link from "next/link";

import type { ApiError } from "@/lib/api-error";
import { formatDate } from "@/lib/format";
import { type ListParams, pageHref } from "@/lib/list-params";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface Customer {
  id: string;
  email: string | null;
  phone: string | null;
  fullName: string | null;
  anonymizedAt: string | null;
  createdAt: string;
}

/**
 * Server components, all three. Nothing here is interactive: paging is a
 * link, because the state is the URL.
 */

export function CustomersError({ error }: { error: ApiError }) {
  return (
    <div className="space-y-2 rounded-lg border border-destructive/40 p-6">
      <h2 className="font-medium text-destructive">Could not load customers</h2>
      {/* The API's sentence, not ours. */}
      <p className="text-muted-foreground text-sm">{error.message}</p>
      {error.requestId ? (
        // The handle into the logs. Worth showing: it is what turns "it
        // broke" into a line someone can actually find.
        <p className="text-muted-foreground text-xs">Reference: {error.requestId}</p>
      ) : null}
    </div>
  );
}

export function CustomersEmpty({ query }: { query?: string }) {
  return (
    <div className="rounded-lg border p-6">
      <p className="text-muted-foreground text-sm">
        {query ? `No customers match “${query}”.` : "No customers yet."}
      </p>
    </div>
  );
}

export function CustomersTable({
  items,
  total,
  params,
}: {
  items: Customer[];
  total: number | null;
  params: ListParams;
}) {
  const from = params.offset + 1;
  const to = params.offset + items.length;
  // A full page might be the last page. Offering "next" costs one empty
  // page; hiding it strands whoever is on the boundary.
  const hasNext = total === null ? items.length === params.limit : to < total;

  return (
    <div className="space-y-4">
      <Table>
        <TableCaption>
          {total === null ? `Showing ${from}–${to}` : `Showing ${from}–${to} of ${total}`}
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Joined</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((customer) => (
            <TableRow key={customer.id}>
              <TableCell className="font-medium">
                {customer.fullName ?? "—"}
                {customer.anonymizedAt ? (
                  // The row survives erasure; the person does not. Saying so
                  // stops someone reading blank fields as broken data and
                  // "fixing" them.
                  <Badge variant="outline" className="ml-2">
                    Erased
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell>{customer.email ?? "—"}</TableCell>
              <TableCell>{customer.phone ?? "—"}</TableCell>
              <TableCell>{formatDate(customer.createdAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="flex justify-end gap-2">
        <Button asChild variant="outline" size="sm" disabled={params.offset === 0}>
          <Link
            href={pageHref(
              "/dashboard/customers",
              params,
              Math.max(0, params.offset - params.limit),
            )}
          >
            Previous
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm" disabled={!hasNext}>
          <Link href={pageHref("/dashboard/customers", params, params.offset + params.limit)}>
            Next
          </Link>
        </Button>
      </div>
    </div>
  );
}
