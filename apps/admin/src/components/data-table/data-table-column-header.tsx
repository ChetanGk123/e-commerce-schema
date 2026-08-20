"use client";
"use no memo";

import type { Column } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function SortIcon({ direction }: { readonly direction: false | "asc" | "desc" }) {
  if (direction === "asc") {
    return <ArrowUp data-icon="inline-end" />;
  }

  if (direction === "desc") {
    return <ArrowDown data-icon="inline-end" />;
  }

  return <ArrowUpDown data-icon="inline-end" />;
}

type DataTableColumnHeaderProps<TData, TValue> = {
  readonly column: Column<TData, TValue>;
  readonly title: string;
  readonly className?: string;
};

export function DataTableColumnHeader<TData, TValue>({
  column,
  title,
  className,
}: DataTableColumnHeaderProps<TData, TValue>) {
  if (!column.getCanSort()) {
    return <span className={className}>{title}</span>;
  }

  const direction = column.getIsSorted();

  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("-ml-2 font-medium text-muted-foreground", className)}
      aria-label={`Sort by ${title}`}
      onClick={() => column.toggleSorting(direction === "asc")}
    >
      {title}
      <SortIcon direction={direction} />
    </Button>
  );
}
