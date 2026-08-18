-- ============================================================
-- Scheduling the sweepers
--
-- The FUNCTIONS live in supabase/migrations/20260801001600_inventory.sql.
-- They used to live here, and that was a mistake worth recording: this
-- file is not applied by `make verify`, by the Makefile, or by any deploy
-- step, so the live database had no release_expired_reservations() at
-- all. Every reservation whose payment never landed held its stock
-- permanently, and nothing in the system would ever have said so.
--
-- Function definitions belong in migrations. What belongs HERE is the
-- part that was always right: the decision to run them, which is an
-- operational choice and must not happen as a side effect of a deploy.
--
-- Run this once, by hand, against each environment. Everything below is
-- idempotent.
-- ============================================================

-- pg_cron is loaded in shared_preload_libraries on the self-hosted
-- Supabase image, but the extension still has to be created. Until it
-- is, nothing below is scheduled and inventory_health() reports
-- sweeper_scheduled: false.
create extension if not exists pg_cron;

-- ------------------------------------------------------------
-- Cadence
--
-- Only the first of these is about money. The rest are about disk, and
-- can slip a day without anyone noticing.
-- ------------------------------------------------------------

select cron.schedule('release-reservations', '*/5 * * * *',
                     $$select release_expired_reservations()$$);

select cron.schedule('sweep-idempotency-keys', '17 * * * *',
                     $$select sweep_idempotency_keys()$$);

select cron.schedule('sweep-carts', '20 3 * * *',
                     $$select sweep_carts()$$);

select cron.schedule('sweep-webhook-events', '40 3 * * 0',
                     $$select sweep_webhook_events()$$);

select cron.schedule('sweep-notifications', '50 3 * * 0',
                     $$select sweep_notifications()$$);

-- Check it took:
--   select jobname, schedule, active from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 20;
--
-- Or ask the API, which is watching the outcome rather than the schedule:
--   GET /admin/inventory/health

-- ============================================================
-- Growth to watch
--
-- These tables are append-only and unbounded by design. None is
-- partitioned yet; at roughly 50-100M rows apiece, converting them
-- to monthly range partitions on created_at is the next move:
--
--   order_events, message_log, audit_logs,
--   inventory_movements, price_history
--
-- Do it before you need to, not after: partitioning a large live
-- table means a rewrite and a maintenance window.
-- ============================================================
