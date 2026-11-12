create schema still_private;
revoke all on schema still_private from public;

create sequence still_private.record_revision;

create table still_private.records (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  version text collate "C" not null check (version ~ '^[0-9a-z]{9}-[0-9a-z]{4}-[0-9A-Za-z_]+$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  revision bigint not null,
  primary key (owner_id, id),
  check (payload ? 'id' and payload ? 'updatedAt'
    and (payload ->> 'updatedAt') is not distinct from version
    and id ~ '^(subscription|decision):[0-9A-Za-z_-]{1,128}$'
    and split_part(id, ':', 2) is not distinct from (payload ->> 'id'))
);
create index records_owner_revision on still_private.records (owner_id, revision);

alter table still_private.records enable row level security;
create policy records_read on still_private.records for select to authenticated using (owner_id = (select auth.uid()));
create policy records_insert on still_private.records for insert to authenticated with check (owner_id = (select auth.uid()));
create policy records_update on still_private.records for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

grant usage on schema still_private to authenticated;
grant usage on sequence still_private.record_revision to authenticated;
grant select, insert (id, version, payload), update (version, payload) on still_private.records to authenticated;

-- Sequence values must follow commit order: otherwise a pull can skip an older
-- revision that is still uncommitted. This transaction lock serializes writes.
create function still_private.lock_writes() returns trigger language plpgsql set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(783165214, 1);
  return null;
end;
$$;
create trigger lock_writes before insert or update on still_private.records
  for each statement execute function still_private.lock_writes();

create function still_private.stamp_revision() returns trigger language plpgsql set search_path = '' as $$
begin
  new.revision := pg_catalog.nextval('still_private.record_revision');
  return new;
end;
$$;
create trigger stamp_revision before insert or update on still_private.records
  for each row execute function still_private.stamp_revision();

revoke all on function still_private.lock_writes() from public, anon;
revoke all on function still_private.stamp_revision() from public, anon;

create function public.still_sync_pull(after_revision text, batch_size integer)
returns table (id text, version text, payload jsonb, revision text)
language sql stable security invoker set search_path = '' as $$
  select r.id, r.version, r.payload, r.revision::text
  from still_private.records r
  where r.owner_id = (select auth.uid()) and r.revision > after_revision::bigint
  order by r.revision
  limit greatest(1, least(batch_size, 100));
$$;

create function public.still_sync_push(changes jsonb)
returns table (id text, version text, payload jsonb)
language plpgsql security invoker set search_path = '' as $$
#variable_conflict use_column
begin
  if auth.uid() is null then
    raise exception 'Still Sync requires a Supabase Auth user' using errcode = '42501';
  end if;
  if jsonb_typeof(changes) is distinct from 'array' or jsonb_array_length(changes) > 100 then
    raise exception 'Invalid Still sync batch' using errcode = '22023';
  end if;

  insert into still_private.records as stored (id, version, payload)
    select change.id, change.version, change.payload
    from jsonb_to_recordset(changes) as change(id text, version text, payload jsonb)
  on conflict (owner_id, id) do update set version = excluded.version, payload = excluded.payload
    where stored.version < excluded.version;

  return query
    select stored.id, stored.version, stored.payload
    from jsonb_to_recordset(changes) as change(id text, version text)
    join still_private.records stored on stored.owner_id = (select auth.uid()) and stored.id = change.id
    where stored.version > (change.version collate "C");
end;
$$;

revoke all on function public.still_sync_pull(text, integer) from public, anon;
revoke all on function public.still_sync_push(jsonb) from public, anon;
grant execute on function public.still_sync_pull(text, integer) to authenticated;
grant execute on function public.still_sync_push(jsonb) to authenticated;
