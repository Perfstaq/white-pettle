-- The free trial is one check: one run of up to 20 prompts. Paid plans have no limit on checks (no row = no limit).
alter table plan_limits drop constraint if exists plan_limits_metric_check;
alter table plan_limits add constraint plan_limits_metric_check
  check (metric in ('brands','questions','competitors','seats','drafts','samples','checks'));
insert into plan_limits (plan_code, metric, limit_value) values ('trial', 'checks', 1)
  on conflict (plan_code, metric) do update set limit_value = excluded.limit_value;
