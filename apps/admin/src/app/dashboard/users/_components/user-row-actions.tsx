"use client";

import { Eye, MoreHorizontal, Pencil, UserX } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DemoUser } from "@/types";

export function UserRowActions({ user }: { readonly user: DemoUser }) {
  return (
    <div className="text-right">
      {/* Non-modal: a modal menu marks the rest of the app aria-hidden while the
          trigger still holds focus, which the browser flags. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Open actions for ${user.name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        {/* Inert on purpose — wire these to your own mutations. */}
        <DropdownMenuContent align="end">
          <DropdownMenuItem>
            <Eye />
            View profile
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Pencil />
            Edit user
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">
            <UserX />
            Deactivate
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
