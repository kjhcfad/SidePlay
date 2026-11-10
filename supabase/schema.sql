-- Sideplay: run this entire file in Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  host_id uuid not null,
  allow_controls boolean not null default false,
  playback jsonb not null default '{"track":null,"playing":false,"position":0,"updatedAt":0,"changedBy":""}'::jsonb,
  queue jsonb not null default '[]'::jsonb,
  history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.participants (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null,
  nickname text not null,
  is_host boolean not null default false,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index if not exists participants_room_idx on public.participants(room_id);

alter table public.rooms enable row level security;
alter table public.participants enable row level security;

-- Read access is limited to rooms a signed-in anonymous user has joined.
create policy "members read rooms" on public.rooms for select to authenticated
using (exists (select 1 from public.participants p where p.room_id = id and p.user_id = auth.uid()));
-- SECURITY DEFINER helper avoids recursive RLS evaluation on participants.
create or replace function public.is_room_member(p_room_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.participants where room_id=p_room_id and user_id=auth.uid())
$$;
grant execute on function public.is_room_member(uuid) to authenticated;

drop policy if exists "members read participants" on public.participants;
create policy "members read participants" on public.participants for select to authenticated
using (public.is_room_member(room_id));

create or replace function public.create_room(p_nickname text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_code text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  v_code := upper(substr(encode(gen_random_bytes(5), 'hex'), 1, 6));
  insert into rooms(code, host_id) values(v_code, auth.uid()) returning id into v_id;
  insert into participants(room_id,user_id,nickname,is_host) values(v_id,auth.uid(),left(coalesce(nullif(trim(p_nickname),''),'Host'),24),true);
  return v_id;
end $$;

create or replace function public.join_room(p_code text, p_nickname text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_room rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into v_room from rooms where code = upper(trim(p_code));
  if not found then raise exception 'Room not found. Check the code and try again.'; end if;
  insert into participants(room_id,user_id,nickname,is_host,last_seen)
  values(v_room.id,auth.uid(),left(coalesce(nullif(trim(p_nickname),''),'Guest'),24),v_room.host_id=auth.uid(),now())
  on conflict(room_id,user_id) do update set nickname=excluded.nickname,last_seen=now();
  return v_room.id;
end $$;

create or replace function public.leave_room(p_room_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_host uuid; v_next uuid;
begin
  select host_id into v_host from rooms where id=p_room_id;
  delete from participants where room_id=p_room_id and user_id=auth.uid();
  if v_host=auth.uid() then
    select user_id into v_next from participants where room_id=p_room_id order by joined_at limit 1;
    if v_next is null then delete from rooms where id=p_room_id;
    else update rooms set host_id=v_next where id=p_room_id;
         update participants set is_host=(user_id=v_next) where room_id=p_room_id;
    end if;
  end if;
end $$;

create or replace function public.set_playback(p_room_id uuid,p_playback jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r rooms%rowtype;
begin
  select * into r from rooms where id=p_room_id for update;
  if not exists(select 1 from participants where room_id=p_room_id and user_id=auth.uid()) then raise exception 'Join this room first'; end if;
  if r.host_id<>auth.uid() and not r.allow_controls then raise exception 'Only the host can control playback'; end if;
  update rooms set playback=p_playback where id=p_room_id;
end $$;

create or replace function public.advance_queue(p_room_id uuid,p_playback jsonb,p_queue jsonb,p_history jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r rooms%rowtype;
begin
  select * into r from rooms where id=p_room_id for update;
  if r.host_id<>auth.uid() and not r.allow_controls then raise exception 'Only the host can skip'; end if;
  update rooms set playback=p_playback,queue=p_queue,history=p_history where id=p_room_id;
end $$;

create or replace function public.add_to_queue(p_room_id uuid,p_track jsonb,p_nickname text)
returns void language plpgsql security definer set search_path = public as $$
declare r rooms%rowtype; q jsonb;
begin
  select * into r from rooms where id=p_room_id for update;
  if not exists(select 1 from participants where room_id=p_room_id and user_id=auth.uid()) then raise exception 'Join this room first'; end if;
  if jsonb_array_length(r.queue)>=50 then raise exception 'The queue is full (50 tracks maximum)'; end if;
  if exists(select 1 from jsonb_array_elements(r.queue) x where x->>'videoId'=p_track->>'videoId')
     or r.playback->'track'->>'videoId'=p_track->>'videoId' then raise exception 'That track is already in the room'; end if;
  q := r.queue || jsonb_build_array(jsonb_build_object(
    'id',gen_random_uuid()::text,'videoId',p_track->>'videoId','title',left(p_track->>'title',200),
    'artist',left(p_track->>'artist',150),'thumbnail',p_track->>'thumbnail',
    'duration',p_track->>'duration','addedBy',left(coalesce(p_nickname,'Guest'),24),'addedById',auth.uid()::text,'addedAt',extract(epoch from now())*1000));
  update rooms set queue=q where id=p_room_id;
end $$;

create or replace function public.remove_from_queue(p_room_id uuid,p_item_id text)
returns void language plpgsql security definer set search_path = public as $$
declare r rooms%rowtype; item jsonb;
begin
  select * into r from rooms where id=p_room_id for update;
  select x into item from jsonb_array_elements(r.queue) x where x->>'id'=p_item_id;
  if item is null then return; end if;
  if r.host_id<>auth.uid() and item->>'addedById' <> auth.uid()::text then
    raise exception 'You can only remove your own suggestions';
  end if;
  update rooms set queue=(select coalesce(jsonb_agg(x),'[]'::jsonb) from jsonb_array_elements(r.queue) x where x->>'id'<>p_item_id) where id=p_room_id;
end $$;

create or replace function public.set_room_controls(p_room_id uuid,p_allow boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  update rooms set allow_controls=p_allow where id=p_room_id and host_id=auth.uid();
  if not found then raise exception 'Only the host can change room settings'; end if;
end $$;

grant execute on function public.create_room(text) to authenticated;
grant execute on function public.join_room(text,text) to authenticated;
grant execute on function public.leave_room(uuid) to authenticated;
grant execute on function public.set_playback(uuid,jsonb) to authenticated;
grant execute on function public.advance_queue(uuid,jsonb,jsonb,jsonb) to authenticated;
grant execute on function public.add_to_queue(uuid,jsonb,text) to authenticated;
grant execute on function public.remove_from_queue(uuid,text) to authenticated;
grant execute on function public.set_room_controls(uuid,boolean) to authenticated;

-- Enable Realtime for room and participant changes.
alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.participants;
