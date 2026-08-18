-- ============================================================
-- 0016  Inventory and fulfilment
--
-- Two things happen here.
--
-- FIRST, the sweeper functions move out of supabase/jobs/retention.sql
-- and into a migration. That file said "NOT a migration" meaning "do not
-- RUN these on deploy", and the result was that nothing ever created
-- them: the live database had no release_expired_reservations() at all,
-- so every reservation whose payment never landed held its stock
-- permanently and nothing in the system would ever have said so.
--
-- The scheduling stays out of migrations, which is the part that was
-- always right. jobs/retention.sql now holds only the cron statements.
--
-- SECOND, the admin inventory surface. The whole of it is one function,
-- record_stock_movement(), and its allow-list is the reason it exists:
-- 'sale', 'reservation' and 'release' are not receivable here. A release
-- row consumes a hold, so an admin endpoint able to write one could
-- invent stock out of nothing.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Sweepers (moved from supabase/jobs/retention.sql)
-- ------------------------------------------------------------

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
-- ------------------------------------------------------------
-- Manual stock movements
--
-- Receiving, counting, writing off. Everything a warehouse does to the
-- ledger by hand, and nothing checkout does to it automatically.
--
-- created_by comes from auth.uid(), never from a parameter: an
-- adjustment nobody is attached to is an adjustment nobody has to
-- explain. The note is mandatory for the same reason -- "stock count
-- 2026-08-01: two units unaccounted for" is the difference between a
-- ledger and a rumour.
-- ------------------------------------------------------------

create or replace function record_stock_movement(
  p_variant_id uuid,
  p_quantity   int,
  p_reason     text,
  p_note       text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := require_staff();
  mid uuid;
begin
  if p_reason not in ('purchase', 'adjustment', 'damage', 'return') then
    raise exception
      'Stock can be received, adjusted, written off or returned here, not %.', p_reason
      using errcode = 'ECOM1', hint = 'reason_not_allowed';
  end if;
  if p_quantity = 0 then
    raise exception 'A movement of zero changes nothing.'
      using errcode = 'ECOM1', hint = 'zero_quantity';
  end if;
  if p_reason = 'purchase' and p_quantity < 0 then
    raise exception 'Receiving stock adds it. Use a positive quantity.'
      using errcode = 'ECOM1', hint = 'wrong_sign';
  end if;
  if p_reason = 'damage' and p_quantity > 0 then
    raise exception 'Writing off stock removes it. Use a negative quantity.'
      using errcode = 'ECOM1', hint = 'wrong_sign';
  end if;
  if p_note is null or btrim(p_note) = '' then
    raise exception 'Say why. Every manual movement needs a note.'
      using errcode = 'ECOM1', hint = 'note_required';
  end if;

  -- No stock arithmetic here. apply_inventory_movement() maintains
  -- product_variants.stock from this row, in this transaction, and the
  -- CHECK (stock >= 0) is what refuses an adjustment that would take a
  -- variant negative.
  insert into inventory_movements (variant_id, quantity, reason, note, created_by)
  values (p_variant_id, p_quantity, p_reason, btrim(p_note), uid)
  returning id into mid;

  return mid;
end $$;

-- ------------------------------------------------------------
-- Reservation monitor
--
-- The number that matters is `stranded`: holds that expired and were
-- never released. In a healthy system it is zero, because the sweeper
-- runs every few minutes. Any other number means the sweeper is not
-- running, and that stock is unsellable until someone notices.
--
-- `sweeper_schedule` is null when pg_cron is not installed, which is a
-- finding rather than an error -- it is exactly the state the live
-- database was in. `last_auto_release` is a proxy: a sweeper that runs
-- and finds nothing leaves no trace, so it answers "when did it last
-- have work" rather than "when did it last run".
-- ------------------------------------------------------------

create or replace function inventory_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  uid       uuid := require_staff();
  held      record;
  stranded  record;
  last_run  timestamptz;
  sched     text;
begin
  select count(*) as n, coalesce(sum(-m.quantity), 0) as units into held
  from inventory_movements m
  where m.reason = 'reservation'
    and (m.expires_at is null or m.expires_at >= now())
    and not exists (select 1 from inventory_movements c where c.reservation_id = m.id);

  select count(*) as n, coalesce(sum(-m.quantity), 0) as units,
         min(m.expires_at) as oldest into stranded
  from inventory_movements m
  where m.reason = 'reservation'
    and m.expires_at < now()
    and not exists (select 1 from inventory_movements c where c.reservation_id = m.id);

  select max(created_at) into last_run
  from inventory_movements
  where reason = 'release' and note = 'auto-released: reservation expired';

  if to_regclass('cron.job') is not null then
    execute $q$
      select schedule from cron.job
      where command ilike '%release_expired_reservations%' limit 1
    $q$ into sched;
  end if;

  return jsonb_build_object(
    'held_reservations',      held.n,
    'held_units',             held.units,
    'stranded_reservations',  stranded.n,
    'stranded_units',         stranded.units,
    'oldest_stranded_at',     stranded.oldest,
    'last_auto_release',      last_run,
    'sweeper_scheduled',      sched is not null,
    'sweeper_schedule',       sched,
    'sweeper_installed',      to_regproc('release_expired_reservations') is not null);
end $$;

revoke execute on function record_stock_movement(uuid, int, text, text) from public;
revoke execute on function inventory_health()                           from public;
grant  execute on function record_stock_movement(uuid, int, text, text) to authenticated;
grant  execute on function inventory_health()                           to authenticated;

-- The sweepers delete rows and move stock. Nothing signed-in should be
-- able to call them; they belong to cron and to an operator at a psql
-- prompt.
revoke execute on function release_expired_reservations()        from public;
revoke execute on function sweep_idempotency_keys()              from public;
revoke execute on function sweep_carts(interval, interval)       from public;
revoke execute on function sweep_webhook_events(interval)        from public;
revoke execute on function sweep_notifications(interval)         from public;

commit;
