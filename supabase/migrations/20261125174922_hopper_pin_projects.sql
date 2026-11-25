-- HOP-13: pinned project pills. Set when Keith pins a project; pinned pills come first, in pinning order.
alter table hopper.projects add column if not exists pinned_at timestamptz;
