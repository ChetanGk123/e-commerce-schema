import { STAFF_ROLES } from "@ecom/schema/enums";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireAuth, requireStaff } from "../auth";

const MeResponse = z
  .object({
    userId: z.string().uuid(),
    isStaff: z.boolean(),
    role: z.enum(STAFF_ROLES).nullable(),
    fullName: z.string().nullable(),
  })
  .openapi("MeResponse");

const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      requestId: z.string().optional(),
    }),
  })
  .openapi("ErrorResponse");

const me = createRoute({
  method: "get",
  path: "/me",
  tags: ["auth"],
  summary: "Who the caller is",
  description:
    "The admin shell calls this to resolve the signed-in staff member and gate its nav. A customer's token is valid auth but has no staff_users row, so it answers 403 -- that missing row is the only thing keeping shoppers out of the admin surface.",
  middleware: [requireAuth, requireStaff] as const,
  responses: {
    200: {
      description: "Caller resolved",
      content: { "application/json": { schema: MeResponse } },
    },
    401: {
      description: "Missing or invalid token",
      content: { "application/json": { schema: ErrorResponse } },
    },
    403: {
      description: "Authenticated, but not active staff",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export const meRoute = new OpenAPIHono().openapi(me, (c) => {
  const { userId, staff } = c.get("caller");
  return c.json(
    {
      userId,
      isStaff: staff !== null,
      role: staff?.role ?? null,
      fullName: staff?.fullName ?? null,
    },
    200,
  );
});
