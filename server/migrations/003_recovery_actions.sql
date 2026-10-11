-- The Recovery Plan: durable recovery actions per brand (06-DATA-STATE-CONTRACTS.md). Additive only.
-- Observed evidence, proposed work, execution state and measured result are separate fields, never one "done" flag.
-- `source_key` is deterministic (question:<id>:<engine>, robots:<bot>, source:<url>, ...), so a rerun's sync
-- refreshes evidence on the same row instead of adding a duplicate. There is no delete: actions are archived.

create table recovery_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  source_key text not null,
  source_run_id text references runs(id) on delete set null,
  question_id text,
  engine text,
  gap_type text check (gap_type in ('discovery','consideration','decision')),
  kind text not null,
  title text not null,
  problem text not null,
  rationale text,
  evidence jsonb not null default '{}',
  output jsonb not null default '{}',
  status text not null default 'suggested' check (status in (
    'suggested','drafting','ready_for_review','approved','published',
    'recheck_scheduled','result_observed','archived'
  )),
  owner_id uuid references users on delete set null,
  due_at timestamptz,
  approved_at timestamptz,
  published_url text,
  published_at timestamptz,
  recheck_at timestamptz,
  result jsonb not null default '{}',
  confidence text check (confidence in ('low','medium','high')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, source_key)
);
create index recovery_actions_ws_status on recovery_actions (workspace_id, status, updated_at desc);
create index recovery_actions_recheck on recovery_actions (recheck_at) where status = 'recheck_scheduled';
