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

/**
 * True when `make test-api` set the stack up.
 *
 * The skip exists for a laptop with no Docker: plain `bun test` should
 * stay green there, because a suite that fails without containers gets
 * deleted and then none of this is tested at all.
 *
 * But "no stack configured" and "the stack was configured and did not
 * come up" are different, and only the first is a reason to skip. If
 * `make test-api` asked for a stack and PostgREST cannot be reached,
 * skipping turns a broken stack into a green run of eighty tests that
 * never executed -- which is the exact shape of failure the rest of this
 * repo keeps finding. So that one throws.
 */
export async function stackIsUp(): Promise<boolean> {
  if (!PGRST_URL || !SECRET) return false;

  let reason: string;
  try {
    const res = await fetch(PGRST_URL, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) return true;
    reason = `answered ${res.status}`;
  } catch (err) {
    reason = (err as Error).message;
  }

  throw new Error(
    `INTEGRATION_PGRST_URL is set to ${PGRST_URL} but PostgREST ${reason}. ` +
      `The stack was asked for and did not come up; refusing to skip, because ` +
      `a skipped suite here is indistinguishable from a passing one.`,
  );
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
/** Makes the stand-in answer a sign-in with 503 instead of 400. */
export const OUTAGE_PASSWORD = "__auth_service_is_down__";

export function startKongStandIn(): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      // The one GoTrue answer the lockout depends on, and no more than
      // that. Still not an auth service: the password picks the status,
      // so a test can ask for "those credentials are wrong" or "the auth
      // service is having a bad afternoon" and check that only the first
      // one counts against an account.
      if (url.pathname.startsWith("/auth/v1/token")) {
        const body = (await req.json()) as { password?: string };
        return Response.json(
          { error: "invalid_grant", error_description: "Invalid login credentials" },
          { status: body.password === OUTAGE_PASSWORD ? 503 : 400 },
        );
      }

      // Storage, enough of it to pin the one rule the sweeper depends
      // on: an object that is already absent counts as collected. The
      // key decides the answer, so a test can ask for "gone", "was never
      // there" and "storage is having a bad afternoon" and check that
      // only the last one is worth retrying.
      // Listing, modelled the way Storage actually behaves: delimiter
      // based, one level at a time, folders coming back as entries with
      // a null id. A stand-in that returned every key flat would let a
      // broken recursive walk pass.
      if (url.pathname.startsWith("/storage/v1/object/list/")) {
        const { prefix } = (await req.json()) as { prefix: string };
        const seen = new Set<string>();
        const entries: unknown[] = [];
        const at = prefix ? `${prefix}/` : "";

        for (const key of BUCKET_KEYS) {
          if (!key.startsWith(at)) continue;
          const rest = key.slice(at.length);
          const slash = rest.indexOf("/");
          if (slash === -1) {
            entries.push({ name: rest, id: `id-${key}`, created_at: BUCKET_CREATED_AT });
          } else if (!seen.has(rest.slice(0, slash))) {
            seen.add(rest.slice(0, slash));
            entries.push({ name: rest.slice(0, slash), id: null, created_at: null });
          }
        }
        return Response.json(entries, { status: 200 });
      }

      if (url.pathname.startsWith("/storage/v1/object/")) {
        if (url.pathname.includes("missing")) {
          return Response.json({ error: "Object not found" }, { status: 404 });
        }
        if (url.pathname.includes("broken")) {
          return Response.json({ error: "internal" }, { status: 500 });
        }
        return Response.json({ Key: url.pathname }, { status: 200 });
      }

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
/** The browser origin configureEnv() allows. */
export const ALLOWED_ORIGIN = "https://store.test";

/** Stands in for the R2 custom domain. Image URLs are built from this. */
export const STORAGE_PUBLIC_URL = "https://img.test";

/**
 * What the stand-in bucket contains. Nested two deep like the real keys,
 * so a listing that forgets to recurse finds folders and no files.
 */
export const BUCKET_KEYS = [
  "products/p1/kept.jpg",
  "products/p1/orphan.jpg",
  "products/p2/deep.jpg",
];

/** Old enough to clear any age threshold a test does not want to fight. */
export const BUCKET_CREATED_AT = "2020-01-01T00:00:00.000Z";

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
  // One allowed browser origin, so the caching tests can check that a 304
  // still carries the CORS headers a browser needs to accept it.
  process.env.CORS_ORIGINS = ALLOWED_ORIGIN;
  // Image storage, pointed at the stand-in above. The public URL matches
  // the prefix the GC tests queue their fixtures under, so pathFromUrl()
  // resolves them exactly as it would resolve a real upload.
  process.env.STORAGE_BUCKET = "test-images";
  process.env.STORAGE_PUBLIC_URL = STORAGE_PUBLIC_URL;
  // On here, off by default in production. The srcset path is only
  // exercisable with the flag set at import time, and this is the one
  // suite that controls env before importing the app.
  process.env.IMAGE_RESIZE_CDN = "true";
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
