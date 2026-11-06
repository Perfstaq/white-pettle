-- Brand access: a member, or an invite, can be limited to some of the organisation's brands. An agency invites a client
-- as a viewer of that client's brand only, and the client never sees the agency's other clients. Additive only.
--
-- memberships.all_brands is the switch (true = every brand, as before). It is explicit on purpose: a limited member whose
-- last brand is deleted sees no brands, never all of them. A brand's markets come with it (they are its children).
-- Admins and owners always have every brand.
alter table memberships add column all_brands boolean not null default true;
alter table memberships add constraint memberships_limited_role check (all_brands or role in ('editor', 'viewer'));

create table member_brands (
  org_id       uuid not null,
  user_id      uuid not null,
  workspace_id uuid not null references workspaces on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (org_id, user_id, workspace_id),
  foreign key (org_id, user_id) references memberships (org_id, user_id) on delete cascade
);
create index member_brands_ws on member_brands (workspace_id);

-- null = every brand; otherwise the brands (top-level workspaces) the invite gives access to.
alter table invitations add column brand_ids uuid[];
