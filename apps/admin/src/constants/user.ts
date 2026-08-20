import type { UserStatus } from "@/types";

/** Drives the status filter. Checked against UserStatus, so a typo will not compile. */
export const USER_STATUSES: UserStatus[] = ["Active", "Invited", "Suspended"];

export const STATUS_VARIANT: Record<UserStatus, "success" | "warning" | "destructive"> = {
  Active: "success",
  Invited: "warning",
  Suspended: "destructive",
};

// Locale and time zone are pinned so the server and the client render the same
// string — anything else hydrates with a mismatch.
export const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export const DEFAULT_PAGE_SIZE = 5;
