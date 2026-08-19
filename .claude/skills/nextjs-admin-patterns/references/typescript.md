# TypeScript Idiom Catalog

Strict mode, no `any`. The through-line: **declare data once, derive types from it.**
Every idiom below exists to avoid writing a union and its runtime array separately and
letting them drift apart.

---

## 1. Options array → values → union type

The most-used pattern in the codebase. Write the options once as UI-ready data; derive
both the runtime value list and the compile-time union from it.

```ts
const SIDEBAR_VARIANT_OPTIONS = [
  { label: "Sidebar", value: "sidebar" },
  { label: "Inset", value: "inset" },
  { label: "Floating", value: "floating" },
] as const;

export const SIDEBAR_VARIANT_VALUES = SIDEBAR_VARIANT_OPTIONS.map((v) => v.value);
export type SidebarVariant = (typeof SIDEBAR_VARIANT_VALUES)[number];
//   → "sidebar" | "inset" | "floating"
```

The `as const` is load-bearing — without it, `value` widens to `string` and the union
collapses. Keep `OPTIONS` unexported when only `VALUES` and the type escape the module.

**Shorter variant** when there are no labels:

```ts
export const orderFilters = ["All", "Needs action", "Unfulfilled", "Unpaid"] as const;
export type OrderFilter = (typeof orderFilters)[number];
```

**Variant that keeps the whole object shape:**

```ts
export const THEME_PRESET_OPTIONS = [
  { label: "Default", value: "default", primary: { light: "...", dark: "..." } },
  { label: "Tangerine", value: "tangerine", primary: { light: "...", dark: "..." } },
] as const;

export type ThemePreset = (typeof THEME_PRESET_OPTIONS)[number]["value"];
```

---

## 2. `satisfies` for lookup maps

`satisfies` checks the map against a constraint **without widening the literal types**.
Use it for every `Record`-shaped lookup. It gives you exhaustiveness checking against
the key union *and* preserves precise value types at the call site.

```ts
const sortOptionState = {
  newest: [{ id: "joined", desc: true }],
  oldest: [{ id: "joined", desc: false }],
  "name-asc": [{ id: "name", desc: false }],
  "name-desc": [{ id: "name", desc: true }],
} satisfies Record<(typeof sortOptions)[number]["value"], SortingState>;
```

Adding a value to `sortOptions` now produces a compile error here until the map is
updated. That's the point — a `: Record<...>` annotation would give the check but destroy
the literal keys; `satisfies` gives you both.

Same pattern with a domain union:

```ts
const trendDefinitions = {
  "heart-rate": { baseline: "heartRate", domain: [50, 150], ticks: [50, 100, 150], ... },
  map:          { baseline: "arterialMap", domain: [50, 150], ticks: [50, 100, 150], ... },
  spo2:         { baseline: "spo2", domain: [80, 100], ticks: [80, 90, 100], ... },
} satisfies Record<TrendKind, TrendDefinition>;
```

Contrast with a plain annotated record, used when you *want* uniform widening:

```ts
const heartRateVariations: Record<CardiacRhythm, number> = {
  "atrial-fibrillation": 4.5,
  paced: 1,
  sinus: 1.4,
  // ... exhaustive over CardiacRhythm, values are just `number`
};
```

---

## 3. Registry object → derived key/value types

For configuration that has many keys with per-key value domains, build one registry
object and derive everything else. This is the highest-leverage pattern here.

```ts
export const PREFERENCE_REGISTRY = {
  theme_mode: definePreference({
    values: THEME_MODE_VALUES,
    defaultValue: "light",
    persistence: "client-cookie",
    attribute: "data-theme-mode",
  }),
  sidebar_variant: defineSSRPreference({ /* ... */ }),
} as const;

export type PreferenceKey = keyof typeof PREFERENCE_REGISTRY;

// Per-key value union — theme_mode gets "light"|"dark"|"system",
// sidebar_variant gets "sidebar"|"inset"|"floating".
export type PreferenceValueMap = {
  [K in PreferenceKey]: (typeof PREFERENCE_REGISTRY)[K]["values"][number];
};

export const PREFERENCE_KEYS = Object.freeze(Object.keys(PREFERENCE_REGISTRY) as PreferenceKey[]);

export const PREFERENCE_DEFAULTS = Object.fromEntries(
  PREFERENCE_KEYS.map((key) => [key, PREFERENCE_REGISTRY[key].defaultValue]),
) as PreferenceValueMap;
```

Consumers then get full inference: `setPreference("theme_mode", "dark")` compiles;
`setPreference("theme_mode", "floating")` does not.

```ts
setPreference: <K extends PreferenceKey>(key: K, value: PreferenceValueMap[K]) => void;
```

The two `as` casts are deliberate and contained — `Object.keys`/`Object.fromEntries`
return widened types that TS can't narrow. Confine them to the derivation site.

---

## 4. Generic identity functions to constrain a registry

To type-check registry entries *as you write them* while keeping literal inference, use
a generic identity function with `const` type parameters. It validates the shape and
returns the argument unchanged.

```ts
type PreferenceDefinition<
  Values extends readonly string[],
  Persistence extends PreferencePersistence,
  Attribute extends `data-${string}`,
> = {
  values: Values;
  defaultValue: Values[number];   // default must be one of the values
  persistence: Persistence;
  attribute: Attribute;
};

function definePreference<
  const Values extends readonly string[],
  const Persistence extends PreferencePersistence,
  const Attribute extends `data-${string}`,
>(definition: PreferenceDefinition<Values, Persistence, Attribute>) {
  return definition;
}
```

`defaultValue: Values[number]` means a typo in the default is a compile error.
The `const` modifier on the type parameter preserves literals without needing
`as const` at each call site.

**Narrowing a variant of the same helper** — here layout-critical preferences may not
use `localStorage`, expressed in the type system rather than a comment:

```ts
type LayoutPersistence = Exclude<PreferencePersistence, "localStorage">;

function defineSSRPreference<
  const Values extends readonly string[],
  const Persistence extends LayoutPersistence,   // ← narrowed
  const Attribute extends `data-${string}`,
>(definition: PreferenceDefinition<Values, Persistence, Attribute>) {
  return definition;
}
```

---

## 5. Template-literal types for string contracts

```ts
Attribute extends `data-${string}`
```

Enforces that every registry entry's DOM attribute is a valid `data-*` attribute. Use
template-literal types anywhere a string has structure: route prefixes, CSS var names,
event names, cookie keys.

---

## 6. Mutually exclusive props via `?: never`

A nav item is *either* a link *or* a parent with children — never both. Encode that as
a discriminated union rather than optional props plus a runtime assertion.

```ts
interface NavItemBase {
  id: string;
  title: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
}

export interface NavMainLinkItem extends NavItemBase {
  url: string;
  subItems?: never;      // ← a link can never have children
}

export interface NavMainParentItem extends NavItemBase {
  subItems: NavSubItem[];
}

export type NavMainItem = NavMainLinkItem | NavMainParentItem;
```

Now `if ("subItems" in item)` narrows correctly, and constructing an item with both
`url` and `subItems` fails to compile.

---

## 7. Type predicates for runtime narrowing

```ts
function isColumnId(id: string): id is ColumnId {
  return columnIds.includes(id as ColumnId);
}

export function findColumnId(board: BoardState, id: string): ColumnId | undefined {
  if (isColumnId(id)) return id;
  return columnIds.find((columnId) => board[columnId].some((task) => task.id === id));
}
```

Keep predicates small, local, and next to the data they guard (feature `utils.ts`).

---

## 8. Parse at boundaries, never trust external strings

Any value arriving from a cookie, URL, localStorage, or DOM attribute is `string | null`.
Convert it to a domain type with an explicit fallback — never cast it.

```ts
export function parsePreference<K extends PreferenceKey>(
  key: K,
  rawValue: string | null | undefined,
): PreferenceValueMap[K] {
  const definition = PREFERENCE_REGISTRY[key];
  const allowedValues = definition.values as readonly string[];

  if (rawValue && allowedValues.includes(rawValue)) {
    return rawValue as PreferenceValueMap[K];
  }

  return definition.defaultValue as PreferenceValueMap[K];
}
```

Total function: every input maps to a valid domain value. Callers never handle `null`.

Same discipline for storage access — swallow the platform error, return a typed default,
and log only in development:

```ts
export function getLocalStorageValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setLocalStorageValue(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[localStorage] Failed to write value:", error);
    }
  }
}
```

---

## 9. Zod schema as the single source of form truth

```ts
const formSchema = z.object({
  email: z.email({ message: "Please enter a valid email address." }),
  password: z.string().min(6, { message: "Password must be at least 6 characters." }),
  remember: z.boolean().optional(),
});

function onSubmit(data: z.infer<typeof formSchema>) { /* ... */ }

const form = useForm<z.infer<typeof formSchema>>({
  resolver: zodResolver(formSchema),
  defaultValues: { email: "", password: "", remember: false },
});
```

Never write a separate `type FormValues` — always `z.infer<typeof schema>`. Validation
messages live in the schema, not in the JSX.

---

## 10. Props typing conventions

**Inline for simple components** — the default:

```ts
export function Roles({ roles }: { roles: Role[] }) {}
export function RecentCustomersTable({ data }: { data: RecentCustomerRow[] }) {}
export function TrafficSourceBarChart({ data }: { data: TrafficSourceDatum[] }) {}
```

**Named `interface` with `readonly`** when the shape is complex, reused, or passed down
through several components:

```ts
interface NavItemProps {
  readonly item: NavMainItem;
  readonly isItemActive: (item: NavMainItem) => boolean;
  readonly isSubItemActive: (url: string) => boolean;
  readonly isSubmenuOpen: (item: NavMainParentItem) => boolean;
}
```

**Layouts and any `children` wrapper:**

```ts
export default function Layout({ children }: Readonly<{ children: ReactNode }>) {}
```

**Options objects with defaults destructured in one place:**

```ts
export function formatCurrency(
  amount: number,
  opts?: { currency?: string; locale?: string; noDecimals?: boolean },
) {
  const { currency = "USD", locale = "en-US", noDecimals } = opts ?? {};
  // ...
}
```

**Named options object for hooks with 3+ params** — call sites read better than
positional args, and optional params get defaults in the destructure:

```ts
interface PatientWaveformSeriesOptions {
  compact?: boolean;
  kind: WaveformKind;
  lead?: EcgLead;
  patient: PatientRecord;
}

export function usePatientWaveformSeries({
  compact = false,
  kind,
  lead = "II",
  patient,
}: PatientWaveformSeriesOptions) {}
```

---

## 11. Feature type files

When a feature has a real domain model, give it a `types.ts` next to the components.
Small aliases first, composed types after, state shape last.

```ts
export type ColumnId = "ideas" | "planned" | "building" | "qa" | "shipped";
export type TaskPriority = "High" | "Medium" | "Low";
export type TaskInsightLabel = "Attachments" | "Comments" | "Documents";

export type TaskInsight = { label: TaskInsightLabel; count: number };
export type TaskOwnerProfile = { name: string; tone: string };

export type Task = {
  id: string;
  title: string;
  priority: TaskPriority;
  progress: number;
  owner: TaskOwnerProfile;
  insights: TaskInsight[];
};

export type BoardState = Record<ColumnId, Task[]>;
```

`type` over `interface` for data shapes; `interface` for props objects that other
interfaces extend. Don't mix the two arbitrarily.

For table features the row type lives in `schema.ts` instead — see
`references/components.md`, "table triad".

---

## 12. Small rules that keep Biome quiet

- `useNullishCoalescing` is an error → `??` not `||` for defaults (`opts ?? {}`).
- `noInferrableTypes` → drop `: string` on `const x: string = "a"`.
- `noUselessElse` → return early instead of `else`.
- `noFloatingPromises` / `noMisusedPromises` are errors → mark deliberate fire-and-forget
  with `void`: `void persistPreference(key, value);`
- `useAsConstAssertion` → `as const`, never `<const>`.
- `noImportCycles` is an error → registry/config modules must not import their consumers.
- `noNestedTernary` warns → extract a small helper function instead:

```ts
function getRoleTypeFilter(groupFilter: string) {
  if (groupFilter === "System roles") return "System";
  if (groupFilter === "Custom roles") return "Custom";
  return "All";
}
```

That flat if-chain style is used consistently across the codebase in place of nested
ternaries and switch statements — prefer it for 2–4 branch mappings.
