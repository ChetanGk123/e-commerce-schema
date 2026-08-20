# Docs

Two kinds of file live here. **Reference** describes what exists and is safe to
trust. **Plans** record what was decided and how far it got — they carry a
`Status` line, and where a plan and the code disagree, the code wins.

## Reference

| File | What it answers |
|---|---|
| [setup.md](setup.md) | Empty project → a database you can build against, ~20 min. Part A hosted Supabase, Part B plain Postgres, Part C self-hosted. Every step ends in a check. |
| [schema_guide.md](schema_guide.md) | Plain-English tour of all 51 tables and the flows that move between them. No technical background assumed. |
| [image-management.md](image-management.md) | How images get into the store and how they leave — upload, and the deletion path that needed the storage GC. |
| [monitoring.md](monitoring.md) | Standing up Grafana, Prometheus and Loki against the API's existing `/metrics` and pino output, and reading the result. The stack itself is in `monitoring/`. |
| [testing-accounts.md](testing-accounts.md) | Sign-ins for exercising the API by hand via Swagger UI, Postman or curl. **Local only.** |

## Plans

| File | Status |
|---|---|
| [api-plan.md](api-plan.md) | B0–B12 + B14–B18 done, bar courier/messaging webhooks; B13 scope-guarded |
| [production-readiness.md](production-readiness.md) | Every item closed. Audited against the code, not the plan |
| [admin-plan.md](admin-plan.md) | Not started. Next.js admin console; depends on `api-plan.md` |

## Before you move or rename anything here

`schema_guide.md` is cited **by line number** from `apps/api/src/errors.ts` and
from three migrations, and `api-plan.md` has ~36 inbound references. Renaming
either is a repo-wide edit, not a `git mv`.
