-- ============================================================
-- Retention & sweeper jobs
--
-- NOT a migration. Schedule these; do not run them as part of a
-- deploy. Every statement here is idempotent and bounded, so a run
-- that is interrupted can simply be run again.
--
-- Suggested cadence:
--   release_expired_reservations()   every 5 minutes   (money)
--   sweep_idempotency_keys()         hourly
--   sweep_carts()                    daily
--   sweep_webhook_events()           weekly
--   sweep_notifications()            weekly
--
-- With pg_cron:
--   select cron.schedule('release-reservations', '*/5 * * * *',
--                        'select release_expired_reservations()');
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Expired inventory reservations
--
-- The one job here that is about money rather than disk. A
-- reservation whose release worker died holds stock nobody can buy,
-- and nothing else in the system will ever notice. The unique index
-- on reservation_id makes a double release impossible, so this is
-- safe to run concurrently with the checkout path.
-- ------------------------------------------------------------

create or replace function release_expired_reservations()
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare released int := 0;
begin
  insert into inventory_movements (variant_id, quantity, reason, order_id,
                                   reservation_id, note)
  select r.variant_id,
         -r.quantity,          -- reservations are negative; invert to give back
         'release',
         r.order_id,
         r.id,
         'auto-released: reservation expired'
  from inventory_movements r
  where r.reason = 'reservation'
    and r.expires_at < now()
    and not exists (
      select 1 from inventory_movements c
      where c.reservation_id = r.id     -- already released or converted to a sale
    );

  get diagnostics released = row_count;
  return released;
end $$;

comment on function release_expired_reservations() is
  'Returns stranded stock to the sellable pool. Run every few minutes.';

-- ------------------------------------------------------------
-- Idempotency keys
--
-- These exist to absorb client retries over minutes, not months.
-- ------------------------------------------------------------

create or replace function sweep_idempotency_keys()
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare removed int := 0;
begin
  delete from idempotency_keys where expires_at < now();
  get diagnostics removed = row_count;
  return removed;
end $$;

-- ------------------------------------------------------------
-- Carts
--
-- Guest carts are created by anonymous traffic and cleaned up by
-- nothing else, so this table grows with your bot traffic rather
-- than your revenue. Signed-in carts are kept longer: they are a
-- genuine re-marketing asset.
-- ------------------------------------------------------------

create or replace function sweep_carts(
  guest_age    interval default '30 days',
  customer_age interval default '180 days'
)
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare removed int := 0;
begin
  -- Mark before deleting, so abandoned-cart reporting keeps a signal.
  update carts
  set status = 'abandoned'
  where status = 'active'
    and updated_at < now() - interval '7 days';

  delete from carts
  where status <> 'converted'
    and ((customer_id is null and updated_at < now() - guest_age)
      or (customer_id is not null and updated_at < now() - customer_age));

  get diagnostics removed = row_count;
  return removed;
end $$;

-- ------------------------------------------------------------
-- Webhook events
--
-- Keep long enough to answer "did that callback arrive?", not
-- forever. Unprocessed rows are never swept: those are incidents.
-- ------------------------------------------------------------

create or replace function sweep_webhook_events(keep interval default '90 days')
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare removed int := 0;
begin
  delete from webhook_events
  where processed_at is not null
    and received_at < now() - keep;
  get diagnostics removed = row_count;
  return removed;
end $$;

-- ------------------------------------------------------------
-- Notifications
--
-- message_log is deliberately NOT swept here: it is the evidence
-- that you did send the order confirmation the customer says never
-- arrived. Only the in-app feed is trimmed.
-- ------------------------------------------------------------

create or replace function sweep_notifications(keep interval default '90 days')
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare removed int := 0;
begin
  delete from notifications
  where read_at is not null
    and created_at < now() - keep;
  get diagnostics removed = row_count;
  return removed;
end $$;

commit;

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
