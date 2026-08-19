import { SignJWT } from "jose";

/**
 * The stack these tests need, and what they deliberately leave out.
 *
 * `make test-api` puts PostgREST in front of the same throwaway Postgres
 * `make verify` already builds, with the schema and seed loaded. That is
 * enough to exercise the seam the other two suites cannot reach: whether
 * checkout()'s parameter names match what the route sends, whether RLS
 * permits the select list a handler asks for, whether a renamed RPC
 * breaks anything.
 *
 * NO GOTRUE. apps/api verifies JWTs itself against the shared secret --
 * only /auth/* proxies to the auth service -- so the harness signs its
 * own tokens with the same secret PostgREST is configured with. That is
 * not a shortcut around auth; it is the same HS256 token a real sign-in
 * would hand back, which is why RLS believes it.
 */
export const PGRST_URL = process.env.INTEGRATION_PGRST_URL;
const SECRET = process.env.INTEGRATION_JWT_SECRET ?? "";

/** True when `make test-api` set the stack up. */
export async function stackIsUp(): Promise<boolean> {
  if (!PGRST_URL || !SECRET) return false;
  try {
    const res = await fetch(PGRST_URL, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

const key = () => new TextEncoder().encode(SECRET);

/**
 * A token in the shape Supabase issues.
 *
 * `role` is the load-bearing claim: PostgREST reads it and SETs that
 * database role for the request, which is what makes RLS apply to the
 * right person. `sub` is what auth.uid() returns.
 */
export function mintToken(
  role: "anon" | "authenticated" | "service_role",
  sub?: string,
): Promise<string> {
  const jwt = new SignJWT({ role, ...(sub ? { sub } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h");
  return jwt.sign(key());
}

/**
 * supabase-js requests `${SUPABASE_URL}/rest/v1/...` because that is
 * where Kong puts PostgREST. PostgREST itself serves from the root, so
 * something has to strip the prefix. In production that is Kong; here it
 * is twelve lines, rather than a fourth container whose only job is a
 * path rewrite.
 */
export function startKongStandIn(): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const target = new URL(PGRST_URL!);
      url.protocol = target.protocol;
      url.host = target.host;
      url.pathname = url.pathname.replace(/^\/rest\/v1/, "");
      return fetch(url, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
      });
    },
  });
  return { url: server.url.origin, stop: () => void server.stop(true) };
}

/**
 * Everything env.ts demands, pointed at the stand-in.
 *
 * Must run before app.ts is imported -- env.ts validates at import time --
 * so the test file imports the app dynamically after calling this.
 */
export async function configureEnv(kongUrl: string): Promise<void> {
  process.env.SUPABASE_URL = kongUrl;
  // Real Supabase keys are themselves JWTs carrying the role. supabase-js
  // sends the key as both `apikey` and `Authorization`, so PostgREST
  // reads the role straight out of it -- which is exactly how the service
  // client ends up bypassing RLS here as it does in production.
  process.env.SUPABASE_ANON_KEY = await mintToken("anon");
  process.env.SUPABASE_SERVICE_ROLE_KEY = await mintToken("service_role");
  process.env.SUPABASE_JWT_SECRET = SECRET;
  process.env.JOBS_INTERVAL_SECONDS = "0";
  process.env.RATE_LIMIT_PER_MINUTE = "0";
}

/** One value back out of the database, for asserting what a trigger did. */
export async function sqlValue(query: string): Promise<string> {
  const proc = Bun.spawn(
    ["docker", "exec", "-i", "ecomm-verify", "psql", "-U", "postgres", "-tAc", query],
    { stdout: "pipe", stderr: "pipe" },
  );
  if ((await proc.exited) !== 0) {
    throw new Error(`psql failed: ${await new Response(proc.stderr).text()}`);
  }
  return (await new Response(proc.stdout).text()).trim();
}

/** Direct SQL, for arranging rows the API has no endpoint to create. */
export async function sql(statement: string): Promise<void> {
  const proc = Bun.spawn(
    ["docker", "exec", "-i", "ecomm-verify", "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q"],
    { stdin: new TextEncoder().encode(statement), stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`psql failed: ${await new Response(proc.stderr).text()}`);
  }
}
