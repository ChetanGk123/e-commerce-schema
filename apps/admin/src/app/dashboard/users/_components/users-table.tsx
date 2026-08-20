"use client";
"use no memo";

import { DataTable } from "@/components/data-table/data-table";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { useDataTable } from "@/components/data-table/use-data-table";
import { DEFAULT_PAGE_SIZE } from "@/constants";

import { demoUsers } from "./data";
import { usersColumns } from "./users-columns";
import { UsersToolbar } from "./users-toolbar";

export function UsersTable() {
  const table = useDataTable({
    data: demoUsers,
    columns: usersColumns,
    pageSize: DEFAULT_PAGE_SIZE,
    enableRowSelection: true,
  });

  return (
    <div className="flex flex-col gap-4">
      <DataTable table={table} toolbar={<UsersToolbar table={table} />} emptyMessage="No users match these filters." />
      <DataTablePagination table={table} />
    </div>
  );
}
