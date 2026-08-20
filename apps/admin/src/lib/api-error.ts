/**
 * The API's failure envelope: `{ error: { code, message, requestId? } }`.
 *
 * READ, NEVER REWRITE. api-plan B2 owns the constraint→English mapping, and
 * it lives beside the constraint that raises it. Restating that copy here
 * would put two versions of the same sentence in two repositories, and the
 * one users see would be whichever drifted last.
 */
export interface ApiError {
  code: string;
  message: string;
  /** Present on server-side failures. The handle into the logs. */
  requestId?: string;
}

const FALLBACK = "Something went wrong. Try again.";

/**
 * Pull the envelope out of a failed Response.
 *
 * Never throws. A failure while handling a failure is how a bad gateway
 * becomes a blank page -- if the body is not JSON, or not the envelope
 * (Traefik's own 502 page, say), the caller still gets something to render.
 */
export async function readApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: Partial<ApiError> };
    const message = body.error?.message;
    if (typeof message === "string" && message.length > 0) {
      return {
        code: body.error?.code ?? String(res.status),
        message,
        requestId: body.error?.requestId,
      };
    }
  } catch {
    // Not JSON. Fall through.
  }

  return { code: String(res.status), message: FALLBACK };
}
