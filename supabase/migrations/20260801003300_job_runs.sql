-- ============================================================
-- 0033  Work that happens weekly, not every minute
--
-- T8 of docs/image-management.md.
--
-- The jobs tick runs every sixty seconds. The image reconciler must run
-- about once a week, and pg_cron cannot own it because it makes HTTP
-- calls to storage. So the cadence has to live somewhere both durable
-- and shared -- durable because a restart must not reset the clock, and
-- shared because N API containers each ticking every sixty seconds would
-- otherwise all start the weekly pass at once. Every one of those would
-- list the entire bucket (a request per folder) and race the others to
-- remove the same objects.
--
-- Hence a claim, rather than a timestamp somebody reads and then acts
-- on. Reading "is it due" and writing "I am doing it" as two statements
-- is the same bug at a different scale.
--
-- THE FIRST CALL DOES NOT CLAIM. Registering a job returns false, so a
-- freshly deployed store does not immediately run an unattended,
-- irreversible collection pass against a bucket it has only just started
-- filling. The clock starts at deploy; the first real pass is an
-- interval later.
-- ============================================================

begin;

create table if not exists job_runs (
  job         text primary key,
  last_run_at timestamptz not null default now()
);

comment on table job_runs is
  'Last time each periodic job ran. claim_job_run() is the only thing '
  'that should write here -- reading and then writing separately is a '
  'race as soon as more than one container is ticking.';

alter table job_runs enable row level security;
alter table job_runs force row level security;

create policy job_runs_staff_r on job_runs
  for select to authenticated
  using (has_staff_role('owner', 'admin', 'manager', 'support'));

-- ------------------------------------------------------------
-- Claim the next run, atomically
--
-- One statement, so two containers cannot both win. The WHERE on the
-- conflict clause is what makes it a claim rather than a read: the
-- update happens only if the job is actually due, and a caller that
-- loses gets no row back at all.
--
-- xmax = 0 tells a fresh INSERT from an ON CONFLICT UPDATE -- the same
-- trick record_webhook() uses in 0015. A fresh insert is a registration,
-- not a claim, so it answers false.
-- ------------------------------------------------------------

create or replace function claim_job_run(p_job text, p_every interval)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare claimed boolean;
begin
  insert into job_runs (job) values (p_job)
  on conflict (job) do update
    set last_run_at = now()
    where job_runs.last_run_at < now() - p_every
  returning (xmax <> 0) into claimed;

  -- No row returned means the conflict clause declined: either somebody
  -- else has it, or it is simply not due yet.
  return coalesce(claimed, false);
end $$;

revoke execute on function claim_job_run(text, interval) from public;
grant  execute on function claim_job_run(text, interval) to service_role;

commit;
