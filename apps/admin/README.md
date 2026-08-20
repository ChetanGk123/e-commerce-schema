# @ecom/admin

The admin console. Next.js App Router, calling `apps/api` over HTTP — it
holds no Supabase client and no service key. See `docs/admin-plan.md` for
what gets built here and in what order.

## Provenance

Vendored from [`ChetanGk123/next-shadcn-admin-dashboard`](https://github.com/ChetanGk123/next-shadcn-admin-dashboard)
(branch `template`), itself MIT-licensed work by Mohammed Arham Khan —
see `LICENSE`, which is kept for that reason and covers this directory
only.

Vendored rather than depended on: it is a starting point, and it stops
being that repo the moment the first screen is written. Its own
`bun.lock`, `compose.yaml`, CI workflow and dotfiles were dropped on the
way in, because this monorepo already owns each of those. Its
`.claude/skills/nextjs-admin-patterns` was byte-identical to the copy
already in this repo, so that went too.

## Running it

Not on its own. `docker compose up -d` at the repo root, or see
[docs/development.md](../../docs/development.md).

Conventions: the `nextjs-admin-patterns` and `code-layout` skills in
`.claude/skills/`.
