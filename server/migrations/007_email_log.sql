-- Account and billing emails (server/notify.mjs): one row per email, claimed before sending, so each is sent at most once.
create table if not exists email_log (
  org_id     uuid not null references organizations on delete cascade,
  kind       text not null,
  ref        text not null,
  sent_to    text[],
  status     text,
  error      text,
  created_at timestamptz not null default now(),
  primary key (org_id, kind, ref)
);
