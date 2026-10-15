-- "pages": how many of the web pages AI answers cite a check opens and reads (website parsing). Empty = the product default
-- (24 for a check run in the browser, 18 for a scheduled one). Like every limit it can be raised for one organisation by an override.
alter table plan_limits drop constraint if exists plan_limits_metric_check;
alter table plan_limits add constraint plan_limits_metric_check
  check (metric in ('brands','questions','competitors','seats','drafts','samples','checks','pages'));
