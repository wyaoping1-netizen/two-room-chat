-- Run this after the rooms, room_members and messages tables exist.
-- These functions validate the invite key before a member is added.

-- Compatibility columns for a rooms table created by an earlier draft.
alter table public.rooms add column if not exists room_code text;
alter table public.rooms add column if not exists invite_key_hash text;
alter table public.rooms add column if not exists created_by uuid;
create unique index if not exists rooms_room_code_unique on public.rooms (room_code);

alter table public.room_members add column if not exists display_name text;
alter table public.room_members add column if not exists joined_at timestamptz default now();

alter table public.messages add column if not exists body text;
alter table public.messages add column if not exists created_at timestamptz default now();

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'messages' and column_name = 'text'
  ) then
    execute 'update public.messages set body = "text" where body is null';
  end if;
end
$$;

create or replace function public.create_room(
  p_room_code text,
  p_invite_key_hash text,
  p_display_name text
)
returns table(room_id uuid, room_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  new_room_id uuid;
begin
  if auth.uid() is null then
    raise exception '请先完成匿名登录';
  end if;

  insert into public.rooms (room_code, invite_key_hash, created_by, name)
  values (upper(trim(p_room_code)), p_invite_key_hash, auth.uid(), '只属于你们的房间')
  returning id into new_room_id;

  insert into public.room_members (room_id, user_id, display_name)
  values (new_room_id, auth.uid(), left(trim(p_display_name), 24));

  return query select new_room_id, upper(trim(p_room_code));
end;
$$;

create or replace function public.join_room(
  p_room_code text,
  p_invite_key_hash text,
  p_display_name text
)
returns table(room_id uuid, room_code text, member_count bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_room public.rooms%rowtype;
  current_count bigint;
  already_member boolean;
begin
  if auth.uid() is null then
    raise exception '请先完成匿名登录';
  end if;

  select * into target_room
  from public.rooms
  where public.rooms.room_code = upper(trim(p_room_code))
    and public.rooms.invite_key_hash = p_invite_key_hash;

  if target_room.id is null then
    raise exception '房间代码或私密口令不正确';
  end if;

  select exists (
    select 1 from public.room_members
    where room_id = target_room.id and user_id = auth.uid()
  ) into already_member;

  select count(*) into current_count
  from public.room_members where room_id = target_room.id;

  if not already_member and current_count >= 2 then
    raise exception '这个房间已经有两位成员了';
  end if;

  insert into public.room_members (room_id, user_id, display_name)
  values (target_room.id, auth.uid(), left(trim(p_display_name), 24))
  on conflict (room_id, user_id)
  do update set display_name = excluded.display_name;

  return query
    select target_room.id, target_room.room_code,
      (select count(*) from public.room_members where room_id = target_room.id);
end;
$$;

revoke all on function public.create_room(text, text, text) from public;
revoke all on function public.join_room(text, text, text) from public;
grant execute on function public.create_room(text, text, text) to authenticated;
grant execute on function public.join_room(text, text, text) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'room_members') then
    alter publication supabase_realtime add table public.room_members;
  end if;
end
$$;
