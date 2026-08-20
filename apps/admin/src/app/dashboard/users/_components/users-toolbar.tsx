"use client";
"use no memo";

import type { Table } from "@tanstack/react-table";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { USER_STATUSES } from "@/constants";
import type { DemoUser } from "@/types";

export function UsersToolbar({ table }: { readonly table: Table<DemoUser> }) {
  const search = String(table.getColumn("name")?.getFilterValue() ?? "");
  const status = String(table.getColumn("status")?.getFilterValue() ?? "all");

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Input
        className="h-8 sm:max-w-64"
        name="search"
        type="search"
        placeholder="Search name or email..."
        aria-label="Search users"
        value={search}
        onChange={(event) => table.getColumn("name")?.setFilterValue(event.target.value)}
      />
      <Select
        value={status}
        onValueChange={(value) => table.getColumn("status")?.setFilterValue(value === "all" ? undefined : value)}
      >
        <SelectTrigger className="sm:w-40" aria-label="Filter by status">
          {/* Explicit label: an empty SelectValue only fills in after hydration. */}
          <SelectValue>{status === "all" ? "All statuses" : status}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          {USER_STATUSES.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
