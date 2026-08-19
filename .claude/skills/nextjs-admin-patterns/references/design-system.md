# Design System

Tailwind CSS v4, CSS-first configuration. There is **no `tailwind.config.js`** — the
theme lives in `src/app/globals.css`. shadcn/ui supplies primitives; the token layer
makes them themeable.

---

## Token architecture (three layers)

**Layer 1 — raw values** on `:root`, redefined in `.dark`. Plain CSS custom properties
in oklch:

```css
:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --primary: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --chart-1: oklch(0.87 0 0);
  --sidebar: oklch(0.985 0 0);
  --font-sans: var(--font-geist);
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --border: oklch(1 0 0 / 10%);   /* alpha-based borders in dark */
  /* ... every token redefined ... */
}
```

**Layer 2 — `@theme inline`** maps those raw vars into Tailwind's utility namespace.
This is what makes `bg-card` / `text-muted-foreground` exist as classes:

```css
@theme inline {
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);

  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-primary: var(--primary);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1);   /* ... through chart-5 */
  --color-sidebar: var(--sidebar);
  --color-sidebar-accent: var(--sidebar-accent);
  --font-sans: var(--font-sans);
}
```

`inline` matters: it resolves the var at use site, so a preset overriding `--card`
changes `bg-card` everywhere without regenerating utilities.

The radius scale being `calc()`-derived from a single `--radius` means one preset
variable reshapes every rounded corner in the app.

**Layer 3 — base layer** applies the defaults:

```css
@layer base {
  * { @apply border-border outline-ring/50; }
  body {
    @apply bg-background text-foreground;
    font-family: var(--font-sans), system-ui, sans-serif;
  }
  html { @apply font-sans; }
}
```

---

## The token vocabulary

| Token | Use for |
|---|---|
| `background` / `foreground` | page surface + default text |
| `card` / `card-foreground` | raised surfaces |
| `popover` / `popover-foreground` | floating surfaces |
| `primary` / `primary-foreground` | primary actions |
| `secondary` / `secondary-foreground` | secondary actions |
| `muted` / `muted-foreground` | de-emphasized surfaces + supporting text |
| `accent` / `accent-foreground` | hover/active surfaces |
| `destructive` | errors, deletes, negative deltas |
| `border` / `input` / `ring` | outlines, field borders, focus rings |
| `chart-1..5` | series colors — always `var(--chart-N)`, never a literal |
| `sidebar-*` | sidebar's own parallel token set |

**Hard rule: never write an arbitrary color.** No `#hex`, `rgb()`, `hsl()`, `oklch()`
in component code. If the design needs a color the tokens don't cover, use a **named
Tailwind palette color with an explicit dark variant**:

```tsx
<Badge
  variant="outline"
  className="border-green-200 bg-green-500/10 text-green-700
             dark:border-green-900/40 dark:bg-green-500/15 dark:text-green-300"
>
  <TrendingUp />
  +12%
</Badge>
```

Semantic-token equivalent when one exists — prefer this:

```tsx
<Badge variant="outline" className="border-destructive/20 bg-destructive/10 text-destructive">
  <TrendingDown />
  -2.5%
</Badge>
```

Note the pattern: light gets a `-700` text weight, dark gets `-300`, backgrounds use a
low alpha of the `-500` step. Follow it so accent colors stay legible in both modes.

---

## Theme presets

Each preset is one CSS file in `src/styles/presets/`, scoped by a data attribute on the
root element, imported from `globals.css`:

```css
/* globals.css */
@import "../styles/presets/brutalist.css";
@import "../styles/presets/soft-pop.css";
@import "../styles/presets/tangerine.css";
```

```css
/* styles/presets/tangerine.css */
/*
label: Tangerine
value: tangerine
*/

:root[data-theme-preset="tangerine"] {
  --radius: 0.625rem;
  --primary: oklch(0.64 0.17 36.44);
  --primary-foreground: oklch(1 0 0);
  --background: oklch(0.94 0 236.5);
  --chart-1: oklch(0.72 0.06 248.68);
  --sidebar: oklch(0.9 0 258.33);
  --shadow-2xs: 0px 1px 3px 0px hsl(0 0% 0% / 0.05);
}

/* dark variant — note the selector order the generator expects */
.dark:root[data-theme-preset="tangerine"] {
  /* ... full token set for dark ... */
}
```

The header comment block is machine-readable. `src/scripts/generate-theme-presets.ts`
(wired to `npm run generate:presets`) reads every `.css` in `styles/presets/`, extracts
`label:`, `value:`, and the `--primary` value from each of the two selectors above, and
rewrites `lib/preferences/theme.ts` between markers:

```ts
// --- generated:themePresets:start ---
export const THEME_PRESET_OPTIONS = [
  { label: "Default", value: "default", primary: { light: "oklch(0.205 0 0)", dark: "oklch(0.922 0 0)" } },
  { label: "Tangerine", value: "tangerine", primary: { light: "oklch(0.64 0.17 36.44)", dark: "oklch(0.64 0.17 36.44)" } },
] as const;

export const THEME_PRESET_VALUES = THEME_PRESET_OPTIONS.map((p) => p.value);
export type ThemePreset = (typeof THEME_PRESET_OPTIONS)[number]["value"];
// --- generated:themePresets:end ---
```

**Adding a preset:** drop the CSS file in `styles/presets/`, add the `@import`, run the
generator. Never hand-edit between the generated markers.

The generator runs from `.husky/pre-commit`, which **regenerates and auto-stages** so the
CSS and the generated TS can never land in different commits:

```bash
npm run generate:presets
git add src/lib/preferences/theme.ts
npm exec -- lint-staged
```

That auto-`git add` of a generated file is the part worth copying — without it, a commit
that adds a preset CSS silently ships without its registry entry.

There is no `default.css` — the `:root` block in `globals.css` *is* the default preset.

Presets may also define shadow scales, opted into via a utility layer so the default
theme keeps Tailwind's shadows:

```css
@layer utilities {
  [data-theme-preset]:not([data-theme-preset="default"]) .shadow-sm {
    box-shadow: var(--shadow-sm);
  }
  /* ... repeated for 2xs, xs, shadow, md, lg, xl, 2xl */
}
```

---

## Picking a theming approach

Two options. Take the first one unless the second is forced.

| Situation | Use |
|---|---|
| Light / dark / system only | **`next-themes`** — a provider, ~40 lines total |
| Two or more user preferences (font, layout, sidebar variant, presets) | **The preference registry** below |
| Any preference that changes server-rendered markup | **The preference registry** below (localStorage is invisible to the server) |

Light/dark alone is just a class swap — the server emits identical markup either way, so
none of the registry's cookie machinery is justified. Reach for the registry when you'd
otherwise be inventing a *second* mechanism alongside `next-themes` for everything it
doesn't cover.

**The token architecture is the same either way.** Everything in this file above this
section — the three token layers, the vocabulary, "no arbitrary hex," the `-700`/`-300`
accent pattern, `var(--chart-N)` — applies unchanged. The choice below only decides how
the `dark` class gets toggled, not what's inside it.

### Light/dark only: `next-themes`

```bash
npm i next-themes
```

```tsx
// src/components/theme-provider.tsx
"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

export function ThemeProvider({ children, ...props }: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
```

```tsx
// src/app/layout.tsx
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
```

```tsx
// src/components/theme-toggle.tsx
"use client";

import { useTheme } from "next-themes";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      <Sun className="dark:hidden" />
      <Moon className="hidden dark:block" />
    </Button>
  );
}
```

Tailwind v4 has no config file, so the variant is declared in `globals.css`:

```css
@import "tailwindcss";
@custom-variant dark (&:is(.dark *));
```

Three things that trip people up:

- **`suppressHydrationWarning` on `<html>` is required** — next-themes' injected script
  mutates the class before React hydrates.
- **Swap the icons in CSS, not JS.** The common tutorial adds a
  `const [mounted, setMounted] = useState(false)` guard to dodge a hydration mismatch on
  the icon. `dark:hidden` / `hidden dark:block` needs no guard and no state — the class
  is already correct at first paint.
- **`disableTransitionOnChange`** suppresses the flash of every color animating at once.
  It's the equivalent of the `disable-transitions` class in `applyThemeMode()` below.

Bonus: shadcn's generated `components/ui/sonner.tsx` imports `useTheme` from
`next-themes`. With this provider present it works; without one it silently falls back
to the system theme.

**Do not run both systems.** They toggle the same `dark` class on the same element, so
the boot script and next-themes overwrite each other — expect a flash of the wrong theme
or a toggle that appears to do nothing.

---

## Dark mode + preferences without FOUC

Use this when the table above sends you here — multiple preferences, or any preference
the server must know about.

The whole system: **registry → SSR/boot script → `<html>` data attributes → store →
per-key persistence.** Copy this wholesale; it's the most transferable asset here.

### 1. Root layout renders static defaults

```tsx
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { theme_mode, theme_preset, content_layout, sidebar_variant, font } = PREFERENCE_DEFAULTS;
  return (
    <html
      lang="en"
      data-theme-mode={theme_mode}
      data-theme-preset={theme_preset}
      data-content-layout={content_layout}
      data-sidebar-variant={sidebar_variant}
      data-font={font}
      suppressHydrationWarning
    >
      <head>
        <ThemeBootScript />
      </head>
      <body className={`${fontVars} min-h-screen antialiased`}>
        <TooltipProvider>
          <PreferencesStoreProvider initialValues={PREFERENCE_DEFAULTS}>
            {children}
            <Toaster />
          </PreferencesStoreProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
```

Defaults (not cookie reads) keep the root layout **fully static** — no per-request
rerender for a theme toggle. `suppressHydrationWarning` is required because the boot
script mutates these attributes before React hydrates.

### 2. Boot script overwrites them before first paint

A blocking inline `<script>` in `<head>`, generated from the registry so the client
logic can't drift from the server config:

```tsx
export function ThemeBootScript() {
  const registry = JSON.stringify(PREFERENCE_REGISTRY);
  const code = `
    (function () {
      try {
        var root = document.documentElement;
        var REGISTRY = ${registry};

        function readCookie(name) { /* document.cookie lookup */ }
        function readLocal(name) { try { return localStorage.getItem(name); } catch (e) { return null; } }

        function readPreference(key, definition) {
          var mode = definition.persistence;
          var value = null;
          if (mode === "localStorage") value = readLocal(key);
          if (!value && (mode === "client-cookie" || mode === "server-cookie")) value = readCookie(key);
          return definition.values.indexOf(value) >= 0 ? value : definition.defaultValue;
        }

        var preferences = {};
        Object.keys(REGISTRY).forEach(function (key) {
          var value = readPreference(key, REGISTRY[key]);
          preferences[key] = value;
          root.setAttribute(REGISTRY[key].attribute, value);
        });

        var mode = preferences.theme_mode;
        var resolvedMode = mode === "system" && window.matchMedia
          ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
          : mode === "dark" ? "dark" : "light";

        root.classList.toggle("dark", resolvedMode === "dark");
        root.style.colorScheme = resolvedMode;
      } catch (e) {
        console.warn("ThemeBootScript error:", e);
      }
    })();
  `;
  /* biome-ignore lint/security/noDangerouslySetInnerHtml: required for pre-hydration boot script */
  return <script dangerouslySetInnerHTML={{ __html: code }} />;
}
```

Note `colorScheme` is set alongside the class so native form controls and scrollbars
match immediately.

### 3. Layout-critical prefs also read server-side

Preferences that change SSR markup (sidebar variant, collapsible) must be read on the
server too, or the first paint has the wrong shell:

```tsx
export default async function Layout({ children }: Readonly<{ children: ReactNode }>) {
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";
  const [variant, collapsible] = await Promise.all([
    getPreference("sidebar_variant"),
    getPreference("sidebar_collapsible"),
  ]);

  return (
    <SidebarProvider defaultOpen={defaultOpen} /* ... */>
      <AppSidebar variant={variant} collapsible={collapsible} />
      {/* ... */}
    </SidebarProvider>
  );
}
```

This is why the type system forbids `localStorage` for those keys — see
`references/typescript.md` §4 (`defineSSRPreference`).

### 4. Runtime application

```ts
export function applyThemeMode(mode: ThemeMode): ResolvedThemeMode {
  const resolved = resolveThemeMode(mode);
  const doc = document.documentElement;
  doc.setAttribute("data-theme-mode", mode);
  doc.classList.add("disable-transitions");     // suppress the flash of animating colors
  doc.classList.toggle("dark", resolved === "dark");
  doc.style.colorScheme = resolved;
  requestAnimationFrame(() => doc.classList.remove("disable-transitions"));
  return resolved;
}
```

Every other preference is a one-liner because the registry carries its attribute name:

```ts
document.documentElement.setAttribute(PREFERENCE_REGISTRY[key].attribute, value);
```

`system` mode subscribes to `matchMedia("(prefers-color-scheme: dark)")` and
unsubscribes when the user picks an explicit mode.

---

## Styling off data attributes

Because preferences land as `<html>` attributes, layout variants are pure CSS — no
conditional rendering, no client component:

```tsx
<SidebarInset
  className={cn(
    "[html[data-content-layout=centered]_&>*]:mx-auto",
    "[html[data-content-layout=centered]_&>*]:w-full",
    "[html[data-content-layout=centered]_&>*]:max-w-screen-2xl",
    "peer-data-[variant=inset]:border",
    "[--dashboard-header-height:--spacing(12)]",
    "min-w-0 overflow-x-clip",
  )}
>
```

```tsx
<header className={cn(
  "flex h-12 shrink-0 items-center gap-2 border-b",
  "[html[data-navbar-style=sticky]_&]:sticky [html[data-navbar-style=sticky]_&]:top-0",
  "[html[data-navbar-style=sticky]_&]:z-50 [html[data-navbar-style=sticky]_&]:bg-background/50",
  "[html[data-navbar-style=sticky]_&]:backdrop-blur-md",
)}>
```

Same trick for opt-out behavior driven by children — a page can request full-bleed
layout without the shell knowing about it:

```tsx
// dashboard/layout.tsx
<div className="min-h-0 min-w-0 flex-1 overflow-x-hidden p-4
                has-data-[content-padding=false]:p-0
                md:p-6 md:has-data-[content-padding=false]:p-0">
  {children}
</div>

// any page.tsx that wants edge-to-edge
<div data-content-padding="false" className="flex min-h-[calc(100svh-var(--dashboard-header-height))] flex-col">
```

Layout metrics get exposed as CSS vars (`--dashboard-header-height`, `--sidebar-width`)
so children can size against them:

```tsx
<SidebarProvider style={{ "--sidebar-width": "calc(var(--spacing) * 68)" } as React.CSSProperties}>
```

---

## Fonts

A registry mirroring the preference pattern — declare once, derive the keys, the CSS var
string, and the picker options:

```ts
const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const fontRegistry = {
  geist: { label: "Geist", font: geist },
  inter: { label: "Inter", font: inter },
} as const;

export type FontKey = keyof typeof fontRegistry;
export const fontKeys = Object.keys(fontRegistry) as FontKey[];
export const fontVars = Object.values(fontRegistry).map(({ font }) => font.variable).join(" ");
export const fontOptions = fontKeys.map((key) => ({ key, label: fontRegistry[key].label }));
```

`fontVars` goes on `<body>`; selection is a CSS var swap keyed off the data attribute:

```css
html[data-font="inter"] body { --font-sans: var(--font-inter); }
```

All registered fonts load, one is active. Fine for a font-picker feature; if you don't
need the picker, register one font and delete the registry.

---

## Visual rhythm

Match these when adding screens — consistency here is most of what makes it look designed.

**Spacing**
- Page container: `flex flex-col gap-4`
- Shell padding: `p-4 md:p-6`
- Card grids: `grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4`
- Asymmetric layouts: 12-column grid — `xl:grid-cols-12` + `xl:col-span-7` / `xl:col-span-5`
- Inside cards: `space-y-2`; section headers: `space-y-1`

**Typography**
- Page title: `text-3xl tracking-tight` (no `font-bold` — the tracking does the work)
- Page subtitle: `text-muted-foreground text-sm`
- Section title in card: `CardTitle` with `font-normal`
- Big metric: `text-3xl leading-none tracking-tight`
- Numbers in tables/timestamps: add `tabular-nums`

**Icons** — lucide, `size-4` default. Buttons auto-size their icons; the `data-icon`
slot adjusts padding:

```tsx
<Button size="sm" variant="outline">
  <Download data-icon="inline-start" />
  Export
</Button>
```

**Responsive** — mobile-first, collapse at `md` / `lg` / `xl`. Toolbars go
`flex-col gap-3 lg:flex-row lg:items-center lg:justify-between`. Add `min-w-0` on flex
children that contain text, or truncation breaks.

**Empty / coming-soon state:**

```tsx
<div className="flex h-64 items-center justify-center rounded-xl border border-border border-dashed text-muted-foreground">
  Accounts view coming soon.
</div>
```

---

## cva for primitives

shadcn primitives use `class-variance-authority` plus `data-*` attributes so *other*
components can style them contextually:

```tsx
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent text-sm font-medium transition-all outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 aria-invalid:border-destructive [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline: "border-border bg-background hover:bg-muted dark:bg-input/30",
        ghost: "hover:bg-muted hover:text-foreground",
        destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20",
      },
      size: {
        default: "h-8 gap-1.5 px-2.5 has-data-[icon=inline-start]:pl-2",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem]",
        icon: "size-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({ className, variant = "default", size = "default", asChild = false, ...props }:
  React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
```

Points worth copying:
- `React.ComponentProps<"button">` — not a hand-written props interface.
- `asChild` + `Slot.Root` for polymorphism.
- `data-slot` / `data-variant` / `data-size` emitted always — parents target them:
  `*:data-[slot=button]:h-11`, `in-data-[slot=button-group]:rounded-lg`.
- `rounded-[min(var(--radius-md),12px)]` — caps radius so presets with a large
  `--radius` don't produce pill-shaped small buttons.
- `[&_svg:not([class*='size-'])]:size-4` — default icon size that a caller can override.

**Do not hand-edit files in `src/components/ui/`.** Biome excludes that directory, and
`shadcn` CLI updates overwrite it. Customize at the call site.

---

## Accessibility baseline

- Icon-only buttons: `aria-label`.
- Pagination/nav controls: `<span className="sr-only">Go to next page</span>`.
- Invalid fields: `aria-invalid={fieldState.invalid}` on the input **and**
  `data-invalid` on the wrapper so cva can style the group.
- Charts: `accessibilityLayer` on the recharts root, plus a computed `ariaLabel`.
- Decorative icons inside labeled controls: `aria-hidden="true"`.
- Focus rings come from the token layer (`outline-ring/50`) — never remove them.
