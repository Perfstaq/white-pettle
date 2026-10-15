-- Account groups for the Command Deck (as in Perfstaq's Founder Command): put your own, your team's and test organisations in a group.
-- With Accounts set to "Customers only", every figure leaves out groups marked leave_out; "Hide demo accounts" leaves out demo groups.
create table account_groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(name) between 1 and 60),
  kind       text not null default 'internal' check (kind in ('internal', 'demo', 'custom')),
  leave_out  boolean not null default true,   -- leave this group's organisations out of customer metrics
  created_by uuid references users on delete set null,
  created_at timestamptz not null default now()
);
create table account_group_members (
  group_id uuid not null references account_groups on delete cascade,
  org_id   uuid not null references organizations on delete cascade,
  added_at timestamptz not null default now(),
  primary key (group_id, org_id)
);
create index account_group_members_org on account_group_members (org_id);
