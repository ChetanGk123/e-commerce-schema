"use client";
// TanStack Table v8 mutates during render, which the React Compiler must not
// memoize. Every file that touches the table instance needs this directive.
"use no memo";

import { useState } from "react";

import {
  type ColumnDef,
  type ColumnFiltersState,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type PaginationState,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";

type UseDataTableOptions<TData, TValue> = {
  readonly data: TData[];
  readonly columns: ColumnDef<TData, TValue>[];
  readonly pageSize?: number;
  readonly enableRowSelection?: boolean;
};

/** Wires the row models and state every table in this app needs. */
export function useDataTable<TData, TValue>({
  data,
  columns,
  pageSize = 10,
  enableRowSelection = false,
}: UseDataTableOptions<TData, TValue>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = useState({});
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize });

  return useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, columnVisibility, rowSelection, pagination },
    enableRowSelection,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
}
