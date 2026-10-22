-- Markets, fix rechecks and the scheduled report. Additive only: existing brands keep working unchanged.

-- Markets: one brand tracked per country (meshopcheap.com/in, /us, /uk). A market is a workspace whose parent is the brand,
-- so it has its own prompts, schedule, runs, recovery plan and integrations, and the scheduler, runner and reports treat it
-- like any brand. The brand itself (parent_id null) is its first market. Deleting a brand deletes its markets.
-- market: { code: "IN", name: "India", path: "/in" } for any workspace tracked for one country; null for older brands.
alter table workspaces
  add column parent_id uuid references workspaces on delete cascade,
  add column market jsonb,
  -- When a weekly or daily check runs, in the brand's own time zone. Empty = 7 days (or 1) after the last check, as before.
  add column run_dow smallint check (run_dow between 0 and 6),
  add column run_hour smallint check (run_hour between 0 and 23),
  add column run_tz text;
create index workspaces_parent on workspaces (parent_id) where parent_id is not null;

-- "markets": countries tracked per brand, the brand's own included. Empty = no limit.
alter table plan_limits drop constraint if exists plan_limits_metric_check;
alter table plan_limits add constraint plan_limits_metric_check
  check (metric in ('brands','questions','competitors','seats','drafts','samples','checks','pages','markets'));
insert into plan_limits (plan_code, metric, limit_value) values
  ('trial', 'markets', 1), ('starter', 'markets', 2), ('growth', 'markets', 3), ('agency', 'markets', 5), ('enterprise', 'markets', 10)
  on conflict (plan_code, metric) do update set limit_value = excluded.limit_value;
update plans set updated_at = now() where code in ('trial', 'starter', 'growth', 'agency', 'enterprise');

-- A fix re-checked on its own (robots.txt, llms.txt, schema, one page, one listing): what the last check saw. Separate from
-- `result`, which stays the comparison with a later full check after publication.
-- last_check: { type, pass, at, detail, observed, by: "person" | "schedule" }
alter table recovery_actions
  add column last_check jsonb not null default '{}',
  add column checked_at timestamptz;

-- People who don't want a kind of email (the scheduled results report). The link in each report adds a row.
create table email_optouts (
  user_id    uuid not null references users on delete cascade,
  kind       text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, kind)
);
