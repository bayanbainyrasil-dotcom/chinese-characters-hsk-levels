import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {ReviewStore} from '../js/review-store.js';
const event=(extra={})=>{const id=crypto.randomUUID();return {id,attemptId:id,char:'一',kind:'answer',mode:'learn',dueKey:'',grade:'good',assisted:false,mistakes:0,at:Date.now(),day:'2026-10-18',device:'test',durationMs:1,version:1,...extra};};
const store=()=>new ReviewStore(crypto.randomUUID());
test('dedicated backup survives repeated migration with existing legacy markers',async()=>{
 const s=store(); await s.migrate({completed:{hsk:{'3:安':5}},migration:'v2'});await s.migrate({completed:{}});
 assert.equal((await s.get('legacy-memory-backup-v1')).progress.completed.hsk['3:安'],5);
 assert.deepEqual(await s.events(),[]);
});
test('help and mistakes survive reload and terminal write is atomic/idempotent',async()=>{
 const s=store();const e=event();await s.setPending('tab',{id:e.id,assisted:false,mistakes:0});await s.patchPending('tab',{assisted:true,mistakes:3});
 const reload=new ReviewStore(s.name);assert.equal((await reload.pending('tab')).assisted,true);
 assert.equal(await reload.finish(e,'tab'),true);assert.equal(await reload.finish(e,'tab'),false);
 assert.equal((await reload.events())[0].assisted,true);assert.equal((await reload.events())[0].mistakes,3);assert.equal(await reload.pending('tab'),null);
});
test('clean interruption does not acquire assistance',async()=>{
 const s=store();const e=event();await s.setPending('tab',{id:e.id,assisted:false,mistakes:0});
 await new ReviewStore(s.name).finish(e,'tab');assert.equal((await s.events())[0].assisted,false);
});
test('import is union, duplicate safe, conflict rolls back whole transaction',async()=>{
 const s=store();const a=event(), b=event();const pack={schema:'bishun-memory-backup-v1',schedulerVersion:1,events:[a]};
 await s.import(pack);await s.import(pack);assert.equal((await s.events()).length,1);
 await assert.rejects(s.import({...pack,events:[b,{...a,mistakes:4}]}));assert.equal((await s.events()).length,1);
 await assert.rejects(s.import({...pack,events:[b,{bad:'data'}]}));assert.equal((await s.events()).length,1);
});
test('two tabs adding different events do not overwrite; no 500 event truncation',async()=>{
 const s=store(),second=new ReviewStore(s.name);await Promise.all([s.finish(event()),second.finish(event())]);
 await s.import({schema:'bishun-memory-backup-v1',schedulerVersion:1,events:Array.from({length:501},()=>event())});
 assert.equal((await s.events()).length,503);
});
test('cursor and ack update only after valid local merge',async()=>{
 const s=store();const e=event();await s.finish(e);
 await assert.rejects(s.mergeRemote([{...e,mistakes:8}],{cursorKey:'cursor',cursor:5,ackKey:'ack',accepted:[e.id]}));
 assert.equal(await s.get('cursor'),null);assert.equal(await s.get('ack'),null);
});

test('concurrent starts claim one durable attempt; parked help cannot be reset',async()=>{
 const s=store(),other=new ReviewStore(s.name);const e=event();
 const [a,b]=await Promise.all([s.claimPending('device',e),other.claimPending('device',event())]);assert.equal(a.id,b.id);
 await s.patchPending('device',{assisted:true,mistakes:3},a.id);
 await other.patchPending('device',{assisted:false,mistakes:1},a.id);
 await s.suspendPending('device');assert.equal(await s.pending('device'),null);
 const resumed=await other.claimPending('device',event());assert.equal(resumed.id,a.id);assert.equal(resumed.assisted,true);assert.equal(resumed.mistakes,3);
 await assert.rejects(s.patchPending('device',{assisted:true},crypto.randomUUID()));
});
test('server clock skew and invalid remote rows cannot stall cursor; imports stay strict',async()=>{
 const s=store(),future=event({at:Date.now()+3600000}),valid=event();
 await assert.rejects(s.import({schema:'bishun-memory-backup-v1',schedulerVersion:1,events:[future]}));
 await s.mergeRemote([future,{bad:'data'},valid],{trustedRemote:true,cursorKey:'cursor',cursor:3,ackKey:'ack'});
 assert.equal((await s.events()).length,2);assert.equal(await s.get('cursor'),3);
 assert.equal((await s.get('remote-quarantine')).length,1);assert.equal((await s.get('ack')).rejected.length,1);
});

test('parked attempt adopts current review window but never clears help or mistakes',async()=>{
 const s=store();const old=event({assisted:true,mistakes:3});await s.claimPending('device',old);await s.suspendPending('device');
 const fresh=event({mode:'review',dueKey:'一:3:future'});const restored=await s.claimPending('device',fresh);
 assert.equal(restored.id,fresh.id);assert.equal(restored.mode,'review');assert.equal(restored.dueKey,fresh.dueKey);
 assert.equal(restored.assisted,true);assert.equal(restored.mistakes,3);
});
