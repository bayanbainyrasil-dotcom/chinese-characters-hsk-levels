import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {MNEMONICS,mnemonicFor,validateNotes,hintStageOf} from '../js/mnemonic-data.js';
import {IDS} from '../js/mnemonic-ids.js';
import {ReviewStore} from '../js/review-store.js';
const fixture=fs.readFileSync(new URL('./fixtures/mnemonic-source.jsonl',import.meta.url),'utf8').trim().split('\n').map(JSON.parse);
const makeStore=()=>new ReviewStore(crypto.randomUUID());
function event(){const id=crypto.randomUUID();return {id,attemptId:id,char:'安',kind:'answer',mode:'learn',dueKey:'',grade:'good',assisted:false,mistakes:0,at:Date.now(),day:'2026-10-19',device:'test',durationMs:0,version:1};}
test('24 original aids match source IDS and actual writing repertoire',()=>{
 const rows=Object.values(JSON.parse(fs.readFileSync(new URL('../data/writing.json',import.meta.url))).groups).flat();
 assert.equal(Object.keys(MNEMONICS).length,24);assert.equal(fixture.length,24);
 for(const [char,entry] of Object.entries(MNEMONICS)){
  assert.ok(rows.some(r=>r.char===char));assert.equal(IDS[char],fixture.find(r=>r.character===char).decomposition);
  if(entry.parts.length){for(const part of entry.parts)assert.ok(!entry.story.includes(part.glyph));assert.ok(!IDS[char].includes('？'));assert.equal(entry.parts.map(p=>p.glyph).join(''),IDS[char].replace(/[⿰-⿻]/g,''));}
 }
 assert.equal(mnemonicFor('安').layout,'stack');assert.equal(mnemonicFor('安').parts[0].glyph,'宀');assert.equal(mnemonicFor('好').parts[0].glyph,'女');
});
test('notes backup is optional, merges without replacement, and rejects malformed data atomically',async()=>{
 const store=makeStore(),a=event();await store.finish(a);await store.saveNote('安','Моя крыша');
 const original=await store.export();await store.import({schema:original.schema,schedulerVersion:1,events:[]});
 await store.import({...original,notes:{安:'Другая история',好:'Новая история'}});assert.deepEqual(await store.notes(),{安:'Моя крыша',好:'Новая история'});
 await assert.rejects(store.import({...original,notes:{休:'Не сохранять'},events:[{...a,mistakes:2}]}));assert.equal((await store.notes()).休,undefined);
 await assert.rejects(store.import({...original,notes:{安:'x'.repeat(501)}}));assert.equal((await store.events()).length,1);
 const other=makeStore();await other.import(await store.export());assert.deepEqual(await other.notes(),await store.notes());
});
test('untrusted note structure is rejected and HTML stays plain data',async()=>{
 for(const value of [null,[],JSON.parse('{"__proto__":"x"}'),{安:3},{'ab':'x'}]){
  if(value&&Object.keys(value).length===0)continue;assert.throws(()=>validateNotes(value));
 }
 const s=makeStore();await s.saveNote('安','<img src=x onerror=alert(1)>');assert.equal((await s.notes()).安,'<img src=x onerror=alert(1)>');
});
test('hint stages remain monotonic and never enter terminal events',async()=>{
 const s=makeStore(),e=event();await s.claimPending('device',e);
 let p=await s.patchPending('device',{hintStage:2},e.id);assert.equal(p.assisted,true);
 p=await s.patchPending('device',{hintStage:1,assisted:false},e.id);assert.equal(p.hintStage,2);assert.equal(p.assisted,true);
 await s.finish(e,'device');assert.equal((await s.events())[0].assisted,true);assert.equal('hintStage' in (await s.events())[0],false);
 assert.equal(hintStageOf({assisted:true}),3);
});
test('stale guided attempts become full assistance in both learn and review',async()=>{
 for(const mode of ['learn','review']){
  const s=makeStore(),old={...event(),kind:'practice',mode:'practice',grade:null,hintStage:0};await s.claimPending('d',old);await s.suspendPending('d');
  const resumed=await s.claimPending('d',{...event(),mode});assert.equal(resumed.hintStage,3);assert.equal(resumed.assisted,true);
 }
});
