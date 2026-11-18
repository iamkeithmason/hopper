-- Dynamic project filing from anchor notes, v1 (agreed 18 Nov 2026).
-- Additive only: new columns, a new table, functions, triggers and a nightly job.

-- 1. Project tags: anchor flag, who added the tag, and the note it was filed near.
alter table hopper.note_projects
  add column is_anchor boolean not null default false,
  add column added_by text not null default 'ai',
  add column reason_note_id uuid references hopper.notes(id) on delete set null;
alter table hopper.note_projects
  add constraint note_projects_added_by_check check (added_by in ('ai', 'keith', 'rule', 'import'));

-- Today's tags are the baseline anchors. From now on only confirmed tags become anchors.
update hopper.note_projects set is_anchor = true;

-- 2. Tags Keith has rejected: never proposed again.
create table hopper.tag_rejections (
  note_id uuid not null references hopper.notes(id) on delete cascade,
  project_id uuid not null references hopper.projects(id) on delete cascade,
  at timestamptz not null default now(),
  primary key (note_id, project_id)
);
alter table hopper.tag_rejections enable row level security;
revoke all on hopper.tag_rejections from public, anon, authenticated;

-- Seed with the removals from the 18 Nov afternoon review.
insert into hopper.tag_rejections (note_id, project_id)
select n.id, p.id from hopper.notes n join hopper.projects p on
     (p.name = 'Saeculum' and n.created_at::date = '2024-10-28' and n.title in ('Canoe/Raft travel', 'Horse travel'))
  or (p.name = 'Lurûn' and n.created_at::date = '2024-05-16' and coalesce(n.title, n.summary, '') like 'AI-generated suggestions for an invented Anglo-Saxon%')
  or (p.name = 'Newsflare' and n.created_at::date = '2019-09-13' and coalesce(n.title, n.summary, '') like 'Work note on a contingency%')
on conflict do nothing;

-- 3. Per-project anchor totals and cut-offs.
alter table hopper.projects
  add column anchor_sum extensions.vector(384),
  add column anchor_count int not null default 0,
  add column cut_avg_in float8,
  add column cut_avg_near float8,
  add column cut_nn_in float8,
  add column cut_nn_near float8,
  add column cuts_at timestamptz;

-- 4. Functions.
create or replace function hopper.refresh_anchor_sums(p_project uuid default null)
returns void language sql security definer set search_path = extensions, pg_catalog as $$
  update hopper.projects p
     set anchor_sum = s.total, anchor_count = s.n
    from (select pr.id,
                 (select sum(e.embedding) from hopper.note_projects np join hopper.note_embeddings e on e.note_id = np.note_id
                   where np.project_id = pr.id and np.is_anchor) as total,
                 (select count(*) from hopper.note_projects np join hopper.note_embeddings e on e.note_id = np.note_id
                   where np.project_id = pr.id and np.is_anchor)::int as n
            from hopper.projects pr where p_project is null or pr.id = p_project) s
   where p.id = s.id;
$$;

-- Cut-offs from each project's own anchors (projects with 10 or more anchors only):
-- In at the median, Nearby at the 10th percentile, for both scores.
create or replace function hopper.recalc_cuts()
returns void language plpgsql security definer set search_path = extensions, pg_catalog as $$
begin
  perform hopper.refresh_anchor_sums(null);
  update hopper.projects p
     set cut_avg_in = c.ai, cut_avg_near = c.an, cut_nn_in = c.ni, cut_nn_near = c.nn, cuts_at = now()
    from (
      with anc as (
        select np.project_id, np.note_id, e.embedding
          from hopper.note_projects np join hopper.note_embeddings e on e.note_id = np.note_id
         where np.is_anchor),
      sc as (
        select a.project_id,
               1 - ((pr.anchor_sum - a.embedding) <=> a.embedding) as avg_s,
               (select avg(d) from (
                  select 1 - (b.embedding <=> a.embedding) as d from anc b
                   where b.project_id = a.project_id and b.note_id <> a.note_id
                   order by b.embedding <=> a.embedding limit 3) t) as nn3
          from anc a join hopper.projects pr on pr.id = a.project_id
         where pr.anchor_count >= 10)
      select project_id,
             percentile_cont(0.5) within group (order by avg_s) as ai,
             percentile_cont(0.1) within group (order by avg_s) as an,
             percentile_cont(0.5) within group (order by nn3) as ni,
             percentile_cont(0.1) within group (order by nn3) as nn
        from sc group by project_id) c
   where p.id = c.project_id;
  update hopper.projects
     set cut_avg_in = null, cut_avg_near = null, cut_nn_in = null, cut_nn_near = null, cuts_at = now()
   where anchor_count < 10;
end $$;

-- How close one note is to every scored project. Locked notes return nothing.
create or replace function hopper.project_scores(p_note uuid)
returns table (project_id uuid, project text, avg_score float8, nn3_score float8, nearest_note uuid, band text)
language sql stable security definer set search_path = extensions, pg_catalog as $$
  with me as (
    select e.embedding from hopper.note_embeddings e join hopper.notes n on n.id = e.note_id
     where e.note_id = p_note and not n.is_locked),
  s as (
    select pr.id, pr.name, pr.cut_avg_in, pr.cut_avg_near, pr.cut_nn_in, pr.cut_nn_near,
           1 - (pr.anchor_sum <=> me.embedding) as avg_s,
           (select avg(d) from (
              select 1 - (e.embedding <=> me.embedding) as d
                from hopper.note_projects np join hopper.note_embeddings e on e.note_id = np.note_id
               where np.project_id = pr.id and np.is_anchor and np.note_id <> p_note
               order by e.embedding <=> me.embedding limit 3) t) as nn3,
           (select np.note_id
              from hopper.note_projects np join hopper.note_embeddings e on e.note_id = np.note_id
             where np.project_id = pr.id and np.is_anchor and np.note_id <> p_note
             order by e.embedding <=> me.embedding limit 1) as nearest
      from hopper.projects pr cross join me
     where pr.cut_avg_in is not null and pr.anchor_sum is not null)
  select id, name, avg_s, nn3, nearest,
         case when avg_s >= cut_avg_in or nn3 >= cut_nn_in then 'In'
              when avg_s >= cut_avg_near and nn3 >= cut_nn_near then 'Nearby'
              else 'Out' end
    from s
   order by greatest(avg_s - cut_avg_in, nn3 - cut_nn_in) desc;
$$;

-- File one note: every In project as a firm tag; if none, at most one Nearby project as a faint tag.
-- Skips projects the note already has and tags Keith has rejected. Filed tags are not anchors until confirmed.
create or replace function hopper.file_note(p_note uuid)
returns table (project text, band text)
language plpgsql security definer set search_path = extensions, pg_catalog as $$
declare r record; n_in int := 0;
begin
  if not exists (select 1 from hopper.notes where id = p_note and not is_locked) then return; end if;
  for r in
    select s.* from hopper.project_scores(p_note) s
     where s.band = 'In'
       and not exists (select 1 from hopper.note_projects np where np.note_id = p_note and np.project_id = s.project_id)
       and not exists (select 1 from hopper.tag_rejections tr where tr.note_id = p_note and tr.project_id = s.project_id)
  loop
    insert into hopper.note_projects (note_id, project_id, confidence, confirmed, added_by, reason_note_id)
    values (p_note, r.project_id, 'high', false, 'rule', r.nearest_note);
    n_in := n_in + 1; project := r.project; band := 'In'; return next;
  end loop;
  if n_in = 0 and not exists (select 1 from hopper.note_projects np where np.note_id = p_note) then
    select s.* into r from hopper.project_scores(p_note) s
     where s.band = 'Nearby'
       and not exists (select 1 from hopper.tag_rejections tr where tr.note_id = p_note and tr.project_id = s.project_id)
     limit 1;
    if found then
      insert into hopper.note_projects (note_id, project_id, confidence, confirmed, added_by, reason_note_id)
      values (p_note, r.project_id, 'low', false, 'rule', r.nearest_note);
      project := r.project; band := 'Nearby'; return next;
    end if;
  end if;
end $$;

-- 5. Triggers: a confirmed tag becomes an anchor; anchor totals stay current.
create or replace function hopper.np_anchor_flag()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if new.confirmed then new.is_anchor := true; end if;
  return new;
end $$;

create trigger note_projects_anchor_flag
  before insert or update of confirmed on hopper.note_projects
  for each row execute function hopper.np_anchor_flag();

create or replace function hopper.np_anchor_sums()
returns trigger language plpgsql security definer set search_path = extensions, pg_catalog as $$
begin
  if tg_op = 'INSERT' then
    if new.is_anchor then perform hopper.refresh_anchor_sums(new.project_id); end if;
  elsif tg_op = 'DELETE' then
    if old.is_anchor then perform hopper.refresh_anchor_sums(old.project_id); end if;
  elsif old.is_anchor is distinct from new.is_anchor or old.project_id <> new.project_id then
    perform hopper.refresh_anchor_sums(new.project_id);
    if old.project_id <> new.project_id then perform hopper.refresh_anchor_sums(old.project_id); end if;
  end if;
  return null;
end $$;

create trigger note_projects_anchor_sums
  after insert or delete or update of is_anchor, project_id on hopper.note_projects
  for each row execute function hopper.np_anchor_sums();

create or replace function hopper.emb_anchor_sums()
returns trigger language plpgsql security definer set search_path = extensions, pg_catalog as $$
declare pid uuid; nid uuid;
begin
  nid := case when tg_op = 'DELETE' then old.note_id else new.note_id end;
  for pid in select project_id from hopper.note_projects where note_id = nid and is_anchor loop
    perform hopper.refresh_anchor_sums(pid);
  end loop;
  return null;
end $$;

create trigger note_embeddings_anchor_sums
  after insert or delete on hopper.note_embeddings
  for each row execute function hopper.emb_anchor_sums();

-- 6. Lock the functions down: only the service role (edge functions) and cron call them.
revoke execute on function hopper.refresh_anchor_sums(uuid), hopper.recalc_cuts(), hopper.project_scores(uuid),
  hopper.file_note(uuid), hopper.np_anchor_flag(), hopper.np_anchor_sums(), hopper.emb_anchor_sums()
  from public, anon, authenticated;

-- 7. First calculation, then nightly at 03:17 UTC.
select hopper.recalc_cuts();
select cron.schedule('hopper-cuts', '17 3 * * *', 'select hopper.recalc_cuts()');
