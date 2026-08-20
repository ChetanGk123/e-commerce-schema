/**
 * List state lives in the URL, not in component state.
 *
 * A filtered, sorted, paged view is a thing people link to, bookmark, and
 * send to a colleague with "look at this one". Holding that in useState
 * makes the address bar a lie and the back button do nothing.
 *
 * Server Components read these directly from `searchParams`, so a page is
 * rendered from its URL and nothing has to be re-synced after navigation.
 */

export interface ListParams {
  q?: string;
  limit: number;
  offset: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function one(value: string | string[] | undefined): string | undefined {
  // `?q=a&q=b` gives an array. Take the first rather than joining, which
  // would search for "a,b" and find nothing.
  return Array.isArray(value) ? value[0] : value;
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? "", 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Clamped here as well as in the API. The API is the one that matters --
 * this is a URL anyone can edit -- but clamping early means a pasted
 * `?limit=99999` renders a sensible page instead of a 400.
 */
export function parseListParams(searchParams: Record<string, string | string[] | undefined>): ListParams {
  const q = one(searchParams.q)?.trim();
  return {
    // The API rejects a single character (`min(2)`), so treat it as absent
    // rather than sending something it will refuse.
    q: q && q.length >= 2 ? q : undefined,
    limit: int(one(searchParams.limit), DEFAULT_LIMIT, 1, MAX_LIMIT),
    offset: int(one(searchParams.offset), 0, 0, 100_000),
  };
}

/** Build the href for another page of the same view, keeping the filters. */
export function pageHref(pathname: string, params: ListParams, offset: number): string {
  const next = new URLSearchParams();
  if (params.q) next.set("q", params.q);
  if (params.limit !== DEFAULT_LIMIT) next.set("limit", String(params.limit));
  if (offset > 0) next.set("offset", String(offset));
  const qs = next.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * Turn list state into the query the API expects.
 *
 * Two rules live here so no call site has to restate them:
 *
 *   `q` is OMITTED when absent, never sent empty -- the API requires at
 *   least two characters, so `q=""` would fail a page that simply has no
 *   search term.
 *
 *   `limit` and `offset` are NUMBERS. They travel as query text, but the
 *   route parses them with a coercing number schema, so numbers are what it
 *   is typed to accept.
 */
export function toQuery(params: ListParams): { q?: string; limit: number; offset: number } {
  return {
    ...(params.q ? { q: params.q } : {}),
    limit: params.limit,
    offset: params.offset,
  };
}
