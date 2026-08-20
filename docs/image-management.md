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
that can delete every image in the store if it is wrong.

It runs **unattended** (decision 1) against a bucket with **no backup** (decision 3), so
its correctness is the last line of defence rather than the first. Two passes: a path seen
as an orphan is *recorded*, and only deleted when a later pass, at least
`GC_CONFIRM_DAYS` (default 7) afterwards, still finds it orphaned. Everything else below
is a rail on top of that.

### One source of truth for "still referenced"

A SQL function `referenced_objects()` returning every object path the database points at,
so the reconciler asks one question and adding a new image column is one line in one place:

| column | today | note |
|---|---|---|
| `product_images.url` | populated | the main one |
| `collections.image_url` | settable | a plain URL — may point outside our bucket |

Two columns, not three. `invoices.pdf_url` is **excluded by decision 2**: invoices are
rendered as HTML and printed by the browser, so no PDF is ever stored and the column has no
writer. `shipments.tracking_url` is a courier's URL, excluded for the obvious reason.

Anything added to this list later must be added *before* it holds data, not after. A column
holding object paths that `referenced_objects()` does not know about is a column whose
images the reconciler will delete.

---

## Safety rails on the reconciler

This is where you delete a customer-facing catalog by accident, unattended, with nothing to
restore from. All six are mandatory, and T9 is the task that proves each one fires.

1. **Two sightings, `GC_CONFIRM_DAYS` apart.** A path is deleted only if an earlier pass
   also saw it orphaned and a row still says so. **This is the rail that replaces the human
   decision 1 removed**, and it is the one that survives the failure the others cannot: a
   `referenced_objects()` that breaks — a migration mid-flight, a renamed column, a revoked
   grant — produces a first sighting and nothing more. The next pass, with the query
   working again, clears the sighting and deletes nothing.
2. **Age threshold.** Never consider an object younger than `GC_MIN_AGE_HOURS` (default 24).
   An object uploaded two seconds ago may not have a committed row yet, and the reconciler
   must not race the request that created it.
3. **Absolute cap.** Refuse the pass **entirely** if the delete set exceeds `GC_MAX_DELETE`
   (default 100) — do not delete the first hundred. A large set means the reference query
   broke, not that you have a lot of garbage. Refusing raises an ops alert; proceeding
   quietly is how the whole catalog goes.
4. **Refuse on an empty reference set.** If `referenced_objects()` returns zero rows, that is
   a broken query, not an empty catalog. Abort.
5. **Log every path before deleting it**, at info level, so the list survives the incident
   even when the objects do not. With no bucket backup this log is the only record that a
   given object ever existed.
6. **Dry run stays available**, just no longer the default: `POST /admin/storage/gc` with
   `{ apply: false }` is how you inspect a pass before trusting a change to any of the
   above.

---

## Tasks

Numbered for reference, roughly in dependency order. Migration numbers continue from
`20260801002800_signin_lockout.sql`.

### Phase 1 — stop making orphans nobody can find

- [x] **T1. `storage_gc_queue` and the trigger** — **done**, `supabase/migrations/20260801002900_storage_gc.sql`
  - Table: `id uuid pk`, `path text not null unique`, `queued_at timestamptz default now()`,
    `attempts int default 0`, `last_error text`
  - `unique(path)` with `on conflict do nothing`: enqueueing the same path twice is one job
  - `AFTER DELETE ON product_images` — **statement-level with a transition table**, matching
    the pattern already used in this schema, because a cascade deletes many rows at once
  - ~~Path extraction lives in SQL, mirroring `pathFromUrl()`~~ — **changed while building.**
    Which URLs are ours is decided by `STORAGE_PUBLIC_URL` and `STORAGE_BUCKET`, which are
    environment, and the database has neither. Two parsers free to disagree means either
    collecting somebody else's URL or leaking our own, so the trigger stores the **URL
    verbatim** and the sweeper decides, using the one `pathFromUrl()` that already exists
  - RLS enabled and forced; staff read, no write policy; functions service_role only
  - *Acceptance*: **met.** Five tests in `seam.test.ts` — a product cascade queues all three
    of its images, a variant cascade queues its own, a URL a second row still displays is
    **not** queued, re-adding and re-removing stays one row, and a warehouse account cannot
    read the backlog

- [x] **T2. `claim_storage_gc(p_limit)` and the sweeper** — **done**,
  `supabase/migrations/20260801003000_storage_gc_claim.sql` + `apps/api/src/jobs.ts`
  - **Cancellation moved into the claim.** Between queueing and sweeping, somebody can
    re-upload the photograph that was removed by mistake. Collecting it then takes a
    picture off a live product page, and the queue row is the only thing that still says
    to — so `claim_storage_gc` drops any row whose URL is referenced again *before*
    returning a batch. It has to be true at claim time, not queue time
  - **No `status` column, unlike the outbox.** Removing the same object twice is
    idempotent — the second attempt gets "not found", which is the state being asked for —
    so two drainers racing costs one wasted call rather than a duplicate email
  - **`deleteObject` returns `{ gone, detail }` instead of a boolean.** A 404 is success,
    not failure; treating it otherwise is how a row retries twenty times against a key
    that cannot be removed twice, then alerts about an object that was gone all along
  - A URL from another host settles as done without calling storage at all
  - *Acceptance*: **met.** Eight tests — claim spends an attempt, a re-referenced URL is
    cancelled, an exhausted row is left alone with its history, settle drops on gone and
    keeps the reason on failure, and 200/404/500 from storage are told apart
  - `FOR UPDATE SKIP LOCKED`, mirroring `claim_outbox`
  - Runs on the jobs tick, after `drainOutbox()`
  - Success → row gone. Failure → `attempts + 1`, `last_error` set, retried next tick
  - Give up at `GC_MAX_ATTEMPTS` (20, same as `REDRIVE_MAX_ATTEMPTS`) and leave the row for a
    human rather than looping forever
  - *Acceptance*: a queued path is gone from the bucket within one tick; **a 404 from Storage
    counts as success** — the object being absent is the desired end state

- [x] **T3. Validate `variant_id` before spending an upload** — **done**, `apps/api/src/routes/admin-catalog.ts`
  - The product is already checked. Do the same for the variant, so case 3 stops being a
    routine orphan and becomes only a genuine crash
  - *Acceptance*: a `variant_id` belonging to another product answers 422 with **no object
    stored**

- [x] **T4. Ops alert when the queue backs up** — **done**, `apps/api/src/jobs.ts`
  - **Alerting on depth would have been wrong.** A queue with depth is a queue that is
    working. The alert is on rows that exhausted their attempts, which is a queue that has
    stopped — and every one of those is a file nothing displays that the bucket still
    bills for. Both are published as metrics; only the second wakes anyone
  - `raise_ops_alert('ops_storage_gc_stalled', …)` when any row reaches `GC_MAX_ATTEMPTS`,
    alongside the existing four conditions
  - `ecom_storage_gc_queued` and `ecom_storage_gc_stalled` added to the metrics snapshot
  - *Acceptance*: fires once and respects the unread cooldown, like the others

### Phase 2 — find the orphans nothing recorded

- [x] **T5. `referenced_objects()`** — **done**, `supabase/migrations/20260801003100_referenced_objects.sql`
  - Every object path the database still points at, across all three columns
  - Uses the same path-extraction helper as T1, so the trigger and the reconciler can never
    disagree about what a URL means
  - *Acceptance*: a known uploaded path appears; a `collections.image_url` pointing at an
    external CDN does not

- [x] **T6. `listObjects()` in `storage.ts`** — **done**
  - Paginated wrapper over `POST /storage/v1/object/list/{bucket}`, returning path and
    `created_at`
  - **Must page** — the default limit is 100 and a real catalog is not
  - **And must recurse, which the task did not say.** Storage's list is delimiter-based:
    given `products/` it returns one entry per product folder with a **null `id`** and none
    of the files inside them. A walk that stops there reports a bucket containing no
    images — which, handed to something that removes what nothing references, is not a
    wrong report but a wrong deletion, and it would trip rail 4 rather than being caught
    honestly. Costs one request per folder; the alternative is R2 credentials in this
    process for a recursive `ListObjectsV2`
  - *Acceptance*: **met.** The stand-in models the folder behaviour rather than returning
    keys flat, so a non-recursive walk fails the test instead of passing it

- [x] **T7. The reconciler, two-pass** — **done**,
  `supabase/migrations/20260801003200_orphan_sightings.sql` + `apps/api/src/jobs.ts` +
  `apps/api/src/routes/jobs.ts`
  - **`reconcileStorage()` takes rail overrides**, and that is not a convenience. Rails
    measured in days and hundreds cannot otherwise be exercised without a week and a real
    catalog, and a rail nobody can test is a rail somebody removes as dead code
  - **The bug worth remembering**: `RETURNS TABLE (path, ...)` puts `path` in scope for
    the whole body, so `on conflict (path)` was ambiguous between the output variable and
    the column. `#variable_conflict use_column`. It failed loudly rather than silently,
    which is the only reason it was cheap
  - `storage_orphan_sightings`: `path text pk`, `first_seen_at timestamptz`,
    `last_seen_at timestamptz`. A pass upserts every orphan it finds and **deletes the
    sighting for any path that is no longer orphaned** — a path that came back must start
    its week again
  - Delete only where `first_seen_at < now() - GC_CONFIRM_DAYS` and the path is orphaned in
    *this* pass too
  - `GET /admin/storage/orphans` — the report, staff only, never deletes
  - `POST /admin/storage/gc` — `{ apply: true }` deletes subject to every rail;
    `{ apply: false }` is the dry run
  - Reports **both** directions: objects with no row, and rows whose object is missing
  - *Acceptance*: a planted object is reported on pass one and **still present**; after the
    confirmation window it is deleted on pass two. A path that gains a row in between is
    never deleted and its sighting is gone

- [x] **T8. Schedule it, unattended** — **done**,
  `supabase/migrations/20260801003300_job_runs.sql` + the jobs tick
  - **A claim, not a timestamp somebody reads and then acts on.** N containers each
    ticking every sixty seconds would otherwise all start the weekly pass in the same
    second, each listing the entire bucket and racing the rest to remove the same objects.
    Reading "is it due" and writing "I am doing it" as two statements is the same bug at a
    different scale
  - **Registering a job does not claim it** (`xmax = 0`), so a freshly deployed store does
    not immediately run an irreversible pass against a bucket it has only started filling
  - Rides along on `POST /jobs/drain` too, for the same reason the webhook redrive does: a
    deployment with `JOBS_INTERVAL_SECONDS=0` has one cron entry, and a second endpoint it
    does not know to call is a fix that never arrives
  - Weekly, `apply: true` (decision 1)
  - Every pass that deletes anything raises an ops alert saying how many and links the log.
    Unattended does not mean unannounced — with no backup, the notification is the only
    thing that tells anyone it happened
  - A refused pass (rail 3 or 4) alerts at **error** level and deletes nothing
  - *Acceptance*: a scheduled pass deletes a confirmed orphan with no human involved, and
    says so

- [ ] **T9. Prove every rail fires** — `apps/api/test/integration/seam.test.ts`
  - One test per rail: an unconfirmed orphan survives its first pass; a young object is
    skipped; an over-cap set refuses **entirely** rather than partially; an empty reference
    set aborts; a dry run deletes nothing
  - **The one that matters most**: simulate `referenced_objects()` returning a partial set
    (a table temporarily unreadable), confirm nothing is deleted, then restore it and
    confirm the sightings clear. That is the exact shape of the accident decisions 1 and 3
    make unrecoverable
  - The over-cap and empty-set cases are the ones that would delete the catalog. **A rail
    with no test is a rail somebody deletes later as dead code**

### Phase 3 — the rest of the image surface

- [ ] **T10. Collection images** — `POST /admin/collections/{id}/image`, same upload path.
  `collections.image_url` is currently free text somebody can point anywhere, which works
  and is invisible to the GC
- [ ] **T11. Retire `invoices.pdf_url`** — decision 2 settled this by removing the feature:
  invoices are rendered as HTML and printed by the browser, so no PDF is ever stored. That
  leaves a column nothing writes and `routes/invoicing.ts` still reads and publishes as
  `pdfUrl`, which tells every client there is a file to fetch. Either drop the column in a
  migration and the field from the response, or comment it as permanently null. **The good
  news is the whole of T11's original problem — a tax document behind a public CDN domain —
  no longer exists**, and no second bucket is needed
- [x] **T12. Bucket backup — decided: none.** A delete is permanent (decision 3).
  `scripts/backup.sh` already says it does not cover the bucket; that stays true and stays
  documented. The consequence is not free, and it is paid for in rail 1: the confirmation
  window is what an unbacked bucket buys instead of a restore

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

## Decisions taken — 2026-08-20

1. **The reconciler deletes unattended.** No human in the loop.
2. **Invoice PDFs are generated on the fly**, HTML the browser prints. Nothing is stored, so
   `invoices.pdf_url` drops out of this design entirely — see T11.
3. **No bucket backup.** A delete is permanent.

**1 and 3 together are the thing to design around, and they are why T7 grew a second
pass.** Unattended deletion is fine on its own; unattended deletion with no way back is one
bad `referenced_objects()` away from a catalog with no photographs and no restore. The
rails stop being belt-and-braces at that point and become the only thing between a bad
deploy and permanent loss. Hence: **an orphan must be seen twice, a week apart, before it
is deleted.** A query that breaks — a migration mid-flight, a renamed column, a permission
change — produces a first sighting and nothing else, and the next pass clears it.

That costs one table and one `where` clause. It buys back the week that decision 3 gave
away.

---

## What "done" looks like

Delete a product in psql. Within one jobs tick its images are gone from R2, the queue is
empty, and `ecom_storage_gc_queued` is zero.

Plant an object in the bucket by hand. The next weekly pass reports it and leaves it
alone. The pass after — a week later — deletes it, unattended, and a notification says it
did. Break `referenced_objects()` in between and nothing is deleted at all.

Nothing in the bucket is unaccounted for, nothing on a product page is a missing image, and
the only way to lose a photograph is for it to be genuinely unreferenced for a week.
