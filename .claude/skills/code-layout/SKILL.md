---
name: code-layout
description: Where every file, type, constant, and component belongs — each module in its own folder with its test and a named re-export, domain types and constants lifted to src/types and src/constants behind barrels. Use when creating a component, hook, lib module, screen, or data table; when adding a test for one; when asked to "separate", "split up", "break apart", or "refactor" a file that mixes concerns; or when setting up src/types and src/constants folders.
---

# Code layout

Two rules produce one layout.

1. **A module lives in its own folder**, holding the module, its test, and a
   one-line re-export.
2. **Domain types and constants leave the feature**, into `src/types/` and
   `src/constants/`, once a second file needs them.

A file that holds a type, a lookup map, a date formatter, three components, and
the rows they render has no seam you can point at. These rules cut it along its
real ones.

Writing new code? Read the next two sections and stop — the rest is for cleaning
up code that already mixes concerns.

## The module folder

```
src/components/user-profile-header/
  user-profile-header.tsx        the module
  user-profile-header.test.tsx   its test
  index.ts                       named re-export
```

```ts
// index.ts
export { UserProfileHeader } from "./user-profile-header";
export type { UserProfileHeaderProps } from "./user-profile-header";
```

Consumers import the folder, never deeper. The third file is what buys the short
path without filling the editor with tabs called `index.tsx`:

```ts
import { UserProfileHeader } from "@/components/user-profile-header";
```

Folder, module, and test share one kebab-case name. A `UserProfileHeader`
component becomes `user-profile-header/`, never `userProfileHeader/` — Biome's
`useFilenamingConvention` is `error` and rejects the camelCase form. Use `.tsx`
only when the file contains JSX; a hook returning no markup is `.ts`.

| Export | Folder and file | Test |
|---|---|---|
| `UserProfileHeader` | `user-profile-header/user-profile-header.tsx` | `user-profile-header.test.tsx` |
| `useDataTable` | `use-data-table/use-data-table.ts` | `use-data-table.test.ts` |
| `http` | `http/http.ts` | `http.test.ts` |

## Placement rules

Applied as you type. Following them means never needing the refactor below.

- **One exported thing per module**, named after the file. A second component in
  the file is the signal to start a new folder, not to keep scrolling.
- **A domain type goes to `src/types/<domain>.ts` the moment a second file needs
  it.** Until then it lives beside its module. Prop interfaces always stay with
  the component — they are part of its signature.
- **A lookup map, option list, formatter, or tunable goes to
  `src/constants/<domain>.ts`**, imported as `import { USER_STATUSES } from "@/constants"`.
- **Types must not import constants.** See [Dependency direction](#dependency-direction).
- **Cell renderers and list items take domain props, not framework props.**
  `<UserRowActions user={user} />`, never `row`. Keeps them testable, reusable,
  and — under the React Compiler — free of `"use no memo"`.
- **`"use no memo"` follows the table instance.** Any file touching a TanStack
  table — columns, toolbar, the table component — needs it. Files taking plain
  props do not.
- **Fixtures go in the route's `_components/data.ts`**, not `src/constants/`.

Sketch the folder list before writing the first line. For a table screen that is
`data.ts` plus a folder each for `<thing>-columns`, `<thing>-toolbar`,
`<thing>-table`, and every non-trivial cell renderer.

## Where the module-folder rule does not apply

Not style preferences. Each one breaks if you apply the rule.

**Next.js reserved filenames.** `page.tsx`, `layout.tsx`, `error.tsx`,
`loading.tsx`, `not-found.tsx`, `global-error.tsx`, `route.ts`, `icon.tsx`,
`robots.ts`, `sitemap.ts`. A folder under `app/` *is* a URL segment, so moving
`app/dashboard/page.tsx` into `app/dashboard/page/page.tsx` does not tidy
anything — it creates a route at `/dashboard/page`.

Give a page a folder by pushing its *content* down instead:

```
app/dashboard/
  page.tsx                       stays put, stays thin
  _components/
    dashboard-summary/
      dashboard-summary.tsx
      dashboard-summary.test.tsx
      index.ts
```

**`src/components/ui/`.** shadcn files the CLI writes and overwrites.
`pnpm dlx shadcn add dialog` writes `ui/dialog.tsx` flat and would clobber any
folder built around it. Never hand-edit that directory; `biome.json` excludes it.

**Data modules.** `src/types/**`, `src/constants/**`, `src/config/**`, and route
`_components/data.ts`. They are flat files behind a folder barrel — see below —
and have no behavior to test.

**Generated code.** `src/lib/api-schema.ts` is written by `pnpm generate:api` and
excluded from Biome. Restructuring it only invites the generator to undo it.

## Shared types and constants

These two are areas like any other, so they carry the same `export *` barrel —
but their children are flat files rather than module folders, because a type or a
lookup map has no behavior to test.

```
src/
  types/
    index.ts          export * from every sibling
    <domain>.ts       types and interfaces for one domain
  constants/
    index.ts          export * from every sibling
    <domain>.ts       constants for one domain
```

```ts
import { USER_STATUSES, DATE_FORMAT } from "@/constants";
import type { DemoUser, NavGroup } from "@/types";
```

### What moves, what stays

| Kind | Goes to |
|---|---|
| Domain types (`User`, `NavGroup`, status unions) | `src/types/<domain>.ts` |
| Lookup maps, option lists, formatters, tunables | `src/constants/<domain>.ts` |
| Component **prop** interfaces | stays in the module — part of its signature |
| Fixtures / seed rows | stays with the route, in `_components/data.ts` |
| Config with an existing home (`src/config/`) | stays |
| Zod schemas used for runtime validation | stays with the module that validates |

A private constant only its own module reads can still move if it is a real
tunable — a default page size, a set of options — but nothing is gained by
relocating a value with one reader and no meaning elsewhere.

### Dependency direction

Types must not import constants. Constants may import types.

The tempting `export type Status = typeof STATUSES[number]` forces `types.ts` to
import `constants.ts`, while `constants.ts` needs the type for its
`Record<Status, …>` map — a cycle. Break it by writing the union by hand and
annotating the array:

```ts
// types/user.ts
export type UserStatus = "Active" | "Invited" | "Suspended";

// constants/user.ts
import type { UserStatus } from "@/types";
export const USER_STATUSES: UserStatus[] = ["Active", "Invited", "Suspended"];
export const STATUS_VARIANT: Record<UserStatus, BadgeVariant> = { … };
```

The array is still checked member by member and the `Record` stays exhaustive.
The one thing lost is that adding a union member no longer forces the array to grow.

## Barrels

Barrels exist at two levels, and they are not the same kind of file.

| Level | File | Style | Why |
|---|---|---|---|
| **Module folder** | `user-profile-header/index.ts` | **named** re-export | It is an API boundary. `export *` republishes every helper the module happens to export, turning private details into public API and giving bundlers less to drop |
| **Area folder** | `src/hooks/index.ts` | `export *` from every child | A pure hub with nothing to hide; listing every name by hand is churn that goes stale |

### Area barrels

Every top-level area under `src/` carries one, re-exporting everything beneath it:

```
src/components/index.ts
src/hooks/index.ts
src/lib/index.ts
src/providers/index.ts
src/types/index.ts
src/constants/index.ts
src/data/index.ts
```

Each is `export *` from every child, one line per child, sorted:

```ts
// src/hooks/index.ts
export * from "./use-api";
export * from "./use-close-mobile-sidebar";
export * from "./use-mobile";
```

Consumers then reach an area, not a module:

```ts
import { useApiQuery, useIsMobile } from "@/hooks";
import { http, getHealth } from "@/lib";
```

**Nested areas nest.** `src/components/form/` and `src/components/data-table/`
each get their own `index.ts`, and the parent re-exports the child barrel rather
than reaching past it:

```ts
// src/components/index.ts
export * from "./data-table";
export * from "./error-state";
export * from "./form";
```

**`src/components/ui/` is excluded from the parent barrel.** Three reasons, all
practical: it is 61 files, so `@/components` would drag the entire shadcn kit into
any module that touched it; the shadcn CLI adds files without updating a barrel,
so the list would be stale the first time anyone runs `shadcn add`; and
`components.json` already aliases `"ui": "@/components/ui"`. Import those
directly — `@/components/ui/button` — and give `ui/` no `index.ts`.

**A route's `_components/` gets no barrel either.** It is route-local, not an
area; import each module folder directly and let the folder name document it.

### The cycle rule

**Never import a barrel that re-exports you.** This now bites at two scopes:

```ts
// inside src/components/form/form-input/form-input.tsx
import { RequiredMark } from "@/components";          // no — area barrel re-exports this file
import { RequiredMark } from "@/components/form";     // no — sub-area barrel does too
import { RequiredMark } from "../required-mark";      // yes
```

Inside an area, address siblings relatively or by full module path
(`@/lib/http`), never through the area barrel. The area barrel is for consumers
*outside* the area. Same rule one level down: a file in `user-profile-header/`
never imports `@/components/user-profile-header`.

## Tests

A colocated test is required for every module in scope, with four exceptions:

| Exempt | Why |
|---|---|
| `src/lib/env.ts` | A zod schema with defaults; the test would assert the schema equals itself |
| `src/lib/fonts.ts` | A `next/font` loader with no branch to exercise |
| `src/lib/query-client.ts` | Configuration; the behavior belongs to TanStack Query |
| Anything exporting only types | There is no runtime to run |

Everything else earns one: a component gets a render test covering its real
states — loading, empty, error, populated — and a hook or lib module gets a test
per branch.

Two references exist today, both still flat because the tree has not been
migrated: `src/lib/http.test.ts` for the lib flavor, and
`src/app/dashboard/_components/health-status.test.tsx` for the component flavor.

The test imports its sibling directly, never the barrel:

```ts
import { UserProfileHeader } from "./user-profile-header";             // yes
import { UserProfileHeader } from "@/components/user-profile-header";  // no
```

Vitest already picks these up — `vitest.config.ts` includes
`src/**/*.test.{ts,tsx}` — so nesting changes nothing.

## When to split — and when not to

Split when any of these is true:

- the file exports more than one component
- a type or constant in it is now imported by a second file
- you scroll past config and helpers to reach the render
- one concern's imports are paid by every consumer of the file

Leave it alone when:

- it exports one thing and is under ~100 lines
- the piece you would extract has exactly one caller and no meaning apart from it —
  a four-line helper used once belongs where it is used
- the only argument for splitting is a line count

Splitting costs something: more files to open, a wider import graph to hold in
your head, indirection between a module and the constant it reads. Pay it for a
real seam, not for tidiness.

## Splitting a file that mixes concerns

Cut along seams. A table screen has five:

| Seam | Module | Why it's separable |
|---|---|---|
| Presentational leaf | `status-badge` | takes a value, returns markup, no state |
| Interactive cell | `user-row-actions` | a menu with its own concerns |
| Column config | `users-columns` | data, not UI — the array everything else feeds |
| Filters / search | `users-toolbar` | own state reads, own controls |
| Composition root | `users-table` | wires the hook to the pieces |

The root should end up boring enough to read in one breath:

```tsx
export function UsersTable() {
  const table = useDataTable({
    data: demoUsers,
    columns: usersColumns,
    pageSize: DEFAULT_PAGE_SIZE,
    enableRowSelection: true,
  });

  return (
    <div className="flex flex-col gap-4">
      <DataTable table={table} toolbar={<UsersToolbar table={table} />} emptyMessage="No users match." />
      <DataTablePagination table={table} />
    </div>
  );
}
```

Two rules govern the cut itself:

- **Extract leaves first**, then the config that consumes them, then the root.
  Each step compiles on its own.
- **Watch which imports follow each piece.** If `status-badge` is the only thing
  that needed `Badge`, and `users-columns` the only thing that needed `Avatar`,
  the cut is along a real seam. A module that drags half the original import list
  with it is not — reconsider it.

A worked result, from one 186-line file:

```
src/types/user.ts          11   UserStatus, DemoUser
src/constants/user.ts      21   STATUS_VARIANT, DATE_FORMAT
_components/data.ts        57   rows only
_components/status-badge/       14 + test + index
_components/user-row-actions/   46 + test + index
_components/users-columns/      75 + test + index
_components/users-toolbar/      46 + test + index
_components/users-table/        27 + test + index   composition
```

## Procedures

Additive first, destructive last: the tree compiles after every step.

### Creating a module

1. `src/<area>/<kebab-name>/`
2. `<kebab-name>.tsx` — one exported thing, named after the file
3. `<kebab-name>.test.tsx` — written against the states it actually has
4. `index.ts` — the named re-export
5. Add `export * from "./<kebab-name>";` to the **area** barrel, in sorted order.
   Skipping this breaks nothing and silently leaves the module unreachable
   through `@/<area>`.

Consumers outside the area import `@/<area>`. Inside it, use `./sibling` or the
full `@/<area>/<kebab-name>` — never the area barrel.

### Moving a flat file into a folder

1. **Find the importers.** Grep both forms — `@/components/error-state` and
   `./error-state` both exist, and a single-pattern grep misses one.
2. **Create the folder** and move the module in. Every `./x` that pointed at a
   sibling is now `../x`.
3. **Add `index.ts`.**
4. **Repoint the importers.** With the barrel in place most paths are unchanged —
   that is what the third file buys.
5. **Add the test** if the file arrived without one.
6. **Carry directives across.** `"use client"` moves with the module; a file
   touching a TanStack Table instance keeps `"use no memo"`.
7. **Verify.**

Move one module per commit. A hundred-file rename in a single diff hides the two
lines in it that were not a rename.

### Splitting a mixed file

1. **Inventory.** List the old file's exports — that list is the checklist. Find
   every importer, including relative `./types` / `./constants` imports a
   path-alias grep will miss.
2. **Create the new folders and files**, including barrels. Delete nothing yet.
3. **Repoint imports** in every consumer from step 1.
4. **Delete the originals**, ticking off step 1's export list as each lands.
   Remove any folder left empty.
5. **Propagate directives**, as above.
6. **Verify.**
7. **Update the docs.** If `AGENTS.md` or `README.md` describe the old structure,
   fix them in the same change. Docs that contradict the tree are worse than no docs.

## Verification

Run from the repo root — a persisted `cd` into a subdirectory makes `tsc` exit 0
having checked nothing. Print `pwd` if unsure.

```bash
pnpm --filter web typecheck
pnpm -r lint
pnpm -r test
pnpm --filter web build
```

`tsc` passing is necessary, not sufficient: a moved module can type-check and
still fail at request time. Load the affected screen and confirm the moved values
arrived — a formatter still formatting, an options list still filling a dropdown,
a lookup map still picking the right variant. Check the console.

## Pitfalls

- **Scripted substitutions that delete without replacing.** A
  `perl -pi -e 's{import …}{}'` whose paired insertion does not match leaves the
  file importless, and only `tsc` catches it. Prefer per-file edits; if you
  script it, grep for the new import before moving on.
- **Barrel collisions.** `export *` from two children exporting the same name
  fails at build, and an area barrel makes this likelier because it aggregates
  far more names. Keep exported names distinct across an area.
- **Barrel cycles.** The most common mistake once area barrels exist: a file
  inside `src/lib/` importing `@/lib`, or a component inside `src/components/form/`
  importing `@/components`. Both re-enter a barrel that re-exports the importing
  file. Address siblings relatively or by full module path.
- **Adding a module without adding it to the area barrel.** The module works
  through its full path and is invisible through `@/<area>` — nothing fails, it
  is just quietly missing.
- **Renaming the folder but not the file.** `user-header/user-profile-header.tsx`
  type-checks perfectly and violates the whole rule.

## Enforcement

This skill instructs agents; it does not enforce anything. Biome cannot express
"this file must sit in a folder bearing its name". Real enforcement is a script
walking the in-scope directories, failing on:

- a module file whose parent folder has a different name
- a module folder missing `index.ts`
- a non-exempt module with no adjacent `*.test.*`
- a module `index.ts` re-exporting with `*`
- an area missing `index.ts`, or one whose children and `export *` lines have
  drifted apart in either direction
- a file importing its own folder's barrel, or any file under `src/<area>/`
  importing `@/<area>`

Wire it as a `lint` stage job in `.gitlab-ci.yml` beside `lint:web`, so the
pipeline names the violation instead of a reviewer having to.

## Conflicts

`nextjs-admin-patterns` shows `_components/` as flat files, one widget per file.
The "one widget per file" half survives intact; the flat half does not. It also
describes strict colocation — types and constants are the carve-out here.

Record both exceptions in `apps/web/AGENTS.md`, or the next agent migrates the
tree back.

## Scope

Project-scoped at `.claude/skills/code-layout/`. Copy to `~/.claude/skills/` to
apply it everywhere on the machine — but the Next.js and shadcn exceptions assume
a Next App Router app with shadcn/ui.
