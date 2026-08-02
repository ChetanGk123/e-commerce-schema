-- ============================================================
-- 0011  Signup: auth.users -> customers
--
-- Supabase Auth creates auth.users. Nothing created the matching
-- customers row, which meant a shopper could register successfully
-- and then discover they could not read their own orders --
-- `id = auth.uid()` matched nothing, so every policy denied them.
-- The symptom looks like broken API keys rather than a missing row,
-- which is why this belongs in the schema rather than in a setup
-- checklist someone might skip.
--
-- Guarded, like the identity FKs in 0003, so the same migration set
-- still applies to a vanilla Postgres where auth.users is absent.
-- ============================================================

begin;

do $$
begin
  if to_regclass('auth.users') is null then
    raise notice
      'auth.users not found -- skipping signup trigger. Expected on vanilla Postgres; NOT expected on Supabase.';
    return;
  end if;

  -- SECURITY DEFINER: the trigger fires as whichever role GoTrue is
  -- using, which has no rights on public.customers. search_path pins
  -- pg_temp LAST so the definer context cannot be hijacked by a
  -- shadowing temp table.
  create or replace function handle_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $fn$
  begin
    insert into customers (id, email, phone, full_name)
    values (
      new.id,
      nullif(new.email, ''),
      -- auth.users.phone is stored WITHOUT a leading '+'
      -- ('919876543210'), while customers.phone carries an E.164
      -- CHECK. Passing it through unchanged fails every phone
      -- signup, and the error surfaces inside GoTrue rather than in
      -- your application logs.
      case
        when new.phone is null or new.phone = '' then null
        when new.phone like '+%'                 then new.phone
        else '+' || new.phone
      end,
      new.raw_user_meta_data ->> 'full_name'
    )
    on conflict (id) do nothing;

    -- Consent defaults: transactional ON, marketing OFF. Creating the
    -- row here means "has this person opted in?" is always a lookup
    -- rather than a lookup plus a null check.
    insert into communication_preferences (customer_id)
    values (new.id)
    on conflict (customer_id) do nothing;

    return new;
  end $fn$;

  -- ON CONFLICT DO NOTHING above makes this safe to re-run, and safe
  -- when the application also creates the customer row itself.
  --
  -- Staff who sign up get a customers row too. That is intentional:
  -- the two tables are separate roles for one person, and someone
  -- who works at the shop may also buy from it.
  drop trigger if exists on_auth_user_created on auth.users;
  create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function handle_new_user();
end $$;

commit;
