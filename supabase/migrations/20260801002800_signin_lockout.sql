-- ============================================================
-- 0028  Per-account sign-in lockout
--
-- apps/api's rate limiter counts requests per IP address. That stops one
-- machine hammering /auth/sign-in, and it does nothing whatever about the
-- attack this endpoint actually attracts: a stolen credential list
-- replayed a few attempts at a time from a thousand different addresses.
-- Every one of those addresses stays comfortably inside its own budget.
-- The account being drilled is the only thing they have in common, so
-- that is where the count has to live.
--
-- Why the database rather than another Map in process memory:
--
--   IT HAS TO BE SHARED. Two API containers behind a load balancer means
--   two independent counters, twice the attempts, and a locked account
--   that unlocks itself the moment the attacker is routed to the other
--   one.
--
--   IT HAS TO SURVIVE A RESTART. A lockout that a redeploy clears is a
--   lockout with a published expiry.
--
--   SOMEBODY HAS TO BE ABLE TO SEE IT. A control nobody can look at is
--   half a control. Staff can read this table, and jobs.ts raises an ops
--   alert when several accounts are locked at once -- which is what a
--   stuffing run looks like from in here. The audit entry said the real
--   problem was that the attack is *invisible*; the lock alone would not
--   have fixed that.
--
-- WHAT THIS COSTS, said plainly: anyone who knows your email address can
-- lock you out of your own account for fifteen minutes. That is the
-- standing objection to per-account lockout and it is a real one. Three
-- things bound it -- the lock expires on its own, a completed password
-- reset clears it immediately, and fifteen minutes is an annoyance
-- rather than a denial of service. A lock that held until an admin
-- intervened would trade a small attack for a larger one.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- The counter
--
-- Keyed on the address that was typed, whether or not it belongs to an
-- account here. That is deliberate: counting only real accounts would
-- make the lockout itself an enumeration oracle -- ten attempts, and the
-- difference between 401 and 429 tells you who banks here. The cost is
-- that this table holds addresses that have never had an account, which
-- is why sweep_auth_attempts() drops a row an hour after it goes quiet.
--
-- citext, like blocklist.value and customers.email. A lockout that
-- stores Alice@example.com and checks alice@example.com locks nobody,
-- and you find out from the incident report.
-- ------------------------------------------------------------

create table if not exists auth_attempts (
  email        citext primary key,
  failures     int not null default 0,
  last_at      timestamptz not null default now(),
  locked_until timestamptz
);

-- The count jobs.ts runs every sixty seconds, over the one table that
-- grows precisely when you cannot afford a sequential scan of it.
create index if not exists idx_auth_attempts_locked
  on auth_attempts(locked_until) where locked_until is not null;

comment on table auth_attempts is
  'Consecutive failed sign-ins per email address, for the lockout in '
  'apps/api/src/routes/auth.ts. Rows are transient -- swept an hour '
  'after the last attempt -- and include addresses with no account.';

alter table auth_attempts enable row level security;
alter table auth_attempts force row level security;

-- Read-only, and not to everyone: this is a list of addresses somebody
-- is currently trying passwords against, which is the same class of PII
-- the role matrix already denies a warehouse account on `customers`.
-- There is no write policy at all -- the definer functions below are the
-- only way in, and they run as the owner.
create policy auth_attempts_staff_r on auth_attempts
  for select to authenticated
  using (has_staff_role('owner', 'admin', 'manager', 'support'));

-- ------------------------------------------------------------
-- Is this address locked right now
--
-- Called before the credentials go anywhere near GoTrue. Checking
-- afterwards would still spend the upstream call, and GoTrue's own rate
-- limit is a shared resource an attacker would otherwise get to exhaust
-- on everyone else's behalf.
-- ------------------------------------------------------------

create or replace function auth_lock_check(p_email citext)
returns timestamptz              -- when the lock lifts; null if not locked
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.locked_until
  from auth_attempts a
  where a.email = p_email and a.locked_until > now();
$$;

-- ------------------------------------------------------------
-- Record a failure
--
-- Ten consecutive failures inside fifteen minutes locks the address for
-- fifteen minutes. Ten because somebody mistyping their own password
-- gives up at three or four, and a password manager holding a stale
-- entry is worth a few more; a credential list needs thousands.
--
-- The window is idle-based rather than fixed: fifteen quiet minutes and
-- the next failure starts a fresh run. Two typos on Monday and two on
-- Friday are not an attack, and treating them as one is how a lockout
-- ends up firing on the people it was built to protect.
--
-- Setting the lock resets the counter. Without that, the first mistake
-- after a lock expires would re-lock the account immediately, which
-- turns a fifteen-minute inconvenience into a permanent one for anybody
-- being targeted.
-- ------------------------------------------------------------

create or replace function auth_record_failure(p_email citext)
returns timestamptz              -- non-null when this failure locked it
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a auth_attempts%rowtype;
begin
  insert into auth_attempts (email, failures, last_at)
  values (p_email, 1, now())
  on conflict (email) do update
    set failures = case
          when auth_attempts.last_at < now() - interval '15 minutes' then 1
          else auth_attempts.failures + 1
        end,
        last_at  = now()
  returning * into a;

  if a.failures >= 10 then
    update auth_attempts
    set failures = 0, locked_until = now() + interval '15 minutes'
    where email = p_email
    returning auth_attempts.locked_until into a.locked_until;
    return a.locked_until;
  end if;

  return null;
end $$;

-- ------------------------------------------------------------
-- Forget an address
--
-- Called on a successful sign-in, and on a completed password reset.
-- The second one is the escape hatch that makes the self-inflicted
-- lockout survivable: the victim of somebody else's ten attempts is not
-- told to wait, they are told to reset, and the reset works.
-- ------------------------------------------------------------

create or replace function auth_clear_failures(p_email citext)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from auth_attempts where email = p_email;
$$;

-- ------------------------------------------------------------
-- Prune
--
-- An hour past whichever happened later, the last attempt or the end of
-- the lock. Under a spray this table grows with the attacker's word
-- list, so the sweeper is not housekeeping -- it is the thing that stops
-- the defence from becoming the memory exhaustion.
-- ------------------------------------------------------------

create or replace function sweep_auth_attempts()
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare removed int := 0;
begin
  delete from auth_attempts
  where greatest(last_at, coalesce(locked_until, last_at)) < now() - interval '1 hour';
  get diagnostics removed = row_count;
  return removed;
end $$;

revoke execute on function auth_lock_check(citext)     from public;
revoke execute on function auth_record_failure(citext) from public;
revoke execute on function auth_clear_failures(citext) from public;
revoke execute on function sweep_auth_attempts()       from public;

-- service_role only. Every one of these is called by the API with no
-- user present, and auth_clear_failures in particular is a lockout
-- release: `authenticated` reaching it would make the whole thing
-- optional for anyone holding a token.
grant execute on function auth_lock_check(citext)      to service_role;
grant execute on function auth_record_failure(citext)  to service_role;
grant execute on function auth_clear_failures(citext)  to service_role;
grant execute on function sweep_auth_attempts()        to service_role;

commit;
