import test from 'node:test';
import assert from 'node:assert/strict';
import { replay, ready, DAY, MINUTE, validateEvent, memoryStatus, planQueue } from '../js/review-scheduler.js';
let serial = 0;
const T = Date.UTC(2026, 9, 18, 8);
function ev(kind, at=T, extra={}) {
 const id = `00000000-0000-4000-8000-${String(++serial).padStart(12,'0')}`;
 return {id, attemptId:id, char:'一', kind, mode:kind==='practice'?'practice':'learn', dueKey:'', grade:kind==='answer'?'good':null, assisted:false, mistakes:0, at, day:new Date(at).toISOString().slice(0,10), device:'test-device', durationMs:0, version:1, ...extra};
}
const derive = (events) => replay(events)['一'];
test('legacy-free introduction is not remembered',()=>{
 const s=derive([ev('introduce')]); assert.equal(s.phase,'learning'); assert.equal(s.passes,0); assert.equal(memoryStatus(s),'Ещё не проверен');
});
test('two initial recalls are spaced, then 10m then 1d',()=>{
 const es=[ev('introduce'),ev('answer',T+1)];
 let s=derive(es); assert.equal(s.passes,1); assert.equal(ready(s,es,T+2),false);
 es.push(ev('answer',T+2,{char:'二'}),ev('answer',T+3,{char:'三'}));
 assert.equal(ready(s,es,T+4),true);
 es.push(ev('answer',T+4)); s=derive(es); assert.equal(s.phase,'review'); assert.equal(s.dueAt,T+4+10*MINUTE);
 es.push(ev('answer',s.dueAt,{mode:'review'})); s=derive(es); assert.equal(s.stage,1);assert.equal(s.dueAt,T+4+10*MINUTE+DAY);
});
test('small deck waits twice and early answers cannot advance',()=>{
 const es=[ev('introduce'),ev('answer',T+1),ev('answer',T+2)];
 assert.equal(derive(es).passes,1);
 es.push(ev('answer',T+1+10*MINUTE)); let s=derive(es);assert.equal(s.phase,'review');
 const due=s.dueAt;es.push(ev('answer',due-1,{mode:'review'}));assert.equal(derive(es).dueAt,due);
});
test('motor errors do not increase lapses or advance schedule',()=>{
 const es=[ev('introduce'),ev('answer',T+1),ev('answer',T+1+10*MINUTE)];
 let s=derive(es); const stage=s.stage;
 es.push(ev('answer',s.dueAt,{mode:'review',mistakes:2}));s=derive(es);
 assert.equal(s.dueAt,es.at(-1).at+10*MINUTE); assert.equal(s.stage,stage); assert.equal(s.lapses,0); assert.equal(s.successDays.length,0);
});
test('help/forget requires practice, preserves history, allows interleaved learning',()=>{
 const es=[ev('introduce'),ev('answer',T+1,{assisted:true})];
 assert.equal(derive(es).phase,'relearning');
 es.push(ev('answer',T+2));assert.equal(derive(es).phase,'relearning');
 es.push(ev('practice',T+3),ev('answer',T+4,{char:'二'}),ev('answer',T+5,{char:'三'}),ev('answer',T+6));
 assert.equal(derive(es).passes,1);assert.equal(derive(es).lapses,1);
});
test('duplicate and arrival order do not alter replay; concurrent lapse wins',()=>{
 const es=[ev('introduce'),ev('answer',T+1),ev('answer',T+1+10*MINUTE)];
 const due=derive(es).dueAt;
 es.push(ev('answer',due,{mode:'review',dueKey:'same',device:'A',grade:'again'}), ev('answer',due+MINUTE,{mode:'review',dueKey:'same',device:'B'}));
 assert.deepEqual(replay(es),replay([...es].reverse().concat(es[0])));
 assert.equal(derive(es).phase,'relearning');
});
test('stable memory requires distinct days spanning a week',()=>{
 const es=[ev('introduce'),ev('answer',T+1),ev('answer',T+1+10*MINUTE)];
 for(let i=0;i<5;i++){const s=derive(es); es.push(ev('answer',s.dueAt,{mode:'review'}));}
 assert.equal(memoryStatus(derive(es)),'Устойчиво помню');
 es.push(ev('answer',derive(es).dueAt,{mode:'review',grade:'again'}));
 assert.equal(memoryStatus(derive(es)),'Нужна отработка');
});
test('validation rejects future, malformed, unsafe fields and nonfinite values',()=>{
 assert.throws(()=>validateEvent(ev('answer',T+6*MINUTE),T));
 assert.throws(()=>validateEvent(ev('answer',T,{char:'<script>'}),T));
 assert.throws(()=>validateEvent(ev('answer',T,{mistakes:Infinity}),T));
 assert.throws(()=>validateEvent(ev('answer',T,{url:'https://example.com'}),T));
 assert.doesNotThrow(()=>validateEvent(ev('answer',T+4*MINUTE),T));
});

test('daily limit survives replay and due reviews outrank new signs',()=>{
 const rows=Array.from('一二三四五六七八九十').map((char,i)=>({char,level:'1-2',number:i}));
 const now=Date.now();const day=new Date(now);const dayKey=`${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;
 const es=rows.slice(0,5).map(r=>ev('introduce',now-1000,{char:r.char,day:dayKey}));
 const q=planQueue(rows,es,{now,limit:5,level:'1-2'});assert.equal(q.today,5);assert.equal(q.fresh.length,0);assert.equal(q.items[0].char,'一');
});

test('first guided practice opens recall; relearning practice requires a gap',()=>{
 const es=[ev('introduce'),ev('practice',T+1)];assert.equal(derive(es).dueAt,T+1);
 es.push(ev('answer',T+2,{grade:'again'}),ev('practice',T+3));assert.equal(derive(es).dueAt,T+3+10*MINUTE);
});
test('short motor retry does not promote stage or count as spaced success',()=>{
 const es=[ev('introduce'),ev('answer',T+1),ev('answer',T+1+10*MINUTE)];
 for(let i=0;i<3;i++)es.push(ev('answer',derive(es).dueAt,{mode:'review'}));
 const before=derive(es);es.push(ev('answer',before.dueAt,{mode:'review',mistakes:2}));
 es.push(ev('answer',derive(es).dueAt,{mode:'review'}));const after=derive(es);
 assert.equal(after.stage,before.stage);assert.deepEqual(after.successTimes,before.successTimes);
 assert.equal(after.dueAt,es.at(-1).at+DAY);assert.equal(after.motorRetry,false);
});
test('explicit new-only block bypasses due backlog but respects daily quota',()=>{
 const rows=Array.from('一二三四五六七八九十百千万上下左右大小中人天日月').map(char=>({char,level:'1-2'}));
 const now=Date.now();const es=rows.slice(0,20).map(r=>ev('introduce',now-2*DAY,{char:r.char,day:'2026-10-16'}));
 assert.equal(planQueue(rows,es,{now}).fresh.length,0);
 const q=planQueue(rows,es,{now,newOnly:true,limit:3});assert.equal(q.fresh.length,3);assert.equal(q.items.length,3);
});

test('guided relearning is not labelled successful until a clean recall',()=>{
 const es=[ev('introduce'),ev('answer',T+1,{grade:'again'}),ev('practice',T+2)];
 assert.equal(memoryStatus(derive(es)),'Нужна отработка');
 es.push(ev('answer',T+2+10*MINUTE));assert.equal(memoryStatus(derive(es)),'Получается');
});
test('30-day motor retry keeps interval stage and stability evidence unchanged',()=>{
 const es=[ev('introduce'),ev('answer',T+1),ev('answer',T+1+10*MINUTE)];
 for(let i=0;i<5;i++)es.push(ev('answer',derive(es).dueAt,{mode:'review'}));
 const before=derive(es);assert.equal(before.stage,5);
 es.push(ev('answer',before.dueAt,{mode:'review',mistakes:2}));assert.equal(derive(es).lapses,0);
 es.push(ev('answer',derive(es).dueAt,{mode:'review'}));assert.equal(derive(es).stage,5);assert.deepEqual(derive(es).successTimes,before.successTimes);
});
test('clock bound is inclusive and late concurrent lapse recomputes earlier good',()=>{
 assert.doesNotThrow(()=>validateEvent(ev('answer',T+5*MINUTE),T));assert.throws(()=>validateEvent(ev('answer',T+5*MINUTE+1),T));
 const es=[ev('introduce'),ev('answer',T+1),ev('answer',T+1+10*MINUTE)];const due=derive(es).dueAt;
 const good=ev('answer',due,{mode:'review',device:'A',dueKey:'same'}),bad=ev('answer',due+3*MINUTE,{mode:'review',device:'B',dueKey:'same',grade:'again'});
 assert.equal(derive([...es,good]).stage,1);
 assert.equal(derive([...es,good,bad]).phase,'relearning');assert.equal(derive([...es,good,bad]).successTimes.length,0);
 assert.deepEqual(replay([...es,good,bad]),replay([bad,good,...es]));
});
