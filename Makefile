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
#
# verify/test never touch Supabase or production. They run against a
# container that is destroyed and rebuilt on every invocation, which
# is the only way "the migrations apply cleanly" means anything.
# ============================================================

CONTAINER  := ecomm-verify
PGIMAGE    := postgres:16-alpine
PGPORT     := 55432
PSQL       := docker exec -i $(CONTAINER) psql -U postgres -v ON_ERROR_STOP=1 -q
MIGRATIONS := $(sort $(wildcard supabase/migrations/*.sql))

.PHONY: help verify test seed psql down types lint bundle verify-bundle

help:
	@grep -E '^#   make' Makefile | sed 's/^#   /  /'

down:
	@docker rm -f $(CONTAINER) >/dev/null 2>&1 || true

verify: down
	@echo "==> starting $(PGIMAGE)"
	@docker run -d --name $(CONTAINER) -e POSTGRES_PASSWORD=pw \
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
	@grep -c 'create or replace function' supabase/migrations/*.sql | grep -v ':0' | cut -d: -f1 | \
		xargs -I{} sh -c 'a=$$(grep -c "create or replace function" {}); b=$$(grep -c "set search_path" {}); [ "$$a" -le "$$b" ] || echo "    {} ($$a functions, $$b pinned)"'
	@echo "==> SECURITY DEFINER functions (each one needs review)"
	@grep -n 'security definer' supabase/migrations/*.sql | sed 's/^/    /' || true
