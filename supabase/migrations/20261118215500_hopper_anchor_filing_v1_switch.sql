-- Only live projects that are switched on file new notes automatically.
-- Stromata is off until its notes are tidied (its anchors mix the site with Paideia and consultancy notes).
alter table hopper.projects add column auto_file boolean not null default true;
update hopper.projects set auto_file = false where name = 'Stromata';
-- hopper.project_scores(uuid) recreated with: where ... and pr.is_live and pr.auto_file
-- (full text as in 20261118214500_hopper_anchor_filing_v1.sql, plus that condition).
