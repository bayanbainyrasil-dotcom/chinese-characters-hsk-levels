import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {ReviewStore} from '../js/review-store.js';
import {ReviewSync} from '../js/review-sync.js';
function event(){const id=crypto.randomUUID();return {id,attemptId:id,char:'一',kind:'answer',mode:'learn',dueKey:'',grade:'good',assisted:false,mistakes:0,at:Date.now(),day:'2026-10-18',device:'test',durationMs:1,version:1};}
test('offline errors keep outbox; valid and quarantined events both stop retrying',async()=>{
 const store=new ReviewStore(crypto.randomUUID());const a=event(),b=event();await store.finish(a);await store.finish(b);
 let calls=0,fail=true;const statuses=[];
 const client={rpc:async()=>{calls++;return fail?{error:new Error('offline')}:{data:{acceptedIds:[a.id],rejected:[{id:b.id,reason:'clock'}],rows:[{seq:1,event:a}]}};}};
 const sync=new ReviewSync({store,getClient:async()=>client,getUser:()=>({id:'u'}),onStatus:s=>statuses.push(s)});
 await sync.bind();await sync.flush();assert.equal(await store.get('ack:u'),null);
 fail=false;await sync.flush();assert.equal((await store.events()).length,2);assert.equal((await store.get('ack:u')).rejected[0].id,b.id);assert.match(statuses.at(-1),/только здесь/);
});
test('dirty during busy causes another flush and other account never receives history',async()=>{
 const store=new ReviewStore(crypto.randomUUID());const first=event();await store.finish(first);let user={id:'u'},calls=0,release;
 const gate=new Promise(r=>release=r);
 const client={rpc:async(_,args)=>{calls++;if(calls===1)await gate;return {data:{acceptedIds:args.p_events.map(e=>e.id),rejected:[],rows:[]}};}};
 const sync=new ReviewSync({store,getClient:async()=>client,getUser:()=>user});await sync.bind();const run=sync.flush();
 while(calls===0)await new Promise(r=>setTimeout(r,1));await store.finish(event());await sync.flush();release();await run;assert.equal(calls,2);
 user={id:'other'};await sync.flush();assert.equal(calls,2);await assert.rejects(sync.bind());
});

test('account rebind requires explicit matching owner and preserves local journal',async()=>{
 const store=new ReviewStore(crypto.randomUUID());await store.finish(event());let user={id:'old'};const uploads=[];
 const sync=new ReviewSync({store,getUser:()=>user,getClient:async()=>({rpc:async(_,args)=>{uploads.push(args.p_events);return {data:{acceptedIds:args.p_events.map(e=>e.id),rows:[],rejected:[]}};}})});
 await sync.bind();user={id:'new'};await assert.rejects(sync.bind());await assert.rejects(sync.bind({replace:true,expectedOwner:'wrong'}));
 await sync.bind({replace:true,expectedOwner:'old'});await sync.flush();
 assert.equal(await store.get('sync-owner'),'new');assert.equal((await store.events()).length,1);assert.equal(uploads[0].length,1);
});
