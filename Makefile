# ============================================================
# E-commerce schema -- developer entry points
#
#   make verify   apply every migration to a throwaway Postgres
#   make test     verify, then assert the schema's invariants
#   make seed     verify, then load demo data
#   make psql     open a shell against the verify container
#   make down     destroy the verify container
#   make bundle        combine the migrations into one runnable dist/schema.sql
#   make verify-bundle apply that single file to a throwaway Postgres and test it
#   make types         regenerate TypeScript types from a live database
#   make lint          look for common production mistakes
#   make restore-drill back the seeded database up and restore it into an empty one
#
# verify/test never touch Supabase or production. They run against a
# container that is destroyed and rebuilt on every invocation, which
# is the only way "the migrations apply cleanly" means anything.
# ============================================================

CONTAINER  := ecomm-verify
PGIMAGE    := postgres:16-alpine
# Both published ports sit BELOW the ephemeral range (Linux 32768-60999,
# macOS 49152-65535). 55432 and 55433 were inside it, and on a CI runner
# an outbound connection had already taken 55432 -- `docker run` then dies
# with "address already in use" before a single migration runs. Nothing
# reaches Postgres over this port (every psql call is a docker exec); it
# is published so a human can attach a client, and moving it costs
# nothing.
PGPORT     := 15432
# The API integration stack: PostgREST in front of the same container, so
# apps/api can be exercised over HTTP exactly as it runs in production.
NETWORK    := ecomm-test
PGRST      := ecomm-postgrest
PGRSTIMAGE := postgrest/postgrest:v12.2.3
PGRSTPORT  := 15433
# Shared by PostgREST and apps/api, as GOTRUE_JWT_SECRET/PGRST_JWT_SECRET
# are on a real deployment. Throwaway: this stack is destroyed each run.
JWTSECRET  := integration-only-secret-at-least-32-characters-long
# The drill restores into its own container. Never into $(CONTAINER):
# restoring over the source is a test that passes when the backup is
# empty.
RESTORE    := ecomm-restore
RPSQL      := docker exec -i $(RESTORE) psql -U postgres -v ON_ERROR_STOP=1 -q
PSQL       := docker exec -i $(CONTAINER) psql -U postgres -v ON_ERROR_STOP=1 -q
MIGRATIONS := $(sort $(wildcard supabase/migrations/*.sql))

.PHONY: help verify test seed psql down types lint bundle verify-bundle stack test-api restore-drill

help:
	@grep -E '^#   make' Makefile | sed 's/^#   /  /'

down:
	@docker rm -f $(CONTAINER) $(PGRST) $(RESTORE) >/dev/null 2>&1 || true

verify: down
	@echo "==> starting $(PGIMAGE)"
	@docker network create $(NETWORK) >/dev/null 2>&1 || true
	@docker run -d --name $(CONTAINER) --network $(NETWORK) -e POSTGRES_PASSWORD=pw \
		-p $(PGPORT):5432 $(PGIMAGE) >/dev/null
	@for i in $$(seq 1 60); do \
		docker exec $(CONTAINER) pg_isready -U postgres >/dev/null 2>&1 && break; \
		sleep 1; \
	done
	@echo "==> loading local Supabase shim (auth.users, auth.uid, roles)"
	@$(PSQL) < supabase/tests/00_shim.sql
	@echo "==> applying migrations"
	@for f in $(MIGRATIONS); do \
		printf '    %s ' "$$(basename $$f)"; \
		$(PSQL) < $$f && echo "ok" || { echo "FAILED"; exit 1; }; \
	done
	@printf '==> tables created: '
	@$(PSQL) -tAc "select count(*) from pg_tables where schemaname='public'"

test: verify
	@echo "==> asserting invariants"
	@$(PSQL) < supabase/tests/01_invariants.sql 2>&1 \
		| grep -E 'PASS|FAIL|ERROR' \
		| sed -E 's/^psql:[^ ]+ //; s/^NOTICE:  //' || true
	@$(PSQL) < supabase/tests/01_invariants.sql >/dev/null 2>&1 \
		&& echo "==> all invariants hold" \
		|| { echo "==> INVARIANT FAILURE"; exit 1; }

seed: verify
	@echo "==> seeding demo data"
	@$(PSQL) < supabase/seed.sql
	@echo "==> seeded"

# ------------------------------------------------------------
# The API integration stack.
#
# `bun test` in apps/api never reaches a database, and the SQL
# invariants never reach the API. Everything between the two -- that
# checkout()'s parameter names match what the route sends, that RLS
# permits the route's select list, that a renamed RPC breaks something
# -- was untested, and that seam is where this architecture put all of
# its logic.
#
# PostgREST is the whole difference. GoTrue is not needed: apps/api
# verifies JWTs itself against the shared secret, so the harness mints
# its own. Only /auth/* proxies to GoTrue, and those routes are not
# what this is for.
# ------------------------------------------------------------
stack: seed
	@echo "==> starting $(PGRSTIMAGE)"
	@docker rm -f $(PGRST) >/dev/null 2>&1 || true
	@docker run -d --name $(PGRST) --network $(NETWORK) \
		-e PGRST_DB_URI="postgres://postgres:pw@$(CONTAINER):5432/postgres" \
		-e PGRST_DB_SCHEMAS=public \
		-e PGRST_DB_ANON_ROLE=anon \
		-e PGRST_JWT_SECRET="$(JWTSECRET)" \
		-e PGRST_DB_POOL=4 \
		-p $(PGRSTPORT):3000 $(PGRSTIMAGE) >/dev/null
	@for i in $$(seq 1 60); do \
		curl -sf http://localhost:$(PGRSTPORT)/ >/dev/null 2>&1 && break; \
		sleep 1; \
	done
	@echo "==> PostgREST on http://localhost:$(PGRSTPORT) (schema + seed loaded)"

test-api: stack
	@echo "==> running apps/api integration tests against the stack"
	@cd apps/api && \
		INTEGRATION_PGRST_URL=http://localhost:$(PGRSTPORT) \
		INTEGRATION_JWT_SECRET="$(JWTSECRET)" \
		bun test test/integration/

# ------------------------------------------------------------
# The restore drill
#
# api-plan calls backups the top risk and setup.md C5 says to rehearse
# the restore. Neither of those makes anything happen, which is what the
# production-readiness entry for #13 actually complained about: nothing
# in this repo fails if it is skipped. This does.
#
# It runs the same two scripts an operator runs against supabase-db-1.
# Rehearsing a different procedure than the one you run is rehearsing
# nothing.
#
# The restored copy gets NO shim and NO migrations. It is fingerprinted
# instead -- roles, every policy, RLS enabled and forced per table, every
# function signature, every row count -- and diffed against the source.
# The assertion is not "pg_restore exited 0" but "the restored database
# is the one that was backed up", which is the only claim a backup makes.
# 01_invariants.sql cannot do that job: it loads its own fixtures, so it
# will not run against a database that has data in it.
#
# The mkdir is not tidiness. The shell opens dist/backup/.last for writing
# before backup.sh ever runs, so on a clone that has never built that
# directory this target used to fail on its own first line. It only
# worked here because an earlier run had left the directory behind --
# which is what a CI runner, starting from nothing every time, is for.
# ------------------------------------------------------------
restore-drill: seed
	@mkdir -p dist/backup
	@bash scripts/backup.sh $(CONTAINER) dist/backup > dist/backup/.last
	@echo "==> starting an empty $(PGIMAGE) to restore into"
	@docker rm -f $(RESTORE) >/dev/null 2>&1 || true
	@docker run -d --name $(RESTORE) --network $(NETWORK) -e POSTGRES_PASSWORD=pw \
		$(PGIMAGE) >/dev/null
	@for i in $$(seq 1 60); do \
		docker exec $(RESTORE) pg_isready -U postgres >/dev/null 2>&1 && break; \
		sleep 1; \
	done
	@bash scripts/restore.sh $(RESTORE) "$$(cat dist/backup/.last)"
	@echo "==> fingerprinting both databases"
	@$(PSQL)  -tA < supabase/tests/02_fingerprint.sql > dist/backup/.source
	@$(RPSQL) -tA < supabase/tests/02_fingerprint.sql > dist/backup/.restored
	@printf '==> source:   %s roles, %s policies, %s functions, %s tables\n' \
		$$(grep -c '^role:'   dist/backup/.source) $$(grep -c '^policy:' dist/backup/.source) \
		$$(grep -c '^func:'   dist/backup/.source) $$(grep -c '^table:'  dist/backup/.source)
	@printf '==> restored: %s roles, %s policies, %s functions, %s tables\n' \
		$$(grep -c '^role:'   dist/backup/.restored) $$(grep -c '^policy:' dist/backup/.restored) \
		$$(grep -c '^func:'   dist/backup/.restored) $$(grep -c '^table:'  dist/backup/.restored)
	@diff dist/backup/.source dist/backup/.restored > dist/backup/.diff 2>&1 \
		&& { echo "==> the restored database is identical to the one backed up"; \
		     docker rm -f $(RESTORE) >/dev/null 2>&1 || true; } \
		|| { echo "==> RESTORE IS NOT A BACKUP -- < missing from the restore, > extra:"; \
		     sed 's/^/    /' dist/backup/.diff; exit 1; }

psql:
	@docker exec -it $(CONTAINER) psql -U postgres

# dist/schema.sql is generated from the migrations, never edited by hand.
bundle:
	@bash scripts/bundle.sh

# Proves the bundle and the migrations produce the same database. Runs the
# single file into a clean container, then the same invariant suite.
verify-bundle: bundle down
	@echo "==> starting $(PGIMAGE)"
	@docker run -d --name $(CONTAINER) -e POSTGRES_PASSWORD=pw \
		-p $(PGPORT):5432 $(PGIMAGE) >/dev/null
	@for i in $$(seq 1 60); do \
		docker exec $(CONTAINER) pg_isready -U postgres >/dev/null 2>&1 && break; \
		sleep 1; \
	done
	@$(PSQL) < supabase/tests/00_shim.sql
	@echo "==> applying dist/schema.sql as a single transaction"
	@$(PSQL) < dist/schema.sql
	@printf '==> tables created: '
	@$(PSQL) -tAc "select count(*) from pg_tables where schemaname='public'"
	@echo "==> asserting invariants against the bundled schema"
	@$(PSQL) < supabase/tests/01_invariants.sql >/dev/null 2>&1 \
		&& echo "==> all invariants hold" \
		|| { echo "==> INVARIANT FAILURE"; exit 1; }

# Hand-written types drift. This introspects a database built from the
# migrations, so nullability and column names cannot disagree with what
# actually ships. types/enums.ts and types/validation.ts stay hand-written --
# CHECK constraints are not Postgres enum types, so they cannot be derived.
types: verify
	@python3 scripts/gen_types.py

# Cheap static checks for the mistakes that are expensive in production.
lint:
	@echo "==> migrations missing a transaction wrapper"
	@for f in $(MIGRATIONS); do grep -q '^begin;' $$f || echo "    $$f"; done
	@echo "==> functions missing a pinned search_path"
	@for f in $(MIGRATIONS); do \
		a=$$(grep -c 'create or replace function' $$f); \
		b=$$(grep -c 'set search_path' $$f); \
		[ "$$a" -eq 0 ] || [ "$$a" -le "$$b" ] || echo "    $$f ($$a functions, $$b pinned)"; \
	done
	@echo "==> SECURITY DEFINER functions (each one needs review)"
	@grep -n 'security definer' supabase/migrations/*.sql | sed 's/^/    /' || true
