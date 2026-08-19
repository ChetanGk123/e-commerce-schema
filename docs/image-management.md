# Image management

How images get into this store, and how they leave.

Upload already works. **Deletion does not**, in the one case that matters, and this
document is mostly about that.

**Companion**: `docs/setup.md` C5a (the R2 configuration) · `apps/api/src/storage.ts` (the
code) · `docs/production-readiness.md` #1 (why images came last)

---

## What exists today

| | |
|---|---|
| `POST /admin/products/{id}/images` | multipart upload, staff only. Type read from the first bytes, not `Content-Type`. Key is a uuid this service generates |
| `PATCH /admin/images/{id}` | alt text, position, variant assignment |
| `DELETE /admin/images/{id}` | row first, then the object, best effort |
| `apps/api/src/storage.ts` | `uploadImage`, `deleteObject`, `publicUrl`, `pathFromUrl`, `sniffImageType` |
| Write path | API → Supabase Storage → R2 |
| Read path | `STORAGE_PUBLIC_URL`, a custom domain on the bucket. Images never touch this service |

Bytes live in Cloudflare R2. Supabase Storage is the authenticated write API in front of
it, so this process needs no S3 SDK and holds no R2 credentials.

---

## The problem, precisely

An orphan is an object in the bucket that no row points at. You pay for it forever and
nothing ever tells you it is there. There are **five** ways to make one, and they are not
equally likely.

### 1. `ON DELETE CASCADE` — the big one

```
product_images_product_id_fkey            → products(id)                     ON DELETE CASCADE
product_images_variant_id_product_id_fkey → product_variants(id, product_id) ON DELETE CASCADE
```

Delete a product, or a variant, and its image rows vanish. **The API is not involved and
cannot be.** There is no `DELETE /admin/products/{id}` route — products are archived
through `status` — so today this happens exclusively in psql, which is exactly how this
store is currently administered. A product with twelve photographs is deleted, twelve rows
disappear, twelve objects remain, and no log line anywhere mentions it.

This single fact decides the design. **The instruction to delete an object cannot come from
the API, because the deletion it must react to happens in the database.**

### 2. `DELETE /admin/images/{id}` where the object delete fails

Already handled as well as it can be: the row goes first, the object after, and a failure
logs `storage.orphaned_object` rather than 500-ing. That is the right trade — a row with no
object is a broken image on a product page; an object with no row is invisible and costs a
fraction of a cent — but it does leave an orphan, and nothing collects it.

### 3. Upload succeeds, insert fails

`uploadImage()` runs, then the `product_images` insert runs. A bad `variant_id` violates
the composite foreign key and the object is already in the bucket. The product is checked
first; the variant is not.

### 4. Objects nothing ever rowed

A crash between upload and insert. A future direct-to-bucket upload the client abandons.
Multipart uploads Storage never finalises. None of these leave any trace in Postgres, so no
database-driven mechanism can ever find them.

### 5. Replacement

There is no "replace this image" endpoint, deliberately — a key that never changes is what
lets the CDN cache it for a year. Replacement is an upload plus a delete, so it inherits
case 2. Stated here so nobody adds an in-place replace later without reading this.

### And the reverse

A row pointing at an object that is gone is a **broken image on a live product page**. It is
the more visible failure and the cheaper one to detect, so the reconciler reports it even
though it never deletes anything to fix it.

---

## Storage: staying on Supabase Storage over R2

Worth re-asking here, because garbage collection needs an operation upload did not:
**listing the bucket**. Both options can do it.

| | Supabase Storage (current) | R2 direct, via S3 API |
|---|---|---|
| New dependency | none | `aws4fetch` (~5KB) or `@aws-sdk/client-s3` (large) |
| R2 credentials in this process | no — the storage container holds them | yes |
| List, for reconciliation | `POST /storage/v1/object/list/{bucket}`, paginated | `ListObjectsV2`, paginated |
| Upload memory | **whole file buffered in the API process** | presigned PUT — bytes never touch us |
| Delete | one call | one call |

**Recommendation: stay on Supabase Storage.** It is built, it needs no new dependency, and
it keeps R2 credentials out of this process. The one real advantage of going direct —
presigned uploads that skip the API entirely — is a memory concern rather than a
correctness one, and is written up as T13 rather than a reason to rewrite the write path
now.

---

## Design: three layers, each catching what the one before cannot

```
row deleted ──▶ [1] trigger enqueues the path ──▶ [2] sweeper deletes the object
                                                        │
                          objects that never had a row ──┴──▶ [3] reconciler
```

**Layer 1 — a queue table written by a trigger.** `AFTER DELETE ON product_images` inserts
the object path into `storage_gc_queue`. This is the only mechanism that survives a
cascade, which is the entire reason it exists rather than deleting from the route handler.
Same shape as `message_log` and `claim_outbox` already in this repo: enqueue inside the
transaction that caused it, drain outside.

**Layer 2 — a sweeper on the jobs tick.** Claims a batch `FOR UPDATE SKIP LOCKED`, calls
Storage DELETE, removes the row on success, increments `attempts` on failure. Exactly the
outbox drain, for exactly the same reason: the delete is an external call and must not sit
inside the transaction that triggered it.

**Layer 3 — a reconciler.** Lists the bucket, subtracts every path the database still
references, deletes the remainder. The only thing that can find case 4 — and the only thing
that can delete every image in the store if it is wrong. It runs **dry by default** and
carries the rails below.

### One source of truth for "still referenced"

A SQL function `referenced_objects()` returning every object path the database points at,
so the reconciler asks one question and adding a new image column is one line in one place:

| column | today | note |
|---|---|---|
| `product_images.url` | populated | the main one |
| `collections.image_url` | settable | a plain URL — may point outside our bucket |
| `invoices.pdf_url` | **read but never written** | generated PDFs will live in a bucket too; the schema is ahead of its callers again |

`shipments.tracking_url` is a courier's URL and is deliberately excluded.

---

## Safety rails on the reconciler

This is where you delete a customer-facing catalog by accident. All five are mandatory, and
T9 is the task that proves each one fires.

1. **Age threshold.** Never consider an object younger than `GC_MIN_AGE_HOURS` (default 24).
   An object uploaded two seconds ago may not have a committed row yet, and the reconciler
   must not race the request that created it.
2. **Dry run by default.** `apply: true` is opt-in. The scheduled job reports; a human
   applies, at least until it has been boring for a month.
3. **Absolute cap.** Refuse the pass **entirely** if the delete set exceeds `GC_MAX_DELETE`
   (default 100) — do not delete the first hundred. A large set means the reference query
   broke, not that you have a lot of garbage.
4. **Refuse on an empty reference set.** If `referenced_objects()` returns zero rows, that is
   a broken query, not an empty catalog. Abort.
5. **Log every path before deleting it**, at info level, so the list survives the incident
   even when the objects do not.

---

## Tasks

Numbered for reference, roughly in dependency order. Migration numbers continue from
`20260801002800_signin_lockout.sql`.

### Phase 1 — stop making orphans nobody can find

- [ ] **T1. `storage_gc_queue` and the trigger** — `supabase/migrations/20260801002900_storage_gc.sql`
  - Table: `id uuid pk`, `path text not null unique`, `queued_at timestamptz default now()`,
    `attempts int default 0`, `last_error text`
  - `unique(path)` with `on conflict do nothing`: enqueueing the same path twice is one job
  - `AFTER DELETE ON product_images` — **statement-level with a transition table**, matching
    the pattern already used in this schema, because a cascade deletes many rows at once
  - Path extraction lives in SQL, mirroring `pathFromUrl()`. A URL from outside our bucket
    enqueues nothing
  - RLS enabled and forced; staff read, no write policy; functions service_role only
  - *Acceptance*: `delete from products where id = …` cascades twelve image rows and leaves
    twelve queue rows

- [ ] **T2. `claim_storage_gc(p_limit)` and the sweeper** — migration + `apps/api/src/jobs.ts`
  - `FOR UPDATE SKIP LOCKED`, mirroring `claim_outbox`
  - Runs on the jobs tick, after `drainOutbox()`
  - Success → row gone. Failure → `attempts + 1`, `last_error` set, retried next tick
  - Give up at `GC_MAX_ATTEMPTS` (20, same as `REDRIVE_MAX_ATTEMPTS`) and leave the row for a
    human rather than looping forever
  - *Acceptance*: a queued path is gone from the bucket within one tick; **a 404 from Storage
    counts as success** — the object being absent is the desired end state

- [ ] **T3. Validate `variant_id` before spending an upload** — `apps/api/src/routes/admin-catalog.ts`
  - The product is already checked. Do the same for the variant, so case 3 stops being a
    routine orphan and becomes only a genuine crash
  - *Acceptance*: a `variant_id` belonging to another product answers 422 with **no object
    stored**

- [ ] **T4. Ops alert when the queue backs up** — `apps/api/src/jobs.ts`
  - `raise_ops_alert('ops_storage_gc_stalled', …)` when any row reaches `GC_MAX_ATTEMPTS`,
    alongside the existing four conditions
  - `ecom_storage_gc_queued` and `ecom_storage_gc_stalled` added to the metrics snapshot
  - *Acceptance*: fires once and respects the unread cooldown, like the others

### Phase 2 — find the orphans nothing recorded

- [ ] **T5. `referenced_objects()`** — migration
  - Every object path the database still points at, across all three columns
  - Uses the same path-extraction helper as T1, so the trigger and the reconciler can never
    disagree about what a URL means
  - *Acceptance*: a known uploaded path appears; a `collections.image_url` pointing at an
    external CDN does not

- [ ] **T6. `listObjects()` in `storage.ts`**
  - Paginated wrapper over `POST /storage/v1/object/list/{bucket}`, returning path and
    `created_at`
  - **Must page** — the default limit is 100 and a real catalog is not
  - *Acceptance*: a bucket with 250 objects returns 250

- [ ] **T7. The reconciler** — `apps/api/src/routes/jobs.ts`
  - `GET /admin/storage/orphans` — the report. Always safe, staff only
  - `POST /admin/storage/gc` with `{ apply: true }` — deletes, subject to every rail above
  - Reports **both** directions: objects with no row, and rows whose object is missing
  - *Acceptance*: an object planted directly in the bucket appears in the report and is
    deleted only with `apply: true`

- [ ] **T8. Schedule it** — `supabase/jobs/retention.sql` or the jobs tick
  - Weekly, dry run, result to an ops alert when the orphan count exceeds a threshold
  - *Acceptance*: nothing is deleted without a human until decision 1 below is taken

- [ ] **T9. Prove every rail fires** — `apps/api/test/integration/seam.test.ts`
  - One test per rail: a young object is skipped; an over-cap set refuses **entirely** rather
    than partially; an empty reference set aborts; a dry run deletes nothing
  - The over-cap and empty-set cases are the ones that would delete the catalog. **A rail
    with no test is a rail somebody deletes later as dead code**

### Phase 3 — the rest of the image surface

- [ ] **T10. Collection images** — `POST /admin/collections/{id}/image`, same upload path.
  `collections.image_url` is currently free text somebody can point anywhere, which works
  and is invisible to the GC
- [ ] **T11. Invoice PDFs.** When `invoices.pdf_url` gains a writer it uses the same bucket,
  the same GC, and a **private** prefix. An invoice is a customer's tax document and must
  not sit behind a public CDN domain — that needs a second bucket or a signed-URL read
  path. A decision, not a task
- [ ] **T12. Bucket backup.** `scripts/backup.sh` covers Postgres and says plainly that it
  does not cover the bucket. Decide: R2 bucket-to-bucket replication, or accept Cloudflare's
  durability and that a delete is permanent

### Phase 4 — worth doing, not worth doing first

- [ ] **T13. Presigned direct upload.** Today `await file.arrayBuffer()` buffers the whole
  image in the API process — at `MAX_IMAGE_KB=5120`, ten concurrent uploads is 50MB
  resident. A presigned PUT removes that entirely, at the cost of SigV4 signing here and R2
  credentials living in this process. It also creates case-4 orphans by design, which is why
  T5–T7 come first
- [ ] **T14. Resize and re-encode on upload.** `imgproxy` is already in the stack. Serving a
  6000px 5MB JPEG to a phone is the most expensive thing this store does per page view, and
  R2's free egress does not make the customer's data plan free
- [ ] **T15. Alt text as a requirement, not a field.** Optional today. A storefront with no
  alt text is inaccessible and invisible to image search

---

## Explicitly rejected

**Content-addressed keys (sha256 of the bytes).** Tempting: re-uploading the same file
becomes free and dedupe is automatic. Rejected because it makes deletion *reference
counted* — two products sharing a photograph share a key, so T1's "row deleted, object
deleted" becomes wrong and the only safe collector left is the reconciler with all its
rails. Storage on R2 is cheap; exact deletion is worth more than deduplication.

**Deleting the object inside the delete transaction.** An HTTP call inside a database
transaction holds it open for a network round trip, and a rollback cannot un-delete an
object. The queue exists precisely so the two commit separately.

**Soft-deleting image rows instead.** Keeps the reference and defeats the purpose: the
object is never collected, which is the thing being fixed.

---

## Decisions needed from you

1. **Does the reconciler ever delete unattended?** Recommendation: no for the first month.
   Report weekly, apply by hand, enable once the report has been boring.
2. **Invoice PDFs (T11)** — a second private bucket, or signed URLs from the public one?
   Blocks nothing today, because nothing writes `pdf_url` yet.
3. **Bucket backup (T12)** — replicate, or accept that a delete is permanent?

---

## What "done" looks like

Delete a product in psql. Within one jobs tick its images are gone from R2, the queue is
empty, and `ecom_storage_gc_queued` is zero. Run the reconciler: no orphans, no broken
references. Nothing in the bucket is unaccounted for, and nothing on a product page is a
missing image.
