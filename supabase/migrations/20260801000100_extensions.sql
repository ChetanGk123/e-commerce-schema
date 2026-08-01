-- ============================================================
-- 0001  Extensions
--
-- Every later migration assumes these are present. Supabase ships
-- all four; on self-hosted Postgres they come with contrib.
-- ============================================================

begin;

-- citext: case-insensitive email. Without it Foo@x.com and foo@x.com
-- are two different customers, which is one of the most common
-- duplicate-account bugs in production e-commerce.
create extension if not exists citext;

-- pg_trgm: fuzzy catalog search ("iphone chrger" -> "iPhone charger").
-- Used by the GIN indexes in the indexes migration.
create extension if not exists pg_trgm;

-- btree_gist: lets exclusion constraints mix uuid equality with range
-- overlap. Used to stop overlapping shipping rate bands.
create extension if not exists btree_gist;

-- pgcrypto: gen_random_uuid() is built into Postgres 13+, but pgcrypto
-- also gives us digest() for hashing gift card codes.
create extension if not exists pgcrypto;

commit;
