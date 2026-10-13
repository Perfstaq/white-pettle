-- Paid plans. The plan catalogue (plans, prices, limits, features) lives in the database so it can be edited without a deploy,
-- billing belongs to an organisation, and usage is recorded in counters per billing period. Every existing organisation becomes
-- legacy/internal and keeps the access it has today. Only additive changes, so turning the feature off (BILLING_ENABLED=0) never
-- needs a schema change.

-- ── the catalogue ────────────────────────────────────────────────────────────
create table plans (
  code        text primary key check (code ~ '^[a-z][a-z0-9_-]{1,30}$'),
  name        text not null,
  description text not null default '',
  sort        int  not null default 0,
  public      boolean not null default true,    -- shown on the pricing page and in the billing screen
  self_serve  boolean not null default false,   -- can be bought with a card (otherwise: talk to us / operator grant)
  featured    boolean not null default false,   -- the "most popular" plan: gets the badge, the free-trial button, and is what trials upgrade to
  active      boolean not null default true,    -- an inactive plan can't be newly chosen; organisations already on it keep it
  ai_cap_usd  numeric(10, 2) check (ai_cap_usd is null or ai_cap_usd >= 0),  -- monthly AI-cost allowance (the margin guard); null = none
  updated_at  timestamptz not null default now()
);
-- Monthly price per currency, in the smallest unit (paise, cents), before tax, and the Razorpay plan created for it in the dashboard.
create table plan_prices (
  plan_code        text not null references plans on delete cascade,
  currency         text not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor     bigint not null check (amount_minor >= 0),
  razorpay_plan_id text,
  -- Razorpay plans can't be edited, so a price change means a new plan id. Old ids stay here so subscribers still on them keep resolving.
  retired_plan_ids text[] not null default '{}',
  primary key (plan_code, currency)
);
-- What the plan allows, as numbers. A null limit is unlimited. brands, questions (all brands, tracked), competitors (per brand),
-- seats (people + open invites), drafts (drafted fixes per billing period), samples (per question).
create table plan_limits (
  plan_code   text not null references plans on delete cascade,
  metric      text not null check (metric in ('brands','questions','competitors','seats','drafts','samples')),
  limit_value bigint check (limit_value is null or limit_value >= 0),
  primary key (plan_code, metric)
);
-- What the plan allows, as lists: engines, schedules (off/weekly/daily) and integrations ('*' = all of them).
create table plan_features (
  plan_code text not null references plans on delete cascade,
  kind      text not null check (kind in ('engine','schedule','integration')),
  value     text not null,
  primary key (plan_code, kind, value)
);

-- Seed: the default catalogue. The database is the source of truth from here on; operators edit it in the app (Billing > Plan catalogue).
-- server/plans.mjs DEFAULT_PLANS mirrors this, and a test fails if they drift apart.
insert into plans (code, name, description, sort, public, self_serve, ai_cap_usd, featured) values
  ('legacy', 'Legacy', 'Existing accounts: no limits', 0, false, false, null, false),
  ('trial', 'Free trial', 'Seven days to try Perfstaq, no card', 1, false, false, 3, false),
  ('starter', 'Starter', 'Founders and small businesses proving AI visibility', 2, true, true, 5, false),
  ('growth', 'Growth', 'Growing brands running a weekly visibility loop', 3, true, true, 14, true),
  ('agency', 'Agency', 'Agencies running several client brands', 4, true, true, 38, false),
  ('enterprise', 'Enterprise', 'Large brands and groups with negotiated limits', 5, true, false, null, false);
insert into plan_prices (plan_code, currency, amount_minor) values
  ('starter', 'INR', 499900),
  ('starter', 'USD', 4900),
  ('growth', 'INR', 999900),
  ('growth', 'USD', 9900),
  ('agency', 'INR', 2499900),
  ('agency', 'USD', 24900),
  ('enterprise', 'INR', 9999900),
  ('enterprise', 'USD', 99900);
insert into plan_limits (plan_code, metric, limit_value) values
  ('legacy', 'brands', null),
  ('legacy', 'questions', null),
  ('legacy', 'competitors', null),
  ('legacy', 'seats', null),
  ('legacy', 'drafts', null),
  ('legacy', 'samples', 5),
  ('trial', 'brands', 1),
  ('trial', 'questions', 20),
  ('trial', 'competitors', 3),
  ('trial', 'seats', 1),
  ('trial', 'drafts', 10),
  ('trial', 'samples', 1),
  ('starter', 'brands', 1),
  ('starter', 'questions', 15),
  ('starter', 'competitors', 3),
  ('starter', 'seats', 1),
  ('starter', 'drafts', 10),
  ('starter', 'samples', 1),
  ('growth', 'brands', 1),
  ('growth', 'questions', 30),
  ('growth', 'competitors', 5),
  ('growth', 'seats', 5),
  ('growth', 'drafts', 30),
  ('growth', 'samples', 1),
  ('agency', 'brands', 5),
  ('agency', 'questions', 100),
  ('agency', 'competitors', 5),
  ('agency', 'seats', 20),
  ('agency', 'drafts', 100),
  ('agency', 'samples', 1),
  ('enterprise', 'brands', 20),
  ('enterprise', 'questions', 300),
  ('enterprise', 'competitors', 20),
  ('enterprise', 'seats', 100),
  ('enterprise', 'drafts', 500),
  ('enterprise', 'samples', 3);
insert into plan_features (plan_code, kind, value) values
  ('legacy', 'engine', 'chatgpt'),
  ('legacy', 'engine', 'perplexity'),
  ('legacy', 'engine', 'gemini'),
  ('legacy', 'engine', 'aio'),
  ('legacy', 'engine', 'aimode'),
  ('legacy', 'engine', 'claude'),
  ('legacy', 'engine', 'groq'),
  ('trial', 'engine', 'chatgpt'),
  ('trial', 'engine', 'perplexity'),
  ('trial', 'engine', 'gemini'),
  ('starter', 'engine', 'chatgpt'),
  ('starter', 'engine', 'perplexity'),
  ('starter', 'engine', 'gemini'),
  ('growth', 'engine', 'chatgpt'),
  ('growth', 'engine', 'perplexity'),
  ('growth', 'engine', 'gemini'),
  ('growth', 'engine', 'aio'),
  ('growth', 'engine', 'aimode'),
  ('growth', 'engine', 'claude'),
  ('growth', 'engine', 'groq'),
  ('agency', 'engine', 'chatgpt'),
  ('agency', 'engine', 'perplexity'),
  ('agency', 'engine', 'gemini'),
  ('agency', 'engine', 'aio'),
  ('agency', 'engine', 'aimode'),
  ('agency', 'engine', 'claude'),
  ('agency', 'engine', 'groq'),
  ('enterprise', 'engine', 'chatgpt'),
  ('enterprise', 'engine', 'perplexity'),
  ('enterprise', 'engine', 'gemini'),
  ('enterprise', 'engine', 'aio'),
  ('enterprise', 'engine', 'aimode'),
  ('enterprise', 'engine', 'claude'),
  ('enterprise', 'engine', 'groq'),
  ('legacy', 'schedule', 'off'),
  ('legacy', 'schedule', 'weekly'),
  ('legacy', 'schedule', 'daily'),
  ('trial', 'schedule', 'off'),
  ('starter', 'schedule', 'off'),
  ('starter', 'schedule', 'weekly'),
  ('growth', 'schedule', 'off'),
  ('growth', 'schedule', 'weekly'),
  ('agency', 'schedule', 'off'),
  ('agency', 'schedule', 'weekly'),
  ('enterprise', 'schedule', 'off'),
  ('enterprise', 'schedule', 'weekly'),
  ('enterprise', 'schedule', 'daily'),
  ('legacy', 'integration', '*'),
  ('starter', 'integration', 'bing'),
  ('starter', 'integration', 'indexnow'),
  ('starter', 'integration', 'entity'),
  ('growth', 'integration', 'bing'),
  ('growth', 'integration', 'indexnow'),
  ('growth', 'integration', 'entity'),
  ('growth', 'integration', 'google'),
  ('growth', 'integration', 'cloudflare'),
  ('growth', 'integration', 'slack'),
  ('agency', 'integration', '*'),
  ('enterprise', 'integration', '*');

-- ── billing state on the organisation ────────────────────────────────────────
alter table organizations
  add column plan_code text not null default 'legacy' references plans (code),
  add column billing_status text not null default 'internal'
    check (billing_status in ('internal','trialing','active','past_due','canceled')),
  add column billing_currency text check (billing_currency is null or billing_currency ~ '^[A-Z]{3}$'),
  add column razorpay_customer_id text,
  add column razorpay_subscription_id text unique,
  -- A checkout that has not been paid yet. It is promoted to razorpay_subscription_id only when its activation is confirmed, so an
  -- abandoned or second checkout can never orphan the subscription the organisation is actually paying for.
  add column razorpay_checkout_subscription_id text,
  add column trial_started_at timestamptz,
  add column trial_ends_at timestamptz,
  add column current_period_start timestamptz,
  add column current_period_end timestamptz,
  add column grace_ends_at timestamptz,
  add column pending_plan_code text references plans (code),
  add column cancel_at_period_end boolean not null default false,
  add column entitlement_overrides jsonb not null default '{}',
  add column billing_event_at timestamptz,
  add column billing_reconciled_at timestamptz;
create index organizations_checkout_sub on organizations (razorpay_checkout_subscription_id) where razorpay_checkout_subscription_id is not null;

-- ── the recorder's storage ───────────────────────────────────────────────────
-- Every billable call is an event in `usage` (who, what, which engine, estimated cost) stamped with the billing period it counted
-- toward, and is added to the period's counters in the same transaction. The reader compares the counters with the plan's limits.
alter table usage add column sub text;               -- the kind of write (pitch, article, fixpack, chat, ...)
alter table usage add column period_start timestamptz;
create index usage_org_kind_time on usage (org_id, kind, at);

create table usage_counters (
  org_id       uuid not null references organizations on delete cascade,
  period_start timestamptz not null,
  metric       text not null,   -- ai_usd, calls, ask, write, inspect, serp, drafts
  used         numeric(14, 5) not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (org_id, period_start, metric)
);

-- Usage recorded before this migration belonged to calendar months (the only period there was): carry it over.
update usage set period_start = date_trunc('month', at at time zone 'UTC') at time zone 'UTC' where period_start is null;
insert into usage_counters (org_id, period_start, metric, used)
  select org_id, period_start, 'ai_usd', sum(cost_usd) from usage group by org_id, period_start;
insert into usage_counters (org_id, period_start, metric, used)
  select org_id, period_start, 'calls', sum(n) from usage group by org_id, period_start;
insert into usage_counters (org_id, period_start, metric, used)
  select org_id, period_start, kind, sum(n) from usage group by org_id, period_start, kind;

-- ── payment provider events ──────────────────────────────────────────────────
-- One row per Razorpay webhook event. The primary key makes processing idempotent; `payload` holds only
-- identifiers, statuses and timestamps, never card or payment-method details.
create table billing_events (
  event_id     text primary key,
  event_type   text not null,
  org_id       uuid references organizations on delete set null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  status       text not null default 'received' check (status in ('received','processed','ignored','failed')),
  payload      jsonb not null default '{}',
  error        text
);
create index billing_events_org_time on billing_events (org_id, received_at desc);
