/**
 * Money and dates, in the store's locale.
 *
 * Formatters are built ONCE at module scope. Intl constructors are
 * expensive, and a table of 50 rows building one per cell is the cheapest
 * possible thing to get wrong.
 */

/**
 * The database stores paise, not rupees -- integers, because binary floats
 * cannot hold 0.1 and money that cannot round-trip is money that goes
 * missing. Dividing happens here, at the edge, and nowhere else.
 */
const RUPEES = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
});

export function formatMoney(paise: number): string {
  return RUPEES.format(paise / 100);
}

/**
 * Asia/Kolkata, always. The server may be anywhere; a staff member reading
 * "shipped at 19:04" wants the shop's clock, not UTC and not the browser's
 * guess -- which would also make a screenshot mean different things to two
 * people looking at the same order.
 */
const DATE = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  dateStyle: "medium",
});

const DATE_TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : DATE.format(d);
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : DATE_TIME.format(d);
}
