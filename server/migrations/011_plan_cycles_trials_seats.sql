-- Plan parameters: an annual price beside each monthly one, a trial length per plan, and add-on seats. Additive only: every new column
-- is empty for existing plans, which keeps today's behaviour (monthly only, the global trial length, no extra seats).

-- Annual price per currency (before tax, smallest unit), with its own Razorpay plan (billed yearly) and retired ids, like the monthly one.
-- seat_amount_minor: the monthly price of one extra seat on this plan (before tax); empty = extra seats aren't priced.
alter table plan_prices
  add column annual_amount_minor bigint check (annual_amount_minor is null or annual_amount_minor >= 0),
  add column annual_razorpay_plan_id text,
  add column annual_retired_plan_ids text[] not null default '{}',
  add column seat_amount_minor bigint check (seat_amount_minor is null or seat_amount_minor >= 0);

-- trial_days: free-trial length when this plan is picked (empty = the global BILLING_TRIAL_DAYS, 0 = no free trial on this plan).
-- max_extra_seats: how many seats can be added on top of the plan's own (empty = no cap, 0 = not sold).
alter table plans
  add column trial_days int check (trial_days is null or trial_days between 0 and 90),
  add column max_extra_seats int check (max_extra_seats is null or max_extra_seats >= 0);

-- The organisation's billing cycle (set by the Razorpay plan it pays on) and the seats added on top of its plan.
alter table organizations
  add column billing_cycle text not null default 'monthly' check (billing_cycle in ('monthly', 'annual')),
  add column extra_seats int not null default 0 check (extra_seats between 0 and 10000),
  add column extra_seats_billing text not null default 'invoice' check (extra_seats_billing in ('invoice', 'razorpay'));
