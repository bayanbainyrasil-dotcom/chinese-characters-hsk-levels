\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000001','one@example.test'),('00000000-0000-4000-8000-000000000002','two@example.test') on conflict do nothing;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare e jsonb; result jsonb; bad jsonb;
begin
 e:=jsonb_build_object('id','10000000-0000-4000-8000-000000000001','attemptId','10000000-0000-4000-8000-000000000001','char','一','kind','answer','mode','review','dueKey','one','grade','good','assisted',false,'mistakes',0,'at',floor(extract(epoch from now())*1000),'day','2026-10-18','device','test','durationMs',10,'version',1);
 result:=public.sync_writing_reviews(jsonb_build_array(e));
 assert jsonb_array_length(result->'acceptedIds')=1;
 result:=public.sync_writing_reviews(jsonb_build_array(e));assert jsonb_array_length(result->'rows')=1,'duplicate';
 bad:=jsonb_set(e,'{id}','"10000000-0000-4000-8000-000000000002"');bad:=jsonb_set(bad,'{attemptId}',bad->'id');bad:=jsonb_set(bad,'{at}',to_jsonb(floor(extract(epoch from now())*1000+3600000)));
 result:=public.sync_writing_reviews(jsonb_build_array(bad,e));assert jsonb_array_length(result->'rejected')=1;assert jsonb_array_length(result->'acceptedIds')=1,'future blocks valid';
 result:=public.sync_writing_reviews(jsonb_build_array(jsonb_set(e,'{mistakes}','3')));assert jsonb_array_length(result->'rejected')=1,'conflicting id accepted';
 result:=public.sync_writing_reviews('[]',(result->'rows'->0->>'seq')::bigint);assert jsonb_array_length(result->'rows')=0;
 bad:=jsonb_set(e,'{id}','"10000000000040008000000000000003"');bad:=jsonb_set(bad,'{attemptId}',bad->'id');
 result:=public.sync_writing_reviews(jsonb_build_array(bad));assert jsonb_array_length(result->'rejected')=1,'noncanonical UUID accepted';
 begin perform public.sync_writing_reviews(null);raise exception 'NULL events accepted';exception when others then assert sqlerrm='invalid batch';end;
 begin perform public.sync_writing_reviews('[]',null,200);raise exception 'NULL cursor accepted';exception when others then assert sqlerrm='invalid batch';end;
 begin perform public.sync_writing_reviews('[]',0,null);raise exception 'NULL limit accepted';exception when others then assert sqlerrm='invalid batch';end;
 begin perform public.sync_writing_reviews('{}');raise exception 'bad batch accepted';exception when others then assert sqlerrm='invalid batch';end;
 begin insert into public.writing_reviews(user_id,id,event) values(auth.uid(),gen_random_uuid(),e);raise exception 'direct write accepted';exception when insufficient_privilege then null;end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
do $$ begin
 assert (select count(*) from public.writing_reviews)=0,'RLS leaks other user';
 assert jsonb_array_length(public.sync_writing_reviews('[]')->'rows')=0,'RPC leaks other user';
end $$;
reset role;
set local role anon;
do $$ begin
 begin perform public.sync_writing_reviews('[]');raise exception 'anon allowed';exception when insufficient_privilege then null;end;
end $$;
rollback;
