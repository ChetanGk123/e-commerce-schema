-- ============================================================
-- 0020  The outbox drain
--
-- checkout() writes the order confirmation into message_log in the same
-- transaction as the order. That is the outbox pattern, and it is the
-- half that was already built: if the mail provider is down, the row
-- simply stays 'queued' and the sale is unaffected.
--
-- This is the other half -- something that picks those rows up. Without
-- it every confirmation ever queued sits there forever, which is the
-- state the live database is in right now: eight queued messages and
-- nothing that reads them.
--
-- The whole design question is how two API instances draining at once
-- avoid sending the same email twice. The answer is a claim: one
-- statement moves a batch to 'sending' under FOR UPDATE SKIP LOCKED, so
-- a second drainer sees neither the locked rows nor, afterwards, the
-- claimed ones.
--
-- That needs a state the CHECK constraint did not allow, so the
-- constraint gains one -- and with it the obligation to notice rows that
-- got stuck there when a drainer died mid-send. requeue_stalled_messages()
-- is that obligation, and it belongs with the other sweepers.
-- ============================================================

begin;

alter table message_log drop constraint message_log_status_check;

alter table message_log add constraint message_log_status_check
  check (status in ('queued', 'sending', 'sent', 'delivered', 'bounced', 'failed'));

-- When the current drainer took it, which is NOT created_at.
--
-- Rescuing stalled rows by age-since-queued would requeue a message that
-- was queued last week and claimed four seconds ago -- while a drainer
-- is still mid-send. The second copy would go out. The stall clock has
-- to start at the claim.
alter table message_log add column if not exists claimed_at timestamptz;

comment on column message_log.claimed_at is
  'Set by claim_outbox() each time a drainer takes the row. '
  'requeue_stalled_messages() measures from here, not from created_at.';

comment on column message_log.status is
  'queued -> sending -> sent -> delivered, or bounced/failed. `sending` is '
  'held only for the length of one provider call; requeue_stalled_messages() '
  'returns anything left there by a drainer that died.';

-- ------------------------------------------------------------
-- Claim a batch
--
-- FOR UPDATE SKIP LOCKED is what makes this safe to run from every API
-- instance at once: a row already being claimed elsewhere is skipped
-- rather than waited for, so two drainers split the queue instead of
-- queuing behind each other.
--
-- attempts is incremented at CLAIM time, not at failure. A message that
-- makes the process die on every attempt would otherwise look untried
-- forever, and that is exactly the message worth noticing.
-- ------------------------------------------------------------

create or replace function claim_outbox(p_limit int default 20)
returns table (
  id          uuid,
  channel     text,
  template    text,
  recipient   text,
  payload     jsonb,
  order_id    uuid,
  customer_id uuid,
  attempts    int
)
language sql
set search_path = public, pg_temp
as $$
  with claimed as (
    select m.id
    from message_log m
    where m.status = 'queued'
    order by m.created_at
    limit greatest(1, least(coalesce(p_limit, 20), 200))
    for update skip locked
  )
  update message_log m
  set status = 'sending', attempts = m.attempts + 1, claimed_at = now()
  from claimed c
  where m.id = c.id
  returning m.id, m.channel, m.template, m.recipient, m.payload,
            m.order_id, m.customer_id, m.attempts;
$$;

-- ------------------------------------------------------------
-- Record how it went
--
-- A failure goes back to 'queued', not to 'failed', until it has been
-- tried enough times to call it: a provider having a bad minute is not
-- a message that cannot be delivered. p_give_up_after is the line
-- between the two, and crossing it is the only way a row stops being
-- retried.
-- ------------------------------------------------------------

create or replace function settle_message(
  p_id             uuid,
  p_sent           boolean,
  p_provider       text default null,
  p_provider_ref   text default null,
  p_error          text default null,
  p_give_up_after  int default 5
)
returns text                      -- the status it landed on
language plpgsql
set search_path = public, pg_temp
as $$
declare m message_log%rowtype; next_status text;
begin
  select * into m from message_log where id = p_id for update;
  if not found then
    raise exception 'message % not found', p_id using errcode = 'P0002';
  end if;

  if p_sent then
    next_status := 'sent';
  elsif m.attempts >= p_give_up_after then
    next_status := 'failed';
  else
    next_status := 'queued';
  end if;

  update message_log
  set status       = next_status,
      provider     = coalesce(p_provider, provider),
      provider_ref = coalesce(p_provider_ref, provider_ref),
      error        = case when p_sent then null else p_error end,
      sent_at      = case when p_sent then now() else sent_at end
  where id = p_id;

  return next_status;
end $$;

-- ------------------------------------------------------------
-- Rescue whatever a dead drainer left behind
--
-- A row in 'sending' with nobody sending it is invisible to the claim
-- query forever. This is the only thing that gets it back, which is why
-- it is scheduled rather than left to a person to remember.
--
-- The interval has to be longer than the slowest provider call, or this
-- requeues a message that is still in flight and sends it twice.
-- ------------------------------------------------------------

create or replace function requeue_stalled_messages(p_older_than interval default '10 minutes')
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare n int;
begin
  update message_log
  set status = 'queued',
      error  = 'requeued after a drainer stalled'
  where status = 'sending'
    -- coalesce for rows claimed before claimed_at existed; a null there
    -- means we cannot tell how long it has been stuck, and leaving it
    -- stuck forever is worse than one duplicate.
    and coalesce(claimed_at, created_at) < now() - p_older_than;
  get diagnostics n = row_count;
  return n;
end $$;

-- ------------------------------------------------------------
-- What the operator needs to see
-- ------------------------------------------------------------

create or replace function outbox_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  uid    uuid := require_staff();
  counts jsonb;
  oldest timestamptz;
  stuck  int;
begin
  select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) into counts
  from (select status, count(*) as n from message_log group by status) s;

  select min(created_at) into oldest from message_log where status = 'queued';
  select count(*) into stuck from message_log
  where status = 'sending' and created_at < now() - interval '10 minutes';

  return jsonb_build_object(
    'by_status',        counts,
    'oldest_queued_at', oldest,
    'stalled_sending',  stuck);
end $$;

revoke execute on function claim_outbox(int)                                   from public;
revoke execute on function settle_message(uuid, boolean, text, text, text, int) from public;
revoke execute on function requeue_stalled_messages(interval)                  from public;
revoke execute on function outbox_health()                                     from public;

-- The drain runs with no user present, so it is service_role only.
-- Giving claim_outbox to `authenticated` would let any signed-in shopper
-- claim -- and therefore suppress -- other people's order confirmations.
grant execute on function claim_outbox(int)                                    to service_role;
grant execute on function settle_message(uuid, boolean, text, text, text, int) to service_role;
grant execute on function requeue_stalled_messages(interval)                   to service_role;
grant execute on function outbox_health()                                      to authenticated;

commit;
