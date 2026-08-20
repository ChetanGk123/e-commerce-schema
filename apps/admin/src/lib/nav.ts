import type { StaffRole } from "@ecom/schema/enums";

import type { NavGroup, NavMainItem } from "@/types/navigation";

/** An item with no `roles` is visible to every staff role. */
function visible(item: { roles?: readonly StaffRole[] }, role: StaffRole): boolean {
  return item.roles === undefined || item.roles.includes(role);
}

/**
 * Drop what this role may not see.
 *
 * A parent whose children are all hidden is dropped too -- an expandable
 * group that opens onto nothing is worse than no group. A parent that is
 * itself permitted keeps only the children that are.
 *
 * Pure and role-in-role-out, so it runs on either side of the boundary; the
 * sidebar is a client component and gets the role as a plain string.
 */
export function filterNavByRole(groups: readonly NavGroup[], role: StaffRole): NavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.reduce<NavMainItem[]>((kept, item) => {
        if (!visible(item, role)) return kept;

        if (!("subItems" in item) || item.subItems === undefined) {
          kept.push(item);
          return kept;
        }

        const subItems = item.subItems.filter((sub) => visible(sub, role));
        if (subItems.length > 0) kept.push({ ...item, subItems });
        return kept;
      }, []),
    }))
    .filter((group) => group.items.length > 0);
}
