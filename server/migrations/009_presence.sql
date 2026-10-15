-- Who is in the app right now and what they look at: a heartbeat from the browser (POST /api/presence) while the tab is visible.
-- presence keeps one row per person (their latest page); page_views keeps one row per page they open, for feature analytics.
-- Only page names from the app's own navigation and a brand slug are stored: never content, URLs or query strings.

create table presence (
  user_id uuid primary key references users on delete cascade,
  org_id  uuid references organizations on delete set null,
  page    text not null,
  brand   text,
  device  text not null default 'desktop' check (device in ('desktop', 'mobile', 'tablet')),
  since   timestamptz not null default now(),   -- when they arrived on this page
  at      timestamptz not null default now()    -- last heartbeat
);
create index presence_at on presence (at desc);

create table page_views (
  id      bigserial primary key,
  user_id uuid references users on delete cascade,
  org_id  uuid references organizations on delete set null,
  page    text not null,
  device  text not null default 'desktop',
  at      timestamptz not null default now()
);
create index page_views_at on page_views (at);
create index page_views_page_at on page_views (page, at);
