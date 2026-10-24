-- Bootstrap the first organization and owner with the SQL editor/service role.
-- Disable public signup in Auth settings; authorization never trusts user_metadata.
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  created_at timestamptz not null default now()
);

create table public.organization_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  email text not null,
  created_at timestamptz not null default now()
);
create index organization_members_org on public.organization_members(organization_id);

create table public.organization_invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null check (email = lower(trim(email))),
  role text not null check (role in ('admin', 'member')),
  invited_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz
);
create unique index organization_invites_pending_email on public.organization_invites(email) where accepted_at is null;

create function public.company_id() returns uuid
language sql stable security definer set search_path = ''
as $$ select organization_id from public.organization_members where user_id = auth.uid() $$;
create function public.company_role() returns text
language sql stable security definer set search_path = ''
as $$ select role from public.organization_members where user_id = auth.uid() $$;
revoke all on function public.company_id(), public.company_role() from public, anon;
grant execute on function public.company_id(), public.company_role() to authenticated;

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.organization_invites enable row level security;
create policy organizations_read on public.organizations for select to authenticated using (id = public.company_id());
create policy members_read on public.organization_members for select to authenticated using (organization_id = public.company_id());
create policy invites_read on public.organization_invites for select to authenticated
  using (organization_id = public.company_id() and public.company_role() in ('owner', 'admin'));
revoke all on public.organizations, public.organization_members, public.organization_invites from anon, authenticated;
grant select on public.organizations, public.organization_members, public.organization_invites to authenticated;
grant all on public.organizations, public.organization_members, public.organization_invites to service_role;

create table public.projects (
  id text primary key check (id ~ '^[A-Za-z0-9_-]+$'),
  organization_id uuid not null references public.organizations(id),
  name text not null check (length(name) between 1 and 500),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  activity jsonb not null default '[]'::jsonb check (jsonb_typeof(activity) = 'array'),
  revision bigint not null default 1 check (revision > 0),
  deleting boolean not null default false,
  created_by uuid not null default auth.uid() references auth.users(id),
  updated_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_org on public.projects(organization_id);

create table public.project_drawings (
  id text primary key check (id ~ '^[A-Za-z0-9_-]+$'),
  project_id text not null references public.projects(id) on delete cascade,
  storage_path text not null unique,
  original_name text not null check (length(original_name) between 1 and 500),
  created_by uuid not null default auth.uid() references auth.users(id),
  updated_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index project_drawings_project on public.project_drawings(project_id);

create function public.audit_company_row() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authenticated user required'; end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    if tg_table_name = 'projects' then
      new.revision := 1;
      new.deleting := false;
    end if;
  else
    if new.id is distinct from old.id or new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at then raise exception 'Immutable creation fields'; end if;
    if tg_table_name = 'projects' then
      if new.organization_id is distinct from old.organization_id then raise exception 'Immutable organization'; end if;
      if new.revision is distinct from old.revision then raise exception 'Submit the current revision'; end if;
      new.revision := old.revision + 1;
    else
      if new.project_id is distinct from old.project_id or new.storage_path is distinct from old.storage_path then
        raise exception 'Immutable drawing ownership';
      end if;
    end if;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;
create trigger projects_audit before insert or update on public.projects for each row execute function public.audit_company_row();
create trigger project_drawings_audit before insert or update on public.project_drawings for each row execute function public.audit_company_row();

create function public.can_write_company_project(p_project_id text) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  perform 1 from public.projects where id = p_project_id
    and organization_id = public.company_id() and not deleting for key share;
  return found;
end;
$$;
revoke all on function public.can_write_company_project(text) from public, anon;
grant execute on function public.can_write_company_project(text) to authenticated;

alter table public.projects enable row level security;
alter table public.project_drawings enable row level security;
create policy projects_read on public.projects for select to authenticated using (organization_id = public.company_id());
create policy projects_create on public.projects for insert to authenticated with check (organization_id = public.company_id());
create policy projects_update on public.projects for update to authenticated using (organization_id = public.company_id()) with check (organization_id = public.company_id());
-- Deletion is through the compare-and-swap RPC below, not an unguarded REST DELETE.
create policy drawings_read on public.project_drawings for select to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and p.organization_id = public.company_id()));
create policy drawings_create on public.project_drawings for insert to authenticated
  with check (public.can_write_company_project(project_id) and exists (select 1 from public.projects p where p.id = project_id and p.organization_id = public.company_id()
    and storage_path = p.organization_id::text || '/' || p.id || '/' || project_drawings.id || '.pdf'));
create policy drawings_update on public.project_drawings for update to authenticated
  using (public.can_write_company_project(project_id))
  with check (public.can_write_company_project(project_id) and exists (select 1 from public.projects p where p.id = project_id and p.organization_id = public.company_id()
    and storage_path = p.organization_id::text || '/' || p.id || '/' || project_drawings.id || '.pdf'));
create policy drawings_delete on public.project_drawings for delete to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and p.organization_id = public.company_id()));
revoke all on public.projects, public.project_drawings from anon, authenticated;
-- Force every save through the CAS RPC; a raw REST UPDATE could omit the revision.
grant select, insert on public.projects to authenticated;
grant select, insert, update, delete on public.project_drawings to authenticated;
grant all on public.projects, public.project_drawings to service_role;

create function public.save_company_project(p_project_id text, p_expected_revision bigint, p_name text, p_data jsonb, p_activity jsonb)
returns public.projects language plpgsql security definer set search_path = ''
as $$
declare result public.projects;
begin
  update public.projects set name = p_name, data = p_data, activity = p_activity
    where id = p_project_id and organization_id = public.company_id() and revision = p_expected_revision and not deleting
    returning * into result;
  if not found then raise exception 'Project changed or unavailable' using errcode = '40001'; end if;
  return result;
end;
$$;

create function public.begin_company_project_delete(p_project_id text, p_expected_revision bigint)
returns public.projects language plpgsql security definer set search_path = ''
as $$
declare result public.projects;
begin
  -- Claim before removing any files. Stale callers must never touch current files.
  select * into result from public.projects where id = p_project_id
    and organization_id = public.company_id() and revision = p_expected_revision for update;
  if not found then raise exception 'Project changed or unavailable' using errcode = '40001'; end if;
  if result.deleting then return result; end if;
  update public.projects set deleting = true where id = p_project_id returning * into result;
  return result;
end;
$$;

create function public.delete_company_project(p_project_id text, p_expected_revision bigint)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  -- Files must be removed with the Storage API, never by deleting storage.objects.
  -- Refuse SQL deletion until all objects under this project prefix have gone.
  perform 1 from public.projects where id = p_project_id and organization_id = public.company_id()
    and revision = p_expected_revision and deleting for update;
  if not found then raise exception 'Project changed or unavailable' using errcode = '40001'; end if;
  if exists (select 1 from storage.objects where bucket_id = 'project-drawings'
    and name like public.company_id()::text || '/' || replace(replace(p_project_id, '_', '\_'), '%', '\%') || '/%') then
    raise exception 'Remove project files through the Storage API first';
  end if;
  delete from public.projects where id = p_project_id and organization_id = public.company_id();
end;
$$;
revoke all on function public.save_company_project(text,bigint,text,jsonb,jsonb), public.begin_company_project_delete(text,bigint), public.delete_company_project(text,bigint) from public, anon;
grant execute on function public.save_company_project(text,bigint,text,jsonb,jsonb), public.begin_company_project_delete(text,bigint), public.delete_company_project(text,bigint) to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('project-drawings', 'project-drawings', false, 52428800, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 52428800, allowed_mime_types = array['application/pdf'];

create function public.can_access_drawing_path(p_name text, p_write boolean default false) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  -- Hold the parent row through the Storage transaction. A concurrent project
  -- deletion must see a committed upload, or the upload must see a deleted project.
  perform 1 from public.projects p
    where p.organization_id = public.company_id()
      and (not p_write or not p.deleting)
      and p_name ~ '^[0-9a-f-]{36}/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+\.pdf$'
      and p_name = p.organization_id::text || '/' || p.id || '/' || split_part(p_name, '/', 3)
    for key share;
  return found;
end;
$$;
revoke all on function public.can_access_drawing_path(text,boolean) from public, anon;
grant execute on function public.can_access_drawing_path(text,boolean) to authenticated;
create policy company_drawing_objects_read on storage.objects for select to authenticated
  using (bucket_id = 'project-drawings' and public.can_access_drawing_path(name));
create policy company_drawing_objects_create on storage.objects for insert to authenticated
  with check (bucket_id = 'project-drawings' and public.can_access_drawing_path(name, true));
create policy company_drawing_objects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'project-drawings' and public.can_access_drawing_path(name));
-- PDFs are immutable; replacing one requires a new drawing ID, not overwriting a shared file.

create function public.prepare_company_invite(p_actor uuid, p_email text, p_role text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare actor public.organization_members; target_org uuid; target_user uuid; invitation public.organization_invites;
begin
  -- Serialize preparation/acceptance/revocation, including same-email cross-org races.
  perform pg_catalog.pg_advisory_xact_lock(784126391);
  select * into actor from public.organization_members where user_id = p_actor for update;
  if actor.role not in ('owner', 'admin') or actor.user_id is null then raise exception 'Not authorized'; end if;
  if p_role not in ('admin', 'member') or (p_role = 'admin' and actor.role <> 'owner') then raise exception 'Not authorized'; end if;
  p_email := lower(trim(p_email));
  if length(p_email) > 254 or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Invalid email'; end if;
  select id into target_user from auth.users where lower(email) = p_email;
  select organization_id into target_org from public.organization_members where user_id = target_user;
  if target_org is not null then raise exception 'Invitation unavailable'; end if;
  delete from public.organization_invites where email = p_email and accepted_at is null and expires_at <= now();
  select * into invitation from public.organization_invites where email = p_email and accepted_at is null for update;
  if found then
    if invitation.organization_id <> actor.organization_id then raise exception 'Invitation unavailable'; end if;
    if actor.role <> 'owner' and invitation.role = 'admin' then raise exception 'Not authorized'; end if;
    update public.organization_invites set role = p_role, invited_by = p_actor, expires_at = now() + interval '7 days'
      where id = invitation.id returning * into invitation;
  else
    insert into public.organization_invites(organization_id,email,role,invited_by)
      values(actor.organization_id,p_email,p_role,p_actor) returning * into invitation;
  end if;
  return jsonb_build_object('id', invitation.id, 'existing_user', target_user is not null);
end;
$$;

create function public.accept_company_invite_for_user(p_user_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare target auth.users; invitation public.organization_invites; existing public.organization_members;
begin
  perform pg_catalog.pg_advisory_xact_lock(784126391);
  select * into target from auth.users where id = p_user_id;
  if target.email_confirmed_at is null then return; end if;
  select * into invitation from public.organization_invites
    where email = lower(target.email) and accepted_at is null and expires_at > now() for update;
  if not found then return; end if;
  select * into existing from public.organization_members where user_id = p_user_id;
  if found then
    -- Never move an existing user to another org or mutate an existing role.
    return;
  end if;
  insert into public.organization_members(user_id,organization_id,role,email)
    values(p_user_id,invitation.organization_id,invitation.role,lower(target.email));
  update public.organization_invites set accepted_at = now() where id = invitation.id;
end;
$$;
create function public.accept_company_invite() returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  perform public.accept_company_invite_for_user(auth.uid());
end;
$$;
create function public.accept_invited_auth_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform public.accept_company_invite_for_user(new.id);
  return new;
end;
$$;
create trigger company_invite_acceptance after insert or update of email_confirmed_at, email on auth.users
  for each row execute function public.accept_invited_auth_user();
revoke all on function public.accept_company_invite_for_user(uuid), public.accept_invited_auth_user() from public, anon, authenticated;
revoke all on function public.accept_company_invite() from public, anon;
grant execute on function public.accept_company_invite() to authenticated;

create function public.revoke_company_access(p_actor uuid, p_user_id uuid default null, p_invite_id uuid default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare actor public.organization_members; target_role text; target_org uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(784126391);
  select * into actor from public.organization_members where user_id = p_actor for update;
  if actor.user_id is null or actor.role not in ('owner','admin') then raise exception 'Not authorized'; end if;
  if (p_user_id is null) = (p_invite_id is null) then raise exception 'Provide one target'; end if;
  if p_user_id is not null then
    select role, organization_id into target_role, target_org from public.organization_members where user_id = p_user_id for update;
  else
    select role, organization_id into target_role, target_org from public.organization_invites where id = p_invite_id and accepted_at is null for update;
  end if;
  if target_org is distinct from actor.organization_id or target_role = 'owner'
    or (target_role = 'admin' and actor.role <> 'owner') then raise exception 'Not authorized'; end if;
  if p_user_id is not null then delete from public.organization_members where user_id = p_user_id;
  else delete from public.organization_invites where id = p_invite_id; end if;
end;
$$;
revoke all on function public.prepare_company_invite(uuid,text,text), public.revoke_company_access(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.prepare_company_invite(uuid,text,text), public.revoke_company_access(uuid,uuid,uuid) to service_role;

create table public.ai_daily_usage (
  day date not null,
  scope text not null,
  used bigint not null default 0 check (used >= 0),
  primary key(day,scope)
);
alter table public.ai_daily_usage enable row level security;
revoke all on public.ai_daily_usage from public, anon, authenticated;
grant all on public.ai_daily_usage to service_role;

create function public.company_ai_quota(p_user_id uuid, p_user_limit integer default 25,
  p_org_limit integer default 100, p_global_limit integer default 200, p_consume boolean default true)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare org uuid; utc_day date := (now() at time zone 'UTC')::date;
  u bigint; o bigint; g bigint; reason text;
begin
  -- Only the server service role may supply limits or user IDs.
  perform pg_catalog.pg_advisory_xact_lock(784126392);
  select organization_id into org from public.organization_members where user_id = p_user_id for share;
  if org is null then raise exception 'Company membership required'; end if;
  if p_user_limit is null or p_org_limit is null or p_global_limit is null
    or p_user_limit < 0 or p_org_limit < 0 or p_global_limit < 0 then raise exception 'Invalid quota'; end if;
  insert into public.ai_daily_usage(day,scope) values
    (utc_day,'global'),(utc_day,'org:' || org::text),(utc_day,'user:' || p_user_id::text) on conflict do nothing;
  select used into u from public.ai_daily_usage where day = utc_day and scope = 'user:' || p_user_id::text;
  select used into o from public.ai_daily_usage where day = utc_day and scope = 'org:' || org::text;
  select used into g from public.ai_daily_usage where day = utc_day and scope = 'global';
  if u >= p_user_limit then reason := 'daily_limit';
  elsif o >= p_org_limit then reason := 'organization_limit';
  elsif g >= p_global_limit then reason := 'global_limit'; end if;
  if p_consume and reason is null then
    update public.ai_daily_usage set used = used + 1 where day = utc_day
      and scope in ('global','org:' || org::text,'user:' || p_user_id::text);
    u := u + 1;
  end if;
  return jsonb_build_object('allowed',reason is null,'error',reason,'used',u,'limit',p_user_limit);
end;
$$;
revoke all on function public.company_ai_quota(uuid,integer,integer,integer,boolean) from public, anon, authenticated;
grant execute on function public.company_ai_quota(uuid,integer,integer,integer,boolean) to service_role;
