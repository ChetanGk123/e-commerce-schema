-- ============================================================
-- 0027  The two conditions that should reach a person, reaching one
--
-- /admin/outbox and /admin/webhooks both compute exactly what is wrong
-- and both wait to be asked. A mail queue that stopped draining and a
-- payment callback that could not be applied are the two failures in
-- this system that are silent, unbounded and expensive -- and the only
-- thing standing between them and a week of nobody noticing is somebody
-- deciding to open an admin page.
--
-- This does not add a monitoring stack. It puts the alert where staff
-- already look, using the notifications table that has existed since the
-- baseline with nothing writing staff rows into it.
--
-- WHAT THIS IS NOT: paging. A notification is seen when someone opens
-- the admin, which is better than never and worse than a phone ringing.
-- The API also logs each of these at error level with a stable message,
-- which is the hook for a log shipper that can page. Wire that up before
-- trusting this alone.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Raise an operational alert, once
--
-- One row per active owner and admin -- not every staff member, because
-- an alert everyone receives is one nobody owns.
--
-- The cooldown is what makes this callable from a loop that runs every
-- minute. Without it a stuck outbox would insert an alert per staff
-- member per tick, and the notification feed would become the outage.
-- ------------------------------------------------------------

create or replace function raise_ops_alert(
  p_kind     text,
  p_title    text,
  p_body     text default null,
  p_data     jsonb default '{}'::jsonb,
  p_cooldown interval default '6 hours'
)
returns int                     -- how many people were told
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  raised int;
begin
  -- Already shouting about this. Unread rather than merely recent: if a
  -- person has seen it and not fixed it, repeating it every six hours
  -- adds nothing they do not know.
  if exists (
    select 1 from notifications
    where kind = p_kind
      and recipient_type = 'staff'
      and read_at is null
      and created_at > now() - p_cooldown
  ) then
    return 0;
  end if;

  insert into notifications (recipient_type, recipient_id, kind, title, body, data)
  select 'staff', s.id, p_kind, p_title, p_body, p_data
  from staff_users s
  where s.is_active and s.role in ('owner', 'admin');

  get diagnostics raised = row_count;
  return raised;
end $$;

revoke execute on function raise_ops_alert(text, text, text, jsonb, interval) from public;
-- The jobs loop calls this on the service key. No user has a reason to.
revoke execute on function raise_ops_alert(text, text, text, jsonb, interval) from authenticated;

commit;
