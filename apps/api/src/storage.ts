import { HTTPException } from "hono/http-exception";

import { env } from "./env";

/**
 * Product images.
 *
 * Bytes go to Supabase Storage, which is configured with an S3 backend
 * pointed at Cloudflare R2 (docs/setup.md C5). This module talks to
 * Storage's REST API with the service key, the same way routes/auth.ts
 * talks to GoTrue -- no S3 SDK here, and no R2 credentials in this
 * process: the storage container holds them.
 *
 * THE WRITE PATH AND THE READ PATH ARE DIFFERENT, deliberately.
 *
 *   Writes go through Storage. It already exists, it already
 *   authenticates, and an upload happens once per image.
 *
 *   Reads do not. STORAGE_PUBLIC_URL points at a custom domain on the R2
 *   bucket, so a storefront's <img src> hits Cloudflare's edge and never
 *   touches this service. Serving images back through
 *   /storage/v1/object/public/... would proxy every byte through the
 *   container -- your bandwidth, your CPU, and the single reason to be
 *   on R2 at all, no egress charge, thrown away.
 *
 * Which is why the stored URL is built from configuration rather than
 * from wherever the upload happened to land: the domain can go in front
 * later without rewriting a single row.
 */

const STORAGE_TIMEOUT_MS = 30_000;

/**
 * Magic bytes, because Content-Type is whatever the client typed.
 *
 * An HTML file announced as image/png, served from a domain a browser
 * trusts, is stored XSS. The separate image domain limits the blast
 * radius -- it is not the app's origin -- but sniffing twelve bytes is
 * cheaper than reasoning about that, and it catches the honest half of
 * the problem too: a .heic renamed to .jpg is a broken image on every
 * product page, found by a customer.
 */
const SIGNATURES: { ext: string; mime: string; match: (b: Uint8Array) => boolean }[] = [
  {
    ext: "jpg",
    mime: "image/jpeg",
    match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: "png",
    mime: "image/png",
    match: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    // RIFF....WEBP. The container is RIFF, so bytes 8-11 are the part
    // that says which kind of RIFF.
    ext: "webp",
    mime: "image/webp",
    match: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  {
    // ISO-BMFF: ....ftypavif. HEIC has the same box layout and a
    // different brand, which is why the brand is checked and not `ftyp`.
    ext: "avif",
    mime: "image/avif",
    match: (b) =>
      b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 &&
      b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && b[11] === 0x66,
  },
];

/** What this actually is, or null if it is not an image we serve. */
export function sniffImageType(bytes: Uint8Array): { ext: string; mime: string } | null {
  if (bytes.length < 12) return null;
  const hit = SIGNATURES.find((s) => s.match(bytes));
  return hit ? { ext: hit.ext, mime: hit.mime } : null;
}

/** True once a bucket is configured. Without one the routes answer 503. */
export const storageConfigured = (): boolean => Boolean(env.STORAGE_BUCKET);

function requireStorage(): string {
  if (!env.STORAGE_BUCKET) {
    throw new HTTPException(503, {
      message: "Image storage is not configured on this deployment.",
      cause: { code: "storage_unconfigured" },
    });
  }
  return env.STORAGE_BUCKET;
}

/**
 * The object's public address.
 *
 * Falls back to Storage's own public URL when no custom domain is set,
 * so a deployment works before the DNS does -- correct, and paying
 * egress it need not. setup.md C5 says as much; a request is not the
 * place to fail over it.
 */
export function publicUrl(path: string): string {
  const base = env.STORAGE_PUBLIC_URL;
  if (base) return `${base.replace(/\/$/, "")}/${path}`;
  return `${env.SUPABASE_URL}/storage/v1/object/public/${requireStorage()}/${path}`;
}

async function storage(
  method: "POST" | "DELETE",
  path: string,
  // Blob rather than the raw Uint8Array: packages/client typechecks this
  // file without @types/bun, and lib.dom's BodyInit does not accept a
  // Uint8Array<ArrayBufferLike>. A Bun-only type here fails the build of
  // whichever front end imports AppType next.
  init?: { body?: Blob; contentType?: string },
): Promise<Response> {
  const bucket = requireStorage();
  try {
    return await fetch(`${env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
      method,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        ...(init?.contentType ? { "Content-Type": init.contentType } : {}),
        // Storage's own default is 3600. An image at a given key never
        // changes -- a replacement gets a new uuid -- so a year is honest
        // and stops the CDN asking again for something that cannot differ.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
      body: init?.body,
      // Longer than SUPABASE_TIMEOUT_MS: this one is moving megabytes,
      // not asking a question.
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new HTTPException(502, {
      message: "The storage service could not be reached. Try again.",
      cause: { code: "storage_unavailable", db: (err as Error).message },
    });
  }
}

/**
 * Uploads, and returns the object path.
 *
 * The key is generated here and never taken from the upload. A filename
 * arriving over HTTP is an attacker's string: `../` walks out of the
 * prefix, a leading `/` re-roots it, and a repeated name silently
 * overwrites somebody else's photograph. A uuid has none of those
 * properties.
 */
export async function uploadImage(
  productId: string,
  // Uint8Array<ArrayBuffer>, not bare Uint8Array: the default parameter is
  // ArrayBufferLike, which includes SharedArrayBuffer and is therefore not
  // a BlobPart. It comes from file.arrayBuffer(), so this is a narrowing
  // rather than an assumption.
  bytes: Uint8Array<ArrayBuffer>,
  kind: { ext: string; mime: string },
): Promise<{ path: string; url: string }> {
  const path = `products/${productId}/${crypto.randomUUID()}.${kind.ext}`;
  const res = await storage("POST", path, {
    body: new Blob([bytes], { type: kind.mime }),
    contentType: kind.mime,
  });

  if (!res.ok) {
    throw new HTTPException(502, {
      message: "The image could not be stored. Try again.",
      cause: { code: "storage_write_failed", db: `${res.status} ${await res.text()}` },
    });
  }
  return { path, url: publicUrl(path) };
}

/**
 * Best effort, and the caller is expected to treat it as such.
 *
 * An object left behind with no row costs a fraction of a cent and is
 * invisible. A row left behind with no object is a broken image on a
 * product page. So the row goes first and this runs after -- and when it
 * fails, a log line is the only thing that should happen.
 */
export async function deleteObject(
  path: string,
): Promise<{ gone: boolean; detail: string }> {
  const res = await storage("DELETE", path);
  // `gone` is not "this call removed it". It is "the object is no longer
  // there", which is equally true when it was already absent. Storage
  // answers a missing key with 404, and some versions with a 400 whose
  // body says not found. Both mean the caller has what it asked for, and
  // treating them as failure is how a queue row retries forever against
  // something that cannot be removed twice.
  if (res.ok || res.status === 404) return { gone: true, detail: String(res.status) };

  const body = (await res.text()).slice(0, 300);
  if (/not[_ ]?found|does not exist/i.test(body)) {
    return { gone: true, detail: `${res.status} ${body}` };
  }
  return { gone: false, detail: `${res.status} ${body}` };
}

/**
 * The object path back out of a stored URL.
 *
 * Null when the URL points somewhere this service did not put it -- an
 * image added by hand in psql, or one still on the old host after a
 * migration. Dropping the row is right in that case; guessing at a key
 * to delete is not.
 */
export function pathFromUrl(url: string): string | null {
  for (const base of [
    env.STORAGE_PUBLIC_URL?.replace(/\/$/, ""),
    env.STORAGE_BUCKET
      ? `${env.SUPABASE_URL}/storage/v1/object/public/${env.STORAGE_BUCKET}`
      : undefined,
  ]) {
    if (base && url.startsWith(`${base}/`)) return url.slice(base.length + 1);
  }
  return null;
}
