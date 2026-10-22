-- Separate journal: old clients cannot overwrite memory using max(completed).
create table if not exists public.writing_reviews (
 seq bigint generated always as identity primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 id uuid not null,
 received_at timestamptz not null default clock_timestamp(),
 event jsonb not null,
 unique(user_id,id)
);
alter table public.writing_reviews enable row level security;
drop policy if exists writing_reviews_owner on public.writing_reviews;
create policy writing_reviews_owner on public.writing_reviews for select to authenticated using(auth.uid()=user_id);
grant select on public.writing_reviews to authenticated;
revoke insert,update,delete on public.writing_reviews from anon,authenticated;

create or replace function public.sync_writing_reviews(p_events jsonb default '[]',p_after bigint default 0,p_limit integer default 200)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 uid uuid:=auth.uid(); e jsonb; old jsonb; eid uuid; accepted jsonb:='[]'; rejected jsonb:='[]'; rows_out jsonb; n numeric;
begin
 if uid is null then raise exception 'authentication required' using errcode='42501'; end if;
 if p_events is null or p_after is null or p_limit is null or jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events)>100 or p_after<0 or p_limit<1 or p_limit>200 then
  raise exception 'invalid batch';
 end if;
 -- Hold through commit: a concurrent pull cannot advance past an invisible insertion.
 perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
 for e in select value from jsonb_array_elements(p_events) loop
  begin
   if jsonb_typeof(e)<>'object' or (select count(*) from jsonb_object_keys(e))<>14 or
    exists(select 1 from jsonb_object_keys(e) k where k not in ('id','attemptId','char','kind','mode','dueKey','grade','assisted','mistakes','at','day','device','durationMs','version')) then raise exception 'invalid event fields'; end if;
   eid:=(e->>'id')::uuid;
   if coalesce(e->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or eid is null or (e->>'attemptId')::uuid is distinct from eid or e->>'id'<>e->>'attemptId' or
    coalesce(e->>'char','') !~ '^[㐀-䶿一-鿿]$' or
    coalesce(e->>'kind','') not in ('introduce','practice','answer') or
    coalesce(e->>'mode','') not in ('learn','review','practice') or
    e->'version'<>'1'::jsonb or jsonb_typeof(e->'assisted')<>'boolean' or
    jsonb_typeof(e->'device')<>'string' or length(e->>'device') not between 1 and 100 or
    jsonb_typeof(e->'dueKey')<>'string' or length(e->>'dueKey')>150 or
    coalesce(e->>'day','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid event values'; end if;
   if (e->>'kind'='answer' and coalesce(e->>'grade','') not in ('good','again')) or
    (e->>'kind'<>'answer' and e->'grade'<>'null'::jsonb) then raise exception 'invalid grade'; end if;
   if jsonb_typeof(e->'at')<>'number' or jsonb_typeof(e->'mistakes')<>'number' or jsonb_typeof(e->'durationMs')<>'number' then raise exception 'invalid numbers'; end if;
   n:=(e->>'at')::numeric;
   if n<>trunc(n) or n<1577836800000 or n>extract(epoch from clock_timestamp())*1000+300000 then raise exception 'check device clock'; end if;
   n:=(e->>'mistakes')::numeric;if n<>trunc(n) or n<0 or n>10000 then raise exception 'invalid mistakes';end if;
   n:=(e->>'durationMs')::numeric;if n<>trunc(n) or n<0 or n>86400000 then raise exception 'invalid duration';end if;
   select event into old from public.writing_reviews where user_id=uid and id=eid;
   if old is not null and old<>e then raise exception 'conflicting attempt id';end if;
   insert into public.writing_reviews(user_id,id,event) values(uid,eid,e) on conflict(user_id,id) do nothing;
   accepted:=accepted||jsonb_build_array(e->>'id');
  exception when others then
   rejected:=rejected||jsonb_build_array(jsonb_build_object('id',e->>'id','reason',sqlerrm));
  end;
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('seq',r.seq,'event',r.event) order by r.seq),'[]'::jsonb) into rows_out
 from (select seq,event from public.writing_reviews where user_id=uid and seq>p_after order by seq limit p_limit) r;
 return jsonb_build_object('acceptedIds',accepted,'rejected',rejected,'rows',rows_out);
end $$;
revoke all on function public.sync_writing_reviews(jsonb,bigint,integer) from public,anon;
grant execute on function public.sync_writing_reviews(jsonb,bigint,integer) to authenticated;
