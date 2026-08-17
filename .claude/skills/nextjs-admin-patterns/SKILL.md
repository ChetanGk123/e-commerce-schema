---
name: nextjs-admin-patterns
description: House conventions for Next.js App Router admin dashboards built with React 19, TypeScript strict, Tailwind CSS v4, and shadcn/ui. Use when starting a new dashboard/admin/SaaS app, adding a screen or route to one, creating a data table, form, chart card, or theme system, or deciding where a file belongs. Covers colocation folder structure, TypeScript idioms (as const unions, satisfies maps, registry types), the semantic-token design system, and server/client component segregation.
---

# Next.js Admin Dashboard Patterns

Conventions extracted from a production Next.js 16 / React 19 / Tailwind v4 / shadcn admin
template. Apply these when building or extending admin-style apps.

**Era this targets:** Next 16, React 19 (React Compiler on), Tailwind v4 (CSS-first),
TypeScript 5.9 strict, Biome 2.x, TanStack Table 8 + Query 5, zod 4, react-hook-form 7.
If the project's versions differ substantially, verify before applying version-specific
advice (`"use no memo"`, `@theme inline`, `reactCompiler`).

**Scope note.** The skill was extracted from a larger app than the template that now
carries it. Guidance about zustand stores, theme presets, `server/server-actions.ts`, and
`scripts/` codegen describes that fuller architecture — apply it only in a project that
actually has those pieces. The folder structure below is this template's, and it wins.

## The one rule that drives everything

**Colocate until reuse forces you out.** Feature code lives next to the route that owns
it. Nothing moves to a shared directory until a *second* feature imports it. Do not
pre-create shared abstractions.

## Folder structure

```
src/
├── app/
│   ├── layout.tsx             # root: fonts, ThemeProvider, QueryProvider, Toaster
│   ├── globals.css            # @theme inline + :root / .dark token blocks
│   ├── page.tsx               # public landing page
│   ├── error.tsx              # boundary for the routes with no shell
│   ├── global-error.tsx       # root-layout failures; renders its own <html>
│   ├── not-found.tsx          # root 404
│   ├── robots.ts
│   ├── (auth)/                # route group — centered-card chrome, no URL segment
│   │   ├── layout.tsx
│   │   ├── _components/       # login / register / forgot-password forms
│   │   └── login/page.tsx
│   └── dashboard/
│       ├── layout.tsx         # shell: sidebar + header + content slot
│       ├── error.tsx          # sits BELOW the layout, so the shell survives a throw
│       ├── loading.tsx        # streaming fallback
│       ├── _components/       # shared across dashboard screens
│       │   ├── header/
│       │   └── sidebar/
│       ├── [...not-found]/page.tsx   # unknown sub-routes, inside the shell
│       └── <screen>/
│           ├── page.tsx       # server, thin
│           └── _components/   # one widget per file
│               ├── data.ts    # mock/seed data
│               ├── use-<x>.ts # feature-local hook
│               └── <name>-table.tsx, -columns.tsx, -toolbar.tsx
├── components/
│   ├── ui/                    # shadcn primitives — NEVER hand-edit
│   ├── form/                  # react-hook-form-bound fields (FormInput, FormSelect, …)
│   ├── data-table/            # TanStack Table wrappers (useDataTable, DataTable, …)
│   └── <shared>.tsx           # app-level shared components
├── config/app-config.ts       # app name, metadata
├── constants/                 # shared constants, barrelled through index.ts
├── data/                      # cross-feature seed data
├── hooks/                     # hooks used by 2+ features
├── lib/                       # cn(), env, fonts, query-client
├── providers/                 # client-boundary providers (QueryProvider)
├── types/                     # domain types, barrelled through index.ts
└── proxy.ts                   # Next 16's middleware — add it only when needed
```

Constants and domain types are the one exception to colocation: they live in
`src/constants/` and `src/types/` no matter which route uses them, imported through each
folder's `index.ts` barrel. Component prop types are not domain types — leave those in
the component file.

**Placement decisions:**

| Question | Answer |
|---|---|
| Used by one route? | `<route>/_components/` |
| Used by 2+ routes in one section? | `<section>/_components/` |
| Used across sections? | `src/components/` |
| Is it a shadcn primitive? | `src/components/ui/`, unmodified |
| Pure function, no React? | `lib/` (global) or feature `utils.ts` (local) |
| Hook used once? | Feature `use-*.ts`, not `src/hooks/` |

`_components` (underscore prefix) is a Next.js private folder — it is never routable.

## Rules that apply to most edits

1. **`page.tsx` stays a Server Component and stays thin.** It loads data and composes
   `_components`. Push `"use client"` down to the widget that actually needs it.
2. **One widget per file, named export.** No default exports outside `page.tsx` /
   `layout.tsx`. Sub-components used only in that file stay unexported in that file.
3. **Semantic theme tokens only.** `bg-card`, `text-muted-foreground`, `border`,
   `var(--chart-1)`. Never arbitrary hex/rgb/hsl/oklch. Non-token accents use named
   Tailwind palette colors with a dark variant (`text-green-700 dark:text-green-300`).
4. **Never hand-edit `src/components/ui/`.** Customize at the call site with `className`.
   Biome is configured to ignore that directory.
5. **No `any`.** Derive types from data (`as const` → union) instead of declaring them twice.
6. **kebab-case filenames**, enforced by Biome `useFilenamingConvention`.
7. **`@/` alias for cross-feature imports, relative for siblings** inside the same
   `_components/` folder.
8. **Props typed inline**: `function Foo({ data }: { data: Row[] })`. Reach for a named
   `interface` only when the shape is reused or has 4+ fields.
9. **Handle the full state matrix**: loading, empty, error, disabled, overflow. Empty
   states are a dashed-border box with muted text, not a blank div.
10. **Accessibility is not optional**: `aria-label` on icon-only buttons, `sr-only` text
    on pagination controls, `aria-invalid` on failed fields, semantic headings.
11. **Use the wrappers, not the primitives.** Fields come from `components/form/`
    (`FormInput`, `FormSelect`, …), tables from `components/data-table/` (`useDataTable`,
    `DataTable`, `DataTablePagination`). Hand-wiring `Controller` or `useReactTable` in a
    screen is the single most common wrong output here.

## Anti-patterns

Things that will silently work-but-wrong. The first four cause real bugs.

| Don't | Do | Why |
|---|---|---|
| Multi-field zustand selector without `useShallow` (zustand projects only) | `useShallow((s) => ({ a: s.a, b: s.b }))` | New object every update → re-renders on unrelated changes, can loop |
| Read an SSR-critical preference from client storage on first render | Read it after mount, or from a server-passed prop | Hydration mismatch / one-frame flash |
| A root `error.tsx` as the only boundary | Add one below each shell layout | `error.tsx` wraps the segments beneath it, so a root boundary replaces the sidebar too |
| Mirror a table filter in `useState` | Read it from `table.getColumn(id)?.getFilterValue()` | Two sources of truth desync on reset/clear |
| `href="dashboard"` | `href="/dashboard"` | Resolves relative to the current path, not the root |
| Hand-roll button classes on a `<Link>` | `<Button asChild><Link/></Button>` | Skips focus, disabled, and variant handling |
| `export default function page()` | `export default function Page()` | Components are PascalCase; lint won't catch the default export |
| Edit `src/components/ui/*` | Override via `className` at the call site | Biome ignores it; the shadcn CLI overwrites it |
| Arbitrary color values | Semantic token, or named Tailwind color + dark variant | Breaks every theme preset and dark mode |
| A shared component "for later" | Leave it in the route's `_components/` | Reuse decides placement, not anticipation |

Every one of these was a real bug in this codebase at some point, not a hypothetical.

## Import order (Biome-enforced)

```
react, react/**
<blank>
next/**
<blank>
third-party packages
<blank>
@/ aliases
<blank>
./relative
```

## Formatting

Double quotes, semicolons, 2-space indent, 120-char lines, trailing commas, always-parens
arrows. Let Biome do it — don't hand-format.

## References

Load the file that matches what you're doing. All three predate the trim described in the
scope note above, so they document the fuller architecture — theme presets, zustand
stores, the three-file table triad. Where one contradicts the folder structure above or
this project's `AGENTS.md`, those win.

- **`references/typescript.md`** — the type idiom catalog: `as const` unions, `satisfies`
  maps, registry types with mapped value maps, `?: never` discriminated unions, type
  predicates, template-literal types, zod→infer forms, boundary parsing.
- **`references/design-system.md`** — Tailwind v4 token architecture, theme presets and
  their codegen hook, picking a theming approach (`next-themes` vs. the preference
  registry) and both setups FOUC-free, spacing/typography rhythm, cva.
- **`references/components.md`** — server/client split, route-level special files
  (not-found, error, loading, proxy), the container pattern, the table triad, forms
  (single- and multi-file), charts, drag and drop, hooks, zustand store flavors and the
  `isSynced` guard, tooling config to copy.

## Starting a new screen

1. Read the closest existing screen first. Match its density, spacing, and rhythm.
2. Decide information hierarchy *before* picking widgets. Content dictates layout.
3. Build `page.tsx` as the composition root; each section becomes one `_components` file.
4. Register it in the nav config (`src/constants/navigation.ts`). The ⌘K search dialog
   reads the same file, so one entry covers both.
5. Verify light mode and dark mode — that's what semantic tokens buy you. (In a project
   with theme presets, verify every preset.)
