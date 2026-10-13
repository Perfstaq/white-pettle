-- Sign-up no longer starts a trial by itself: a new self-serve organisation waits on 'new' (no plan chosen, read-only) until its
-- owner picks a plan, which starts the free trial. The trial belongs to the person, once: users carry its window, so a second
-- organisation (or one made after the first is deleted) joins the same window instead of getting a fresh week.
alter table organizations drop constraint if exists organizations_billing_status_check;
alter table organizations add constraint organizations_billing_status_check
  check (billing_status in ('internal','new','trialing','active','past_due','canceled'));
alter table users add column if not exists trial_started_at timestamptz, add column if not exists trial_ends_at timestamptz;
-- People who already had a trial keep it as their one trial.
update users u set trial_started_at = t.s, trial_ends_at = t.e
  from (select m.user_id, min(o.trial_started_at) as s, min(o.trial_ends_at) as e from memberships m join organizations o on o.id = m.org_id
        where m.role = 'owner' and o.trial_started_at is not null group by m.user_id) t
  where t.user_id = u.id and u.trial_started_at is null;
