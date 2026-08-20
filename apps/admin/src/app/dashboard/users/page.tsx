import type { Metadata } from "next";

import { UsersTable } from "./_components/users-table";

export const metadata: Metadata = {
  title: "Users",
};

export default function Page() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Users</h1>
        <p className="text-muted-foreground text-sm">
          A demo of <code className="text-foreground">src/components/data-table/</code> — sorting, filtering, selection,
          and pagination over placeholder rows.
        </p>
      </div>
      <UsersTable />
    </div>
  );
}
