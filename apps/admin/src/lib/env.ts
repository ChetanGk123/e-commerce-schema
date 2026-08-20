import { z } from "zod";

const envSchema = z.object({
  APP_URL: z.string().url().default("http://localhost:3000"),

  // Where apps/api is. Server-only on purpose and NOT NEXT_PUBLIC_: this app
  // reaches the API from the server side, and inside a container the address
  // is http://api:3001, which is meaningless to a browser. Phase 1 of
  // docs/admin-plan.md builds the client that uses it.
  API_URL: z.string().url().default("http://localhost:3001"),
});

// Server-only, so it is read at runtime and one image can serve every environment.
// Anything prefixed `NEXT_PUBLIC_` is inlined into the bundle at build time instead,
// which pins it to the environment it was built for — and Next only inlines literal
// member access, so such a variable has to be spelled out rather than passed as
// `process.env`.
const parsed = envSchema.safeParse({
  APP_URL: process.env.APP_URL,
  API_URL: process.env.API_URL,
});

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n");
  throw new Error(`Invalid environment variables:\n${issues}`);
}

export const env = parsed.data;
