import { Badge } from "@/components/ui/badge";
import { STATUS_VARIANT } from "@/constants";
import type { UserStatus } from "@/types";

export function StatusBadge({ status }: { readonly status: UserStatus }) {
  return (
    <Badge variant={STATUS_VARIANT[status]} className="gap-1.5">
      {/* bg-current picks up the variant's text color, so no per-status class. */}
      <span className="size-1.5 rounded-full bg-current" />
      {status}
    </Badge>
  );
}
