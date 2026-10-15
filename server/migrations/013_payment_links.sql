-- One-time payments: a Razorpay Payment Link an operator sends for one month of a plan (no subscription, no renewal). Paying it makes
-- the organisation active on that plan until a month later (added to a month still running). Additive only.
create table payment_links (
  id           text primary key,                                   -- Razorpay's plink_… id
  org_id       uuid references organizations on delete set null,  -- kept (without the organisation) for the money trail
  plan_code    text not null,
  currency     text not null,
  amount_minor bigint not null check (amount_minor > 0),           -- with tax, what the link asks for
  months       int not null default 1 check (months between 1 and 12),
  status       text not null default 'created' check (status in ('created', 'paid', 'cancelled', 'expired')),
  short_url    text,
  created_by   uuid references users on delete set null,
  created_at   timestamptz not null default now(),
  paid_at      timestamptz,
  payment_id   text,
  period_end   timestamptz                                         -- the access end its payment set
);
create index payment_links_org on payment_links (org_id, created_at desc);
