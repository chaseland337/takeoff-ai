-- Standalone PostgreSQL regression, NOT for a live Supabase database.
-- Run as a database owner in an empty disposable database:
--   psql -X -v ON_ERROR_STOP=1 -d company_access_test -f supabase/tests/company_access.sql
-- Mock auth/storage schemas intentionally fail if these schemas already exist.
-- All changes, including the migration and bootstrap roles, are rolled back.
\set ON_ERROR_STOP on
begin;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
create schema auth;
create schema storage;
create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects(id uuid default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
grant all on storage.objects to authenticated, service_role;
\ir ../migrations/202610240001_company_access.sql

insert into public.organizations(id,name) values
 ('10000000-0000-4000-8000-000000000001','One'),
 ('10000000-0000-4000-8000-000000000002','Two');
insert into auth.users(id,email,email_confirmed_at) values
 ('20000000-0000-4000-8000-000000000001','owner@one.test',now()),
 ('20000000-0000-4000-8000-000000000002','admin@one.test',now()),
 ('20000000-0000-4000-8000-000000000003','member@one.test',now()),
 ('20000000-0000-4000-8000-000000000004','owner@two.test',now()),
 ('20000000-0000-4000-8000-000000000005','invited@one.test',null),
 ('20000000-0000-4000-8000-000000000006','uninvited@one.test',now());
insert into public.organization_members(user_id,organization_id,role,email)
 select id,
 case when email = 'owner@two.test' then '10000000-0000-4000-8000-000000000002'::uuid
 else '10000000-0000-4000-8000-000000000001'::uuid end,
 case when email like 'owner%' then 'owner' when email like 'admin%' then 'admin' else 'member' end,email
 from auth.users where email not in ('invited@one.test','uninvited@one.test');

set role authenticated;
set request.jwt.claim.sub = '20000000-0000-4000-8000-000000000001';
insert into public.projects(id,organization_id,name,data,created_by,updated_by,revision,created_at,updated_at,deleting)
 values ('project-one','10000000-0000-4000-8000-000000000001','One','{}',
 '20000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000004',1000,'2000-01-01','2000-01-01',true);
do $$
begin
 if not exists(select 1 from public.projects where id='project-one' and revision=1 and not deleting
   and created_by=auth.uid() and updated_by=auth.uid() and created_at=now() and updated_at=now())
 then raise exception 'Server creation audit was forged'; end if;
 begin
  insert into public.projects(id,organization_id,name,data)
    values('cross-org','10000000-0000-4000-8000-000000000002','Bad','{}');
  raise exception 'Cross-org project insertion succeeded';
 exception when insufficient_privilege then null; end;
 begin
  update public.projects set name='No CAS' where id='project-one';
  raise exception 'Raw project update bypassed CAS';
 exception when insufficient_privilege then null; end;
 begin
  update public.organization_members set role='owner' where user_id='20000000-0000-4000-8000-000000000003';
  raise exception 'Client changed membership';
 exception when insufficient_privilege then null; end;
end $$;

set request.jwt.claim.sub = '20000000-0000-4000-8000-000000000003';
select public.save_company_project('project-one',1,'Changed','{"saved":true}','[{"action":"saved"}]');
do $$
begin
 if not exists(select 1 from public.projects where id='project-one' and revision=2
   and created_by='20000000-0000-4000-8000-000000000001' and updated_by=auth.uid()
   and name='Changed' and data='{"saved":true}' and activity='[{"action":"saved"}]')
 then raise exception 'Atomic save, revision, shared access or audit failed'; end if;
 begin
  perform public.save_company_project('project-one',1,'Stale','{}','[]');
  raise exception 'Stale save succeeded';
 exception when serialization_failure then null; end;
 begin
  perform public.delete_company_project('project-one',1);
  raise exception 'Stale delete succeeded';
 exception when serialization_failure then null; end;
end $$;
insert into public.project_drawings(id,project_id,storage_path,original_name)
 values('drawing-one','project-one','10000000-0000-4000-8000-000000000001/project-one/drawing-one.pdf','plan.pdf');
do $$
begin
 begin
  insert into public.project_drawings(id,project_id,storage_path,original_name)
   values('bad-path','project-one','10000000-0000-4000-8000-000000000002/project-one/bad-path.pdf','bad.pdf');
  raise exception 'Drawing path escaped organization';
 exception when insufficient_privilege then null; end;
 begin
  update public.project_drawings set storage_path='changed.pdf' where id='drawing-one';
  raise exception 'Drawing ownership changed';
 exception when raise_exception then if sqlerrm <> 'Immutable drawing ownership' then raise; end if; end;
end $$;
insert into storage.objects(bucket_id,name)
 values('project-drawings','10000000-0000-4000-8000-000000000001/project-one/drawing-one.pdf');
do $$
declare claimed public.projects;
begin
 begin
  insert into storage.objects(bucket_id,name) values('project-drawings','10000000-0000-4000-8000-000000000001/missing/drawing.pdf');
  raise exception 'Storage accepted missing project';
 exception when insufficient_privilege then null; end;
 begin
  perform public.begin_company_project_delete('project-one',1);
  raise exception 'Stale deletion claim succeeded';
 exception when serialization_failure then null; end;
 if not exists(select 1 from public.projects where id='project-one' and not deleting and revision=2)
 then raise exception 'Stale deletion changed project'; end if;
 begin
  perform public.delete_company_project('project-one',2);
  raise exception 'Deletion did not require a claim';
 exception when serialization_failure then null; end;
 claimed := public.begin_company_project_delete('project-one',2);
 if claimed.revision <> 3 or not claimed.deleting then raise exception 'Deletion claim did not increment revision'; end if;
 claimed := public.begin_company_project_delete('project-one',3);
 if claimed.revision <> 3 then raise exception 'Deletion retry changed claim revision'; end if;
 begin
  perform public.save_company_project('project-one',3,'Cannot revive','{}','[]');
  raise exception 'Saved a claimed project';
 exception when serialization_failure then null; end;
 begin
  insert into storage.objects(bucket_id,name)
   values('project-drawings','10000000-0000-4000-8000-000000000001/project-one/after-claim.pdf');
  raise exception 'Uploaded to a claimed project';
 exception when insufficient_privilege then null; end;
 begin
  insert into public.project_drawings(id,project_id,storage_path,original_name)
   values('after-claim','project-one','10000000-0000-4000-8000-000000000001/project-one/after-claim.pdf','late.pdf');
  raise exception 'Added drawing to a claimed project';
 exception when insufficient_privilege then null; end;
 begin
  perform public.delete_company_project('project-one',3);
  raise exception 'Deleted project with files';
 exception when raise_exception then
  if sqlerrm <> 'Remove project files through the Storage API first' then raise; end if; end;
end $$;

set request.jwt.claim.sub = '20000000-0000-4000-8000-000000000004';
do $$
begin
 if exists(select 1 from public.projects) or exists(select 1 from public.project_drawings)
   or exists(select 1 from storage.objects)
 then raise exception 'Cross-org read succeeded'; end if;
 begin
  perform public.save_company_project('project-one',2,'Cross-org','{}','[]');
  raise exception 'Cross-org save succeeded';
 exception when serialization_failure then null; end;
 begin
  insert into storage.objects(bucket_id,name)
   values('project-drawings','10000000-0000-4000-8000-000000000001/project-one/other.pdf');
  raise exception 'Cross-org upload succeeded';
 exception when insufficient_privilege then null; end;
 delete from storage.objects;
 if found then raise exception 'Cross-org storage delete succeeded'; end if;
end $$;
reset role;

set role service_role;
select public.prepare_company_invite('20000000-0000-4000-8000-000000000001','invited@one.test','member');
do $$
begin
 begin
  perform public.prepare_company_invite('20000000-0000-4000-8000-000000000002','admin-new@one.test','admin');
  raise exception 'Admin granted admin';
 exception when raise_exception then if sqlerrm <> 'Not authorized' then raise; end if; end;
 begin
  perform public.prepare_company_invite('20000000-0000-4000-8000-000000000004','invited@one.test','member');
  raise exception 'Cross-org pending invitation';
 exception when raise_exception then if sqlerrm <> 'Invitation unavailable' then raise; end if; end;
 begin
  perform public.prepare_company_invite('20000000-0000-4000-8000-000000000001','owner@two.test','member');
  raise exception 'Existing member cross-org invitation';
 exception when raise_exception then if sqlerrm <> 'Invitation unavailable' then raise; end if; end;
 begin
  perform public.revoke_company_access('20000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001');
  raise exception 'Admin revoked owner';
 exception when raise_exception then if sqlerrm <> 'Not authorized' then raise; end if; end;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '20000000-0000-4000-8000-000000000005';
select public.accept_company_invite();
reset role;
do $$
begin
 if exists(select 1 from public.organization_members where user_id='20000000-0000-4000-8000-000000000005')
 then raise exception 'Unverified email accepted invitation'; end if;
 if exists(select 1 from public.organization_members where user_id='20000000-0000-4000-8000-000000000006')
 then raise exception 'Uninvited signup granted membership'; end if;
end $$;
update auth.users set email_confirmed_at=now() where email='invited@one.test';
do $$
begin
 if not exists(select 1 from public.organization_members where user_id='20000000-0000-4000-8000-000000000005' and role='member')
 then raise exception 'Verified invitation acceptance failed'; end if;
 if exists(select 1 from public.organization_invites where email='invited@one.test' and accepted_at is null)
 then raise exception 'Accepted invitation remains pending'; end if;
 if has_function_privilege('authenticated','public.company_ai_quota(uuid,integer,integer,integer,boolean)','execute')
 or has_function_privilege('authenticated','public.prepare_company_invite(uuid,text,text)','execute')
 or has_function_privilege('authenticated','public.accept_company_invite_for_user(uuid)','execute')
 or has_function_privilege('anon','public.accept_company_invite()','execute')
 or has_table_privilege('authenticated','public.ai_daily_usage','update')
 then raise exception 'Privileged API exposed'; end if;
 if not exists(select 1 from storage.buckets where id='project-drawings' and not public
   and file_size_limit=52428800 and allowed_mime_types=array['application/pdf'])
 then raise exception 'Private PDF bucket configuration incorrect'; end if;
end $$;

set role service_role;
do $$
declare result jsonb;
begin
 result := public.company_ai_quota('20000000-0000-4000-8000-000000000001',2,3,4,false);
 if result->>'used' is distinct from '0' then raise exception 'Quota read charged usage'; end if;
 perform public.company_ai_quota('20000000-0000-4000-8000-000000000001',2,3,4,true);
 perform public.company_ai_quota('20000000-0000-4000-8000-000000000001',2,3,4,true);
 result := public.company_ai_quota('20000000-0000-4000-8000-000000000001',2,3,4,true);
 if result->>'error' is distinct from 'daily_limit' or result->>'used' is distinct from '2'
 then raise exception 'User quota bypass'; end if;
 perform public.company_ai_quota('20000000-0000-4000-8000-000000000003',2,3,4,true);
 result := public.company_ai_quota('20000000-0000-4000-8000-000000000002',2,3,4,true);
 if result->>'error' is distinct from 'organization_limit' then raise exception 'Organization quota bypass'; end if;
 perform public.company_ai_quota('20000000-0000-4000-8000-000000000004',2,3,4,true);
 result := public.company_ai_quota('20000000-0000-4000-8000-000000000004',2,3,4,true);
 if result->>'error' is distinct from 'global_limit' then raise exception 'Global quota bypass'; end if;
 if (select used from public.ai_daily_usage where scope='global') <> 4
 then raise exception 'Rejected calls changed global usage'; end if;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '20000000-0000-4000-8000-000000000003';
delete from storage.objects where bucket_id='project-drawings';
select public.delete_company_project('project-one',3);
reset role;
do $$
begin
 if exists(select 1 from public.projects) or exists(select 1 from public.project_drawings)
 then raise exception 'Project deletion did not cascade metadata'; end if;
end $$;
rollback;
\echo 'Company access SQL regression passed (all changes rolled back).'
