-- ============================================================
-- 0021  Message templates
--
-- Email copy, moved out of the code and into the store.
--
-- `apps/api/src/mailer.ts` carried the copy in a switch statement, and
-- said so: "when these need design, they become provider-side templates
-- addressed by `template`, and this function goes away." Provider-side
-- turned out to be the wrong home. B17 made the provider swappable --
-- Resend or any SMTP host -- and templates living at the provider would
-- have to be re-authored on every switch, which is exactly the lock-in
-- that work removed.
--
-- So they live here instead. A template survives a provider change, a
-- redeploy, and a person leaving; and changing the wording of a password
-- reset stops being a code change.
--
-- ABSENCE IS MEANINGFUL. There are no seed rows, deliberately. A key
-- with no row here renders from the built-in default in mailer.ts, so a
-- fresh install sends correct email before anyone has opened the admin,
-- and DELETE is how you revert a template you have made worse. The
-- built-ins are the floor; this table only ever overrides them.
-- ============================================================

create table message_templates (
  key         text primary key,
  subject     text not null,
  body        text not null,
  -- What this email is for, shown beside the editor. Null means the API's
  -- own description for a known key is used.
  description text,
  updated_at  timestamptz not null default now(),

  constraint message_templates_key_format
    check (key ~ '^[a-z][a-z0-9_]*$'),

  -- An empty template is not a customisation, it is an outage: the
  -- customer gets a blank email and no way to know it was meant to
  -- carry a code.
  constraint message_templates_subject_present check (btrim(subject) <> ''),
  constraint message_templates_body_present    check (btrim(body) <> ''),

  -- HEADER INJECTION. A subject is one header line. A newline in it lets
  -- whoever edits this table append headers of their own -- Bcc most
  -- obviously -- to every message the template sends. nodemailer folds
  -- and escapes, but this must not depend on which provider adapter is
  -- in use, so the database refuses it for every caller including the
  -- service key.
  constraint message_templates_subject_single_line
    check (subject !~ '[\r\n]'),

  -- Long enough for real copy, short enough that a runaway paste cannot
  -- quietly become the thing every customer receives.
  constraint message_templates_sane_length
    check (length(subject) <= 200 and length(body) <= 20000)
);

comment on table message_templates is
  'Overrides for the built-in email copy in apps/api/src/mailer.ts, keyed '
  'by message_log.template. A missing row means "use the built-in", so '
  'deleting a row reverts it. Variables are {{snake_case}} and are '
  'substituted from message_log.payload; an unknown variable renders '
  'empty rather than leaving braces in a customer''s inbox.';

comment on column message_templates.subject is
  'Single line. A newline here would be a header injection into every '
  'message this template sends.';

create trigger trg_touch_message_templates before update on message_templates
  for each row execute function set_updated_at();

-- Copy that goes to customers is worth being able to attribute later --
-- "who changed the refund email, and when" is a real question after a
-- complaint.
create trigger trg_audit_message_templates
  after insert or update or delete on message_templates
  for each row execute function audit_row();

-- ------------------------------------------------------------
-- Access
--
-- The baseline enables RLS and attaches the staff blanket by looping
-- over pg_tables, which ran long before this table existed. A new table
-- inherits none of it, so both halves are spelled out here. Getting this
-- wrong is silent: with RLS enabled and no policy the table is simply
-- empty to everyone, and every email quietly falls back to its default.
-- ------------------------------------------------------------

alter table message_templates enable row level security;
alter table message_templates force row level security;

create policy staff_all on message_templates for all
  to authenticated
  using (is_staff()) with check (is_staff());

-- No public policy, and none is wanted. There is nothing secret in a
-- template, but the storefront has no reason to read them and the outbox
-- drain reads them on the service key, which RLS does not apply to.
