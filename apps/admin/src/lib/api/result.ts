import { type ApiError, readApiError } from "@/lib/api-error";

/**
 * Success or the API's own error, never a thrown exception.
 *
 * Throwing would hit Next's error boundary, which renders a generic page and
 * discards the one thing worth showing -- the API's message and its
 * requestId. A Server Component that wants to render "this discount code
 * expired" cannot do that from an error boundary.
 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** The shape hc gives back: a union, one member per declared status. */
interface AnyClientResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

/**
 * Unwrap an hc response into a Result.
 *
 * `Extract<R, { ok: true }>` is the load-bearing part. hc types the response
 * as a UNION -- one member per status the route declares -- and types `ok` as
 * a literal true or false on each. A plain `unwrap<T>` collapses that union
 * and infers T from the error branch, which compiles and then insists the
 * success payload has an `error` property.
 *
 * So the success type is extracted from the union rather than inferred from
 * it, and nothing is ever declared by hand: it still comes from the zod
 * schema the route validates with.
 */
export async function unwrap<R extends AnyClientResponse>(
  res: R,
): Promise<Result<Awaited<ReturnType<Extract<R, { ok: true }>["json"]>>>> {
  if (res.ok) {
    return { ok: true, data: (await res.json()) as Awaited<ReturnType<Extract<R, { ok: true }>["json"]>> };
  }
  return { ok: false, error: await readApiError(res as unknown as Response) };
}
