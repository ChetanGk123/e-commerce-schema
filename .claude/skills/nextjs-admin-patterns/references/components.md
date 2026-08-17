# Component Segregation & Patterns

How work is split across files, where state lives, and the recurring templates.

---

## The server/client boundary

**`page.tsx` is a Server Component and stays thin.** It loads data and composes. It
never holds state.

Thinnest form — page delegates entirely to a client container:

```tsx
// dashboard/users/page.tsx
import { users } from "./_components/data";
import { Users } from "./_components/users";

export default function Page() {
  return <Users users={users} />;
}
```

Common form — page owns layout and composition, each section is its own component:

```tsx
// dashboard/finance/page.tsx
export default function Page() {
  const formattedDate = format(new Date(), "EEEE, do MMMM yyyy");

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <h1 className="text-3xl tracking-tight">Personal Finances</h1>
        <p className="text-muted-foreground text-sm">{formattedDate}</p>
      </div>

      <Tabs defaultValue="30-days" className="flex flex-col gap-4">
        {/* toolbar row */}
        <TabsContent value="30-days" className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <div className="xl:col-span-6"><OverviewKpis /></div>
            <div className="flex flex-col gap-4 xl:col-span-6">
              <IncomeBreakdown />
              <FinanceNotification />
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

Async form — page awaits server data, then hands it to a client tree:

```tsx
// mail/page.tsx
export default async function Page() {
  const layoutCookie = await getValueFromCookie(MAIL_LAYOUT_COOKIE);

  return (
    <div className="h-dvh min-h-0 overflow-hidden">
      <MailComponent
        mails={mails}
        defaultLayout={layoutCookie ? JSON.parse(layoutCookie) : [...DEFAULT_MAIL_LAYOUT]}
      />
    </div>
  );
}
```

**`"use client"` goes on the leaf that needs it, never on the page.** A page with one
interactive widget stays a Server Component; only that widget is a Client Component.

Rough guide to which side a file lands on:

| Needs | Side |
|---|---|
| `cookies()`, `await`, filesystem, secrets | server |
| `useState` / `useEffect` / event handlers | client |
| recharts, TanStack Table, dnd-kit, zustand | client |
| Static markup + composition only | server |

---

## Route-level special files

**Not found, at two levels.** Root `app/not-found.tsx` catches everything; a catch-all
segment inside the shell catches unknown sub-routes so they keep the sidebar and header
instead of dropping to a bare page:

```
app/
├── not-found.tsx                      # bare, full-viewport
└── (main)/dashboard/
    └── [...not-found]/page.tsx        # renders inside the dashboard shell
```

```tsx
// app/not-found.tsx
export default function NotFound() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center space-y-2 text-center">
      <h1 className="font-semibold text-2xl">Page not found.</h1>
      <p className="text-muted-foreground">The page you are looking for could not be found.</p>
      <Link prefetch={false} replace href="/dashboard/default">
        <Button variant="outline">Go back home</Button>
      </Link>
    </div>
  );
}
```

```tsx
// (main)/dashboard/[...not-found]/page.tsx — h-full, not h-dvh: the shell owns the viewport
export default function DashboardNotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center space-y-2 text-center">
      <h1 className="font-semibold text-2xl">Page not found.</h1>
      <p className="text-muted-foreground">This section will be added in future updates.</p>
    </div>
  );
}
```

**Section index that only redirects.** `/dashboard` has no content of its own — the
redirect lives in `next.config.mjs`, and the page is a stub that never renders:

```tsx
// (main)/dashboard/page.tsx
export default function Page() {
  return;
}
```

```js
// next.config.mjs
async redirects() {
  return [{ source: "/dashboard", destination: "/dashboard/default", permanent: false }];
}
```

The stub still has to exist so the segment resolves. If you delete one half of this pair
you get a confusing 404 — keep them together in your head.

**`error.tsx` / `loading.tsx` — recommended baseline, not present in the source template.**
The template ships neither, so there's nothing to copy; add them per section, because a
route without them inherits the nearest ancestor boundary and a thrown error blanks the
whole shell.

```tsx
// (main)/dashboard/error.tsx — must be a Client Component
"use client";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center space-y-2 text-center">
      <h1 className="font-semibold text-2xl">Something went wrong.</h1>
      <p className="text-muted-foreground">{error.message}</p>
      <Button variant="outline" onClick={reset}>Try again</Button>
    </div>
  );
}
```

```tsx
// (main)/dashboard/<screen>/loading.tsx — mirror the real layout's shape
export default function Loading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-9 w-64" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={`kpi-${i}`} className="h-32" />
        ))}
      </div>
    </div>
  );
}
```

Skeletons should match the grid they replace — a single full-width bar where four cards
will appear causes a visible reflow.

**`proxy.ts` — Next 16's rename of `middleware.ts`.** The template ships it disabled;
rename `src/proxy.disabled.ts` → `src/proxy.ts` to activate. This is where auth
redirects belong:

```ts
import { type NextRequest, NextResponse } from "next/server";

export function proxy(_req: NextRequest) {
  // const token = req.cookies.get("session_token")?.value;
  // if (token && req.nextUrl.pathname === "/auth/login")
  //   return NextResponse.redirect(new URL("/dashboard", req.url));

  return NextResponse.next();
}

export const config = { matcher: "/:path*" };
```

The export is named `proxy`, not `middleware`. Narrow the matcher to skip static assets
and API routes before shipping — `"/:path*"` runs on every request.

---

## The container pattern

When a screen has cross-cutting interactive state (filters that drive a table, a
selection that drives a detail pane), introduce **one** client container named after
the feature. It owns the state; everything under it is presentational.

```tsx
// dashboard/roles/_components/roles.tsx
"use client";
"use no memo";

export function Roles({ roles }: { roles: Role[] }) {
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 12 });

  const table = useReactTable({ data: roles, columns: rolesColumns, /* ... */ });

  return (
    <div className="flex h-full flex-col gap-4">
      {/* header, toolbar, filters — all reading from `table` */}
      <RolesTable table={table} />
    </div>
  );
}
```

Note the container builds the table instance and passes it **down**. The presentational
`RolesTable` just renders it. That keeps toolbar and table in sync without lifting
filter state into props one at a time.

Containers seen in this codebase: `roles.tsx`, `users.tsx`, `tasks.tsx`, `mail.tsx`,
`chat.tsx`, `kanban.tsx`, `invoice.tsx`, `logistics.tsx`, `patient-monitoring.tsx`.
The naming is always `<feature>.tsx` inside `_components/`.

---

## One widget per file

Each card, chart, or section in a screen is its own file in `_components/`, exported by
name:

```
dashboard/finance/_components/
├── balance-distribution-card.tsx
├── finance-notification.tsx
├── income-breakdown.tsx
├── overview-kpis.tsx
├── quick-actions.tsx
├── transactions-overview-card.tsx
├── upcoming-transactions.tsx
└── wallet.tsx
```

**Sub-components used only inside that file stay in that file, unexported.** Don't
create a file for something one component renders:

```tsx
// inside columns.tsx — not exported, not its own file
function PaymentBadge({ status }: { status: OrderRow["payment"] }) {
  if (status === "Paid") return <Badge variant="outline" className="...">Paid</Badge>;
  if (status === "Refunded") return <Badge variant="destructive">Refunded</Badge>;
  return <Badge variant="outline" className="...">Pending</Badge>;
}
```

Same for a chart that appears three times in one card under different tabs — keep
`TrafficSourceBarChart` local to `top-traffic-sources.tsx`.

---

## The table triad

Every data table splits into three files in a `<name>-table/` folder. This is the most
mechanical pattern here — follow it exactly.

```
_components/recent-orders-table/
├── schema.ts       # row type + filter unions. No React.
├── columns.tsx     # ColumnDef[] + cell renderers + local badge components
├── table.tsx       # table instance, toolbar, body, pagination
├── data.json       # or data.ts — the rows
└── formatters.ts   # optional: display-string helpers
```

**`schema.ts`** — types only:

```ts
export const orderFilters = ["All", "Needs action", "Unfulfilled", "Unpaid", "Returns"] as const;
export type OrderFilter = (typeof orderFilters)[number];

export type OrderRow = {
  id: string;
  date: string;
  customer: string;
  payment: "Paid" | "Pending" | "Refunded";
  total: string;
  fulfillment: "Fulfilled" | "Returned" | "Unfulfilled";
};
```

**`columns.tsx`** — `ColumnDef<Row>[]` as a named export, plus its private renderers:

```tsx
export const recentOrdersColumns: ColumnDef<OrderRow>[] = [
  {
    id: "select",
    header: ({ table }) => (
      <Checkbox
        aria-label="Select all orders"
        checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && "indeterminate")}
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        aria-label={`Select order ${row.original.id}`}
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
      />
    ),
    enableHiding: false,
    enableSorting: false,
  },
  {
    accessorKey: "id",
    header: "Order",
    cell: ({ row }) => (
      <div className="flex flex-col gap-0.5">
        <div className="font-medium leading-none">{row.original.id}</div>
        <div className="text-muted-foreground text-xs">{row.original.items}</div>
      </div>
    ),
    enableHiding: false,
  },
  {
    id: "statusSummary",
    header: "Status",
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <PaymentBadge status={row.original.payment} />
        <FulfillmentBadge status={row.original.fulfillment} />
      </div>
    ),
    // Custom filter over multiple fields — this is why it's an `id` column, not accessorKey
    filterFn: (row, _columnId, value) => {
      if (value === "Needs action") {
        return row.original.payment === "Pending" || row.original.fulfillment === "Unfulfilled";
      }
      if (value === "Unpaid") return row.original.payment === "Pending";
      return true;
    },
  },
  {
    accessorKey: "total",
    header: () => <div className="w-28">Total</div>,
    cell: ({ row }) => <div className="w-28 tabular-nums">{row.original.total}</div>,
  },
  {
    id: "actions",
    header: () => <div className="flex w-full justify-end">Actions</div>,
    cell: () => (/* DropdownMenu with a ghost icon-sm trigger */),
    enableHiding: false,
    enableSorting: false,
  },
];
```

Column conventions:
- Fixed-width columns set the same `w-*` class on both `header` and `cell`.
- Numeric columns get `tabular-nums`.
- Selection column first, actions column last, both `enableHiding: false` and
  `enableSorting: false`.
- Icon-only action triggers always carry `aria-label`.

**`table.tsx`** — the client component. Note the two directives:

```tsx
"use client";
"use no memo";   // TanStack Table mutates internally; opt it out of React Compiler
```

Hidden utility columns are the idiomatic way to do search and derived-range filtering —
declare a column with `id: "search"` / `id: "joinedWindow"`, hide it, and drive it from
the toolbar:

```tsx
const [columnVisibility] = React.useState<VisibilityState>({ search: false, joinedWindow: false });

const table = useReactTable({
  data,
  columns: recentCustomersColumns,
  state: { rowSelection, columnFilters, sorting, columnVisibility, pagination },
  getRowId: (row) => row.id,
  enableRowSelection: true,
  onRowSelectionChange: setRowSelection,
  onColumnFiltersChange: setColumnFilters,
  onSortingChange: setSorting,
  onPaginationChange: setPagination,
  getCoreRowModel: getCoreRowModel(),
  getFilteredRowModel: getFilteredRowModel(),
  getPaginationRowModel: getPaginationRowModel(),
  getSortedRowModel: getSortedRowModel(),
});

// Read filter state back out of the table — do not mirror it in useState
const searchQuery = (table.getColumn("search")?.getFilterValue() as string | undefined) ?? "";
const statusFilter = (table.getColumn("status")?.getFilterValue() as string | undefined) ?? "all";
```

**The table is the single source of truth for filter state.** Never keep a parallel
`useState` for a filter value — read it from the column. Always reset the page on a
filter change:

```tsx
onValueChange={(value) => {
  table.getColumn("status")?.setFilterValue(value === "all" ? undefined : value);
  table.setPageIndex(0);
}}
```

`undefined` clears a filter; `"all"` is a UI-only sentinel that never reaches the table.

Body shell, including the empty state:

```tsx
<div className="overflow-hidden rounded-lg border bg-card">
  <Table>
    <TableHeader className="bg-muted/15">
      {table.getHeaderGroups().map((headerGroup) => (
        <TableRow key={headerGroup.id}>
          {headerGroup.headers.map((header) => (
            <TableHead key={header.id} colSpan={header.colSpan} className="h-11 p-3 font-medium">
              {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
            </TableHead>
          ))}
        </TableRow>
      ))}
    </TableHeader>
    <TableBody>
      {table.getRowModel().rows.length ? (
        table.getRowModel().rows.map((row) => (
          <TableRow key={row.id} data-state={row.getIsSelected() && "selected"}>
            {row.getVisibleCells().map((cell) => (
              <TableCell key={cell.id} className="p-3 align-middle">
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ))}
          </TableRow>
        ))
      ) : (
        <TableRow>
          <TableCell colSpan={table.getVisibleLeafColumns().length} className="h-24 text-center">
            No results.
          </TableCell>
        </TableRow>
      )}
    </TableBody>
  </Table>
</div>
```

Pagination footer: selected-count on the left, rows-per-page `Select` + "Page X of Y" +
four icon buttons (first/prev/next/last) on the right, each with `sr-only` label text.

**Split point when the table gets big:** move the instance up into the feature container
(`roles.tsx`) and have `table.tsx` accept `{ table }` as a prop. Do this when the
toolbar needs the same instance.

---

## Forms

react-hook-form + zod + the shadcn `Field` primitives. `Controller` per field, not
`register`.

```tsx
"use client";

const formSchema = z.object({
  email: z.email({ message: "Please enter a valid email address." }),
  password: z.string().min(6, { message: "Password must be at least 6 characters." }),
  remember: z.boolean().optional(),
});

function onSubmit(data: z.infer<typeof formSchema>) {
  toast("You submitted the following values", { description: /* ... */ });
}

export function LoginForm() {
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: "", password: "", remember: false },
  });

  return (
    <form noValidate onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <FieldGroup className="gap-4">
        <Controller
          control={form.control}
          name="email"
          render={({ field, fieldState }) => (
            <Field className="gap-1.5" data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="login-email">Email Address</FieldLabel>
              <Input
                {...field}
                id="login-email"
                type="email"
                autoComplete="email"
                aria-invalid={fieldState.invalid}
              />
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
      </FieldGroup>
      <Button className="w-full" type="submit">Login</Button>
    </form>
  );
}
```

Non-negotiables: `noValidate` on the form (zod owns validation), explicit `id` +
`htmlFor` on every field, `autoComplete` on credential inputs, `aria-invalid` on the
control and `data-invalid` on the wrapper, error text rendered only when invalid.

Non-native controls need an explicit adapter — `onCheckedChange` isn't `onChange`:

```tsx
<Checkbox
  id="login-remember"
  name={field.name}
  checked={field.value}
  onCheckedChange={(checked) => field.onChange(Boolean(checked))}
  aria-invalid={fieldState.invalid}
/>
```

### Forms split across files

A form big enough to need "one widget per file" uses `FormProvider` at the container and
`useFormContext` in each child — this is the form's version of the container pattern.
Without it you'd thread `control` through every prop.

```tsx
// invoice/_components/invoice.tsx — the container owns the form
"use client";

export function Invoice() {
  const form = useForm<InvoiceFormValues>({ defaultValues: defaultInvoiceValues });
  const invoice = useWatch({ control: form.control }) as InvoiceFormValues;   // live preview

  return (
    <FormProvider {...form}>
      <form className="grid gap-5 xl:grid-cols-2" noValidate onSubmit={(event) => event.preventDefault()}>
        <InvoiceForm />
        <InvoicePreview invoice={invoice} />
      </form>
    </FormProvider>
  );
}
```

```tsx
// invoice/_components/invoice-adjustments.tsx — a child pulls what it needs
export function InvoiceAdjustments() {
  const { control, register } = useFormContext<InvoiceFormValues>();
  const discountType = useWatch({ control, name: "discountType" });   // conditional fields

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-medium tracking-tight">Adjustments</h2>
      <Controller control={control} name="taxId" render={({ field }) => (/* ... */)} />
    </section>
  );
}
```

Points that matter:
- **Always parameterize `useFormContext<FormValues>()`** — unparameterized it returns
  `any`-ish field names and you lose every typo check.
- `useWatch` with no `name` watches the whole form (container, for a live preview);
  `useWatch({ control, name })` watches one field (child, for conditional rendering).
  Prefer it over `form.watch()` — it re-renders only the subscriber, not the whole tree.
- Children are **not** Client Components individually; the container carries `"use client"`
  and they inherit it.

---

## Charts

recharts wrapped in the shadcn `ChartContainer`. Config object typed with `satisfies
ChartConfig`, colors as `var(--chart-N)`:

```tsx
"use client";

const chartConfig = {
  visitors: { color: "var(--chart-1)", label: "Visitors" },
} satisfies ChartConfig;

type TrafficSourceDatum = { label: string; source: string; visitors: number };

const sourcesData: TrafficSourceDatum[] = [
  { label: "89.4k", source: "Organic Search", visitors: 89_400 },
  { label: "55.2k", source: "Direct", visitors: 55_200 },
];

function TrafficSourceBarChart({ data }: { data: TrafficSourceDatum[] }) {
  return (
    <ChartContainer config={chartConfig} className="h-64 w-full">
      <BarChart accessibilityLayer data={data} layout="vertical" margin={{ left: 0, right: 48 }}>
        <YAxis dataKey="source" hide type="category" />
        <XAxis dataKey="visitors" hide type="number" />
        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
        <Bar barSize={40} dataKey="visitors" fill="var(--color-visitors)" fillOpacity={0.5} radius={8}>
          <LabelList className="fill-foreground" dataKey="source" fontSize={14} position="insideLeft" />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
```

`ChartContainer` turns each `chartConfig` key into a `--color-<key>` CSS var — reference
`fill="var(--color-visitors)"`, never the raw chart token, so the tooltip legend and the
mark stay in sync. Custom SVG text uses `className="fill-foreground"` — not a color prop.

`accessibilityLayer` is mandatory. Numeric literals use `_` separators (`89_400`).

---

## Drag and drop (dnd-kit)

The kanban board. Four things here are the difference between a demo and something
usable — copy all four.

**1. Three sensors, including keyboard.** Pointer and touch get activation constraints so
a click isn't swallowed as a drag; `KeyboardSensor` is what makes the board operable
without a mouse.

```tsx
const sensors = useSensors(
  useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
  useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
);
```

**2. A snapshot ref so cancel restores.** `onDragOver` mutates the board live for the
cross-column preview, so an escape or a drop on nothing must roll back:

```tsx
const boardBeforeDrag = React.useRef<BoardState>(initialBoard);

function handleDragStart(event: DragStartEvent) {
  if (event.active.data.current?.type === "column") return;
  boardBeforeDrag.current = board;          // snapshot before any preview mutation
  setActiveTask(findTask(board, String(event.active.id)) ?? null);
}

function handleDragCancel(event: DragCancelEvent) {
  if (event.active.data.current?.type !== "column") setBoard(boardBeforeDrag.current);
  setActiveTask(null);
}

function handleDragEnd(event: DragEndEvent) {
  const { over } = event;
  if (!over) { setBoard(boardBeforeDrag.current); return; }   // dropped outside → restore
  // ...
}
```

**3. Two drag types on one `DndContext`,** discriminated by `active.data.current?.type`.
Column drags reorder `columnOrder`; task drags mutate `board`. Every handler bails early
on the wrong type rather than branching deep.

**4. `onDragOver` moves between columns, `onDragEnd` reorders within one.** Both use the
functional `setBoard((currentBoard) => …)` form — the drag events fire faster than
React commits, so reading `board` from closure gives you stale state.

```tsx
<DndContext
  id="kanban-board"                       // stable id: avoids SSR/client id mismatch
  sensors={sensors}
  collisionDetection={closestCorners}     // correct for column-to-column; closestCenter is not
  onDragStart={handleDragStart}
  onDragOver={handleDragOver}
  onDragEnd={handleDragEnd}
  onDragCancel={handleDragCancel}
>
  <SortableContext items={columnOrder} strategy={horizontalListSortingStrategy}>
    {orderedColumns.map((column) => (
      <KanbanColumn key={column.id} column={column} tasks={board[column.id]} />
    ))}
  </SortableContext>

  <DragOverlay dropAnimation={null}>
    {activeTask ? <TaskCard task={activeTask} isOverlay /> : null}
  </DragOverlay>
</DndContext>
```

`DragOverlay` renders the floating card outside the scroll container — without it the
dragged card is clipped by `overflow` on the board. Pass an `isOverlay` prop so the card
can drop its shadow/hover styling in that mode.

Derived column order uses `flatMap` with a `?? []` fallback as a filter-and-map in one
pass — an id in `columnOrder` with no matching column silently drops rather than
rendering `undefined`:

```tsx
const orderedColumns = columnOrder.flatMap((id) => columns.find((c) => c.id === id) ?? []);
```

---

## Hooks

**Colocate first.** A hook used by one feature lives in that feature's `_components/` as
`use-<thing>.ts`. It moves to `src/hooks/` only when a second feature imports it.

Shared hooks are minimal and SSR-safe — note the `undefined` initial state so the first
render matches the server:

```ts
const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}
```

For external mutable sources (timers, subscriptions) use `useSyncExternalStore` with
**module-level** store instances so every consumer shares one ticker rather than each
mounting its own interval:

```ts
const compactWaveformTicker = createRealtimeTicker(COMPACT_WAVEFORM_TICK_INTERVAL_MS);
const trendTicker = createRealtimeTicker(1000);
const getInitialTick = () => 0;

export function useWaveformTick(compact: boolean) {
  const ticker = compact ? compactWaveformTicker : detailWaveformTicker;
  return useSyncExternalStore(ticker.subscribe, ticker.getSnapshot, getInitialTick) * monitoringSpeed;
}
```

Derivation hooks stay pure — take a tick and inputs, return memoized data. No effects:

```ts
export function usePatientTrendSeries({ kind, patient }: PatientTrendSeriesOptions) {
  const tick = useTrendTick();
  const definition = trendDefinitions[kind];
  const data = useMemo(() => createTrendWindow(patient, definition, tick), [definition, patient, tick]);

  return { ariaLabel: `${patient.bed} ${kind} trend`, data, domain: definition.domain, ticks: definition.ticks };
}
```

---

## State: two zustand flavors

**Flavor A — plain `create()`** for client-only state with no SSR concern. Wrap it in a
hook that returns a tuple so consumers don't touch the store directly:

```ts
import { create } from "zustand";

type MailStore = {
  mail: { selected: Mail["id"] | null };
  setMail: (mail: { selected: Mail["id"] | null }) => void;
};

const useMailStore = create<MailStore>((set) => ({
  mail: { selected: mails[0].id },
  setMail: (mail) => set({ mail }),
}));

export function useMail() {
  const mail = useMailStore((state) => state.mail);
  const setMail = useMailStore((state) => state.setMail);
  return [mail, setMail] as const;
}
```

**Flavor B — vanilla store + context provider** when the store must be seeded per
request (SSR) or scoped to a subtree. A module-level `create()` would leak state across
requests on the server.

```ts
// stores/preferences/preferences-store.ts
import { createStore } from "zustand/vanilla";

export const createPreferencesStore = (initialValues: Partial<PreferenceValueMap> = {}) => {
  const values: PreferenceValueMap = { ...PREFERENCE_DEFAULTS, ...initialValues };

  return createStore<PreferencesState>()((set) => ({
    values,
    resolvedThemeMode: values.theme_mode === "dark" ? "dark" : "light",
    isSynced: false,

    setPreference: (key, value) => {
      const resolvedThemeMode = applyPreference(key, value);   // DOM side effect
      set((state) => ({
        values: { ...state.values, [key]: value } as PreferenceValueMap,
        ...(resolvedThemeMode ? { resolvedThemeMode } : {}),
      }));
      void persistPreference(key, value);                      // fire-and-forget
    },
  }));
};
```

```tsx
// stores/preferences/preferences-provider.tsx
"use client";

const PreferencesStoreContext = createContext<StoreApi<PreferencesState> | null>(null);

export function PreferencesStoreProvider({ children, initialValues }: {
  children: React.ReactNode;
  initialValues: PreferenceValueMap;
}) {
  const [store] = useState<StoreApi<PreferencesState>>(() => createPreferencesStore(initialValues));

  // Re-sync from the DOM after hydration — the boot script may have set different values
  useEffect(() => {
    store.setState({
      values: readDomPreferences(),
      resolvedThemeMode: document.documentElement.classList.contains("dark") ? "dark" : "light",
      isSynced: true,
    });
  }, [store]);

  return <PreferencesStoreContext.Provider value={store}>{children}</PreferencesStoreContext.Provider>;
}

export function usePreferencesStore<T>(selector: (state: PreferencesState) => T): T {
  const store = use(PreferencesStoreContext) as StoreApi<PreferencesState> | null;
  if (!store) throw new Error("Missing PreferencesStoreProvider");
  return useStore(store, selector);
}
```

Rules: `useState(() => createStore(...))` so the store is created once per mount;
always take a **selector** (`usePreferencesStore((s) => s.values.theme_mode)`), never the
whole state; throw on a missing provider rather than returning a default; side effects
(DOM writes, persistence) live in the action, not in a component effect.

### Selecting several fields: `useShallow` is mandatory

A selector that returns an object builds a **new reference on every store update**, so a
plain selector re-renders the component on every unrelated change — and in React 19 can
loop. Wrap multi-field selectors in `useShallow`:

```tsx
import { useShallow } from "zustand/react/shallow";

const { values, resolvedThemeMode, setPreference, resetPreferences } = usePreferencesStore(
  useShallow((state) => ({
    values: state.values,
    resolvedThemeMode: state.resolvedThemeMode,
    setPreference: state.setPreference,
    resetPreferences: state.resetPreferences,
  })),
);
```

Single-field selectors need no wrapper — they return a primitive that compares by value:

```tsx
const themeMode = usePreferencesStore((s) => s.values.theme_mode);   // fine as-is
```

### Consuming an SSR-seeded store: the `isSynced` guard

This is the payoff for the whole preference architecture, and the piece that's easy to
miss. The boot script sets DOM attributes before hydration, and the provider copies them
into the store — but only *after* the first client render. Until then, the store still
holds the static defaults, which may not match what the server rendered.

So SSR-critical consumers **prefer their server-passed props until `isSynced` flips**:

```tsx
"use client";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { sidebarVariant, sidebarCollapsible, isSynced } = usePreferencesStore(
    useShallow((s) => ({
      sidebarVariant: s.values.sidebar_variant,
      sidebarCollapsible: s.values.sidebar_collapsible,
      isSynced: s.isSynced,
    })),
  );

  // Server-rendered props win until the store has read the real DOM values.
  const variant = isSynced ? sidebarVariant : props.variant;
  const collapsible = isSynced ? sidebarCollapsible : props.collapsible;

  return <Sidebar {...props} variant={variant} collapsible={collapsible}>{/* ... */}</Sidebar>;
}
```

The layout reads those preferences from cookies server-side and passes them down (see
`references/design-system.md`, "Layout-critical prefs also read server-side"). Drop the
`isSynced` check and you get a hydration mismatch or a one-frame flash of the default
sidebar. Preferences that don't affect SSR markup (theme preset, font) don't need it.

Note the props type: `React.ComponentProps<typeof Sidebar>` — wrapper components around a
shadcn primitive derive their props from it and spread through, rather than re-declaring
the surface.

---

## Server actions

One `"use server"` module at `src/server/server-actions.ts`. Keep it thin — cookie I/O
and typed reads, no business logic:

```ts
"use server";

export async function getValueFromCookie(key: string): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(key)?.value;
}

export async function setValueToCookie(
  key: string,
  value: string,
  options: { path?: string; maxAge?: number } = {},
): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(key, value, {
    path: options.path ?? "/",
    maxAge: options.maxAge ?? 60 * 60 * 24 * 7, // default: 7 days
  });
}

export async function getPreference<K extends PreferenceKey>(key: K): Promise<PreferenceValueMap[K]> {
  const definition = PREFERENCE_REGISTRY[key];
  const persistence = getPreferencePersistence(key);

  if (persistence !== "client-cookie" && persistence !== "server-cookie") {
    return definition.defaultValue as PreferenceValueMap[K];
  }

  const cookieStore = await cookies();
  return parsePreference(key, cookieStore.get(key)?.value.trim());
}
```

Client-side cookie/storage helpers are separate `*.client.ts` modules — the `.client`
suffix marks the boundary at a glance.

---

## Navigation as typed data

Nav lives in `src/navigation/sidebar/sidebar-items.ts` as a typed array, not JSX. See
`references/typescript.md` §6 for the link-vs-parent discriminated union.

```ts
export const sidebarItems: NavGroup[] = [
  {
    id: 1,
    label: "Dashboards",
    items: [
      { id: "default", title: "Default", url: "/dashboard/default", icon: LayoutDashboard },
      { id: "file-manager", title: "File Manager", url: "/dashboard/file-manager", icon: FolderOpen, badge: "new" },
    ],
  },
  {
    id: 2,
    label: "Pages",
    items: [
      {
        id: "authentication",
        title: "Authentication",
        icon: Fingerprint,
        subItems: [
          { id: "auth-login-v1", title: "Login v1", url: "/auth/v1/login", newTab: true },
        ],
      },
    ],
  },
];
```

Every item and group carries a stable `id` — used as the React key and for active-state
matching, so reordering or retitling never breaks either. Adding a screen means adding
one object here; the sidebar renderer needs no change.

---

## Seed / mock data

- Small, typed: `data.ts` exporting a typed const.
- Large, flat rows: `data.json`, imported directly (`resolveJsonModule` is on).
- Cross-feature: `src/data/`.

Keep data files free of JSX and formatting logic — display concerns belong in `columns.tsx`
or a `formatters.ts`:

```ts
export function formatOrderCount(filter: OrderFilter, count: number) {
  const orderLabel = count === 1 ? "order" : "orders";
  if (filter === "All") return `${count.toLocaleString()} ${orderLabel}`;
  if (filter === "Needs action") return `${count.toLocaleString()} ${orderLabel} need action`;
  return `${count.toLocaleString()} ${filter.toLowerCase()} ${orderLabel}`;
}
```

---

## Config to copy into a new project

**`next.config.mjs`**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactCompiler: true,
  compiler: { removeConsole: process.env.NODE_ENV === "production" },
  async redirects() {
    return [{ source: "/dashboard", destination: "/dashboard/default", permanent: false }];
  },
};

export default nextConfig;
```

**`tsconfig.json`** — strict, bundler resolution, `@/*` → `./src/*`, the `next` plugin,
`resolveJsonModule` and `isolatedModules` on.

**`components.json`** — `rsc: true`, `tsx: true`, `cssVariables: true`,
`css: "src/app/globals.css"`, aliases for `components` / `ui` / `lib` / `hooks` / `utils`,
`iconLibrary: "lucide"`.

**`biome.json`** — the notable bits:

```jsonc
{
  "files": {
    // never lint or format generated/vendored UI
    "includes": ["**", "!node_modules", "!.next", "!src/components/ui", "!src/components/calendar"]
  },
  "assist": {
    "actions": { "source": { "organizeImports": { "level": "on", "options": { "groups": [
      "react", "react/**", ":BLANK_LINE:",
      "next/**", ":BLANK_LINE:",
      ":PACKAGE:", ":BLANK_LINE:",
      ":ALIAS:", ":BLANK_LINE:",
      ":PATH:"
    ] } } } }
  },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 120, "lineEnding": "lf" },
  "javascript": { "formatter": { "quoteStyle": "double", "jsxQuoteStyle": "double", "semicolons": "always", "trailingCommas": "all", "arrowParentheses": "always" } },
  "linter": {
    "domains": { "next": "recommended", "react": "recommended" },
    "rules": {
      "correctness": { "noUndeclaredVariables": "error", "noNestedComponentDefinitions": "error", "noUndeclaredDependencies": "error" },
      "nursery": { "useSortedClasses": "on", "useNullishCoalescing": "error", "noFloatingPromises": "error", "noMisusedPromises": "error" },
      "style": { "useFilenamingConvention": "error", "useAsConstAssertion": "error", "noInferrableTypes": "error", "noUselessElse": "error", "noNestedTernary": "warn" },
      "suspicious": { "noImportCycles": "error", "noArrayIndexKey": "warn", "noUnnecessaryConditions": "warn" }
    }
  }
}
```

`useSortedClasses` means Tailwind class order is machine-enforced — don't fight it.

**`package.json` scripts** — `lint` / `format` / `check` / `check:fix` via biome, plus
husky + lint-staged running `biome check --write` on staged `*.{js,ts,jsx,tsx}`.

**Suppressions are justified inline**, never blanket-disabled:

```ts
// biome-ignore lint/suspicious/noDocumentCookie: This project still uses document.cookie for broad browser support.
```
