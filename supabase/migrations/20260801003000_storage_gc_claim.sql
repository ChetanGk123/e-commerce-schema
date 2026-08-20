-- ============================================================
-- 0030  Draining the image collection queue
--
-- T2 of docs/image-management.md. 0029 records what to collect; this is
-- how a worker takes a batch and reports back.
--
-- The same shape as claim_outbox / settle_message, for the same reason:
-- the work is an HTTP call to storage and must happen outside the
-- transaction that queued it. A rollback cannot un-delete an object, and
-- holding a transaction open across a network round trip is how a
-- database runs out of connections.
--
-- ONE DIFFERENCE FROM THE OUTBOX, and it is deliberate. A message_log
-- row is claimed by moving it to 'sending' so a second drainer cannot
-- take it. There is no such status here and none is needed: removing the
-- same object twice is idempotent -- the second attempt gets "not
-- found", which is the state being asked for anyway. Two drainers racing
-- costs one wasted HTTP call rather than a duplicate email, so the
-- cheaper design is also the correct one.
--
-- attempts is incremented ON CLAIM rather than on failure, so a worker
-- that dies mid-batch still burns an attempt. A row that reliably kills
-- the process would otherwise be retried forever.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Claim a batch
--
-- The cancellation at the top is the important half. Between a row being
-- queued and this running, somebody can add an image pointing at the
-- same object -- re-uploading a photograph that was removed by mistake,
-- or a hand-written insert reusing a URL. Collecting it then would take
-- a picture off a live product page, and this queue row is the only
-- thing that still says to.
--
-- Checked here rather than at queue time because it has to be true at
-- the moment of claiming, not at the moment of queueing.
-- ------------------------------------------------------------

create or replace function claim_storage_gc(
  p_limit   int default 50,
  p_give_up int default 20
)
returns table (id uuid, url text, attempts int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from storage_gc_queue q
  where exists (select 1 from product_images p where p.url = q.url);

  return query
  with claimed as (
    select q.id
    from storage_gc_queue q
    where q.attempts < p_give_up
    order by q.queued_at
    limit greatest(1, least(coalesce(p_limit, 50), 500))
    for update skip locked
  )
  update storage_gc_queue q
  set attempts = q.attempts + 1
  from claimed c
  where q.id = c.id
  returning q.id, q.url, q.attempts;
end $$;

-- ------------------------------------------------------------
-- Report back
--
-- `gone` rather than `deleted`: the caller is asserting the object is no
-- longer in the bucket, which is true both when this call removed it and
-- when it was already absent. A storage 404 is success -- the desired
-- end state -- and treating it as failure would keep a row retrying
-- against something that cannot be removed twice.
--
-- Failure leaves the row with its incremented attempts and an error to
-- read. It retries next tick until p_give_up, then sits there for a
-- person; nothing here quietly discards evidence of a problem.
-- ------------------------------------------------------------

create or replace function settle_storage_gc(
  p_id    uuid,
  p_gone  boolean,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_gone then
    delete from storage_gc_queue where id = p_id;
  else
    update storage_gc_queue
    set last_error = left(p_error, 500)
    where id = p_id;
  end if;
end $$;

revoke execute on function claim_storage_gc(int, int)             from public;
revoke execute on function settle_storage_gc(uuid, boolean, text) from public;

-- service_role only. The sweeper runs with no user present, and
-- settle_storage_gc removes queue rows -- reachable by `authenticated`,
-- it would let any signed-in shopper cancel the collection of every
-- object in the bucket.
grant execute on function claim_storage_gc(int, int)              to service_role;
grant execute on function settle_storage_gc(uuid, boolean, text)  to service_role;

commit;
