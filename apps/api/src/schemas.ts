import type { Hook } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import type { Env } from "hono";

/**
 * The one error envelope. app.ts emits exactly this shape from onError and
 * notFound, so a client can branch on `error.code` and quote `error.requestId`
 * to support without parsing prose.
 *
 * It lives here rather than in a route file because four routers now describe
 * it, and `.openapi("ErrorResponse")` may only register the name once.
 */
export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      requestId: z.string().optional(),
    }),
  })
  .openapi("ErrorResponse");

/** Shorthand for the failure entries in a route's `responses`. */
export const jsonError = (description: string) =>
  ({
    description,
    content: { "application/json": { schema: ErrorResponse } },
  }) as const;

/** Paging shared by every list endpoint. */
export const PAGE_DEFAULT = 24;
export const PAGE_MAX = 60;

export const pageQuery = {
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
};

/**
 * Validation failures, in the same envelope as everything else.
 *
 * Without this @hono/zod-openapi answers with its own shape --
 * `{ success: false, error: { issues: [...], name: "ZodError" } }` -- so a
 * client branching on `error.code` gets undefined for every bad request, and
 * the 400 documented above is a lie.
 *
 * The message comes from the zod schema, which means it is copy we wrote
 * ("Enter a valid 6-digit PIN code"), not a database or framework string.
 * Only the first issue is returned: a form shows one error at a time, and the
 * full issue list is a free map of the accepted shape.
 */
export const validationHook: Hook<unknown, Env, string, unknown> = (
  result,
  c,
) => {
  if (result.success) return;

  const issue = result.error.issues[0];
  const field = issue?.path.join(".");
  return c.json(
    {
      error: {
        code: "invalid_request",
        message: issue
          ? `${field ? `${field}: ` : ""}${issue.message}`
          : "Invalid request",
        requestId: c.get("reqId"),
      },
    },
    400,
  );
};
