-- Command Deck (operator console), phase 0. Additive only: nothing here is read by the customer-facing app.
-- Operators beyond the PLATFORM_OPERATORS bootstrap list (those emails are always founders). Later phases add their own tables.

create table operators (
  user_id    uuid primary key references users on delete cascade,
  role       text not null check (role in ('founder', 'finance', 'support', 'analyst')),
  active     boolean not null default true,
  mfa_secret text,                      -- sealed with APP_SECRET, set when operator MFA ships
  created_at timestamptz not null default now()
);

-- One row per day, written by the scheduler tick (idempotent per day): trends and cohorts without replaying events.
create table console_snapshots (
  day            date primary key,
  mrr_minor      jsonb not null default '{}',    -- { INR: n, USD: n, contracted: n }
  mrr_by_plan    jsonb not null default '{}',
  orgs_by_status jsonb not null default '{}',
  ai_usd         numeric(12, 4) not null default 0,
  runs_ok        int not null default 0,
  runs_failed    int not null default 0,
  wao            int not null default 0,         -- active organisations in the week
  wrl            int not null default 0,         -- weekly recovery loops
  created_at     timestamptz not null default now()
);

create table org_health_daily (
  org_id uuid not null references organizations on delete cascade,
  day    date not null,
  score  int not null check (score between 0 and 100),
  parts  jsonb not null default '{}',
  primary key (org_id, day)
);

-- Internal notes and tasks on an organisation.
create table org_notes (
  id       bigserial primary key,
  org_id   uuid not null references organizations on delete cascade,
  by_user  uuid references users on delete set null,
  body     text not null check (length(body) between 1 and 4000),
  pinned   boolean not null default false,
  due_at   timestamptz,
  done_at  timestamptz,
  assignee uuid references users on delete set null,
  at       timestamptz not null default now()
);
create index org_notes_org on org_notes (org_id, at desc);

create table org_tags (
  org_id uuid not null references organizations on delete cascade,
  tag    text not null check (tag ~ '^[a-z0-9][a-z0-9 _-]{0,30}$'),
  primary key (org_id, tag)
);

-- Snooze / done state for the "needs attention" feed. key = rule + organisation.
create table console_attention_state (
  key           text primary key,
  snoozed_until timestamptz,
  done_at       timestamptz,
  by_user       uuid references users on delete set null
);

create table console_goals (
  month   date primary key,
  targets jsonb not null default '{}'
);

create table console_briefings (
  day   date primary key,
  body  text not null,
  facts jsonb not null default '{}'
);

-- Kill switches and flags, read by the server with a short cache.
create table platform_flags (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references users on delete set null,
  updated_at timestamptz not null default now()
);

alter table users add column if not exists signup_source text;
alter table users add column if not exists utm jsonb;
alter table organizations add column if not exists paused_at timestamptz;
