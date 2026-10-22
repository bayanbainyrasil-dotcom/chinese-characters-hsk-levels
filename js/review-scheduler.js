// Memory is derived from an immutable journal, never from the old five-write counter.
export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const LEARN_DELAY = 10 * MINUTE;
export const INTERVALS = [DAY, 3*DAY, 7*DAY, 14*DAY, 30*DAY, 30*DAY];
const FIELDS = ['id','attemptId','char','kind','mode','dueKey','grade','assisted','mistakes','at','day','device','durationMs','version'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validateEvent(raw, now=Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k=>!FIELDS.includes(k))) throw new Error('Неверный формат попытки');
  if (!UUID.test(raw.id) || raw.id !== raw.attemptId || !/^[\u3400-\u4dbf\u4e00-\u9fff]$/.test(raw.char)) throw new Error('Неверный знак или номер попытки');
  if (!['introduce','practice','answer'].includes(raw.kind) || !['learn','review','practice'].includes(raw.mode)) throw new Error('Неизвестный тип попытки');
  if (!['good','again',null].includes(raw.grade) || (raw.kind==='answer') !== (raw.grade!==null) || typeof raw.assisted!=='boolean' || raw.version!==1) throw new Error('Неверная оценка');
  for (const [k,max] of [['mistakes',10000],['durationMs',DAY]]) if (!Number.isInteger(raw[k]) || raw[k]<0 || raw[k]>max) throw new Error('Неверные показатели попытки');
  if (!Number.isSafeInteger(raw.at) || raw.at<Date.UTC(2020,0,1) || raw.at>now+5*MINUTE) throw new Error('Дата попытки в будущем. Проверьте часы устройства');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.day) || typeof raw.device!=='string' || !raw.device.length || raw.device.length>100 || typeof raw.dueKey!=='string' || raw.dueKey.length>150) throw new Error('Неверные метаданные');
  return Object.fromEntries(FIELDS.map(k=>[k,raw[k]]));
}
export function localDay(at=Date.now()) {
  const d=new Date(at); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
export function isLapse(e) {return e.kind==='answer' && (e.assisted || e.grade==='again');}
export function ready(card, events, now) {
  if (card.dueAt<=now || card.phase==='relearning') return true;
  if (card.phase!=='learning') return false;
  const others=new Set();
  for(let i=events.length-1;i>=0;i--){const e=events[i];if(e.at>card.anchorAt && e.at<=now && e.char!==card.char && e.kind!=='introduce')others.add(e.char);if(others.size>=2)return true;}
  return false;
}
function blank(e) {
  return {char:e.char, introducedAt:e.at, introducedDay:e.day, phase:'learning', passes:0, stage:0, dueAt:e.at, anchorAt:e.at, lapses:0, attempts:0, successDays:[], successTimes:[], lastResult:null, practiced:false, motorRetry:false};
}
export function replay(input) {
  const events=[...new Map(input.map(e=>[e.id,e])).values()].sort((a,b)=>a.at-b.at || a.id.localeCompare(b.id));
  const cards={}; const history=[]; const failures=new Map();
  for(const e of events) if(isLapse(e) && e.mode==='review' && e.dueKey) {
    const key=e.char+'|'+e.dueKey; const list=failures.get(key)||[]; list.push(e); failures.set(key,list);
  }
  for(const e of events) {
    const c=cards[e.char] ||= blank(e);
    if(e.kind==='introduce') { history.push(e); continue; }
    if(e.kind==='practice') {
      const first=!c.practiced && c.attempts===0;
      if(c.phase==='relearning' || c.phase==='learning') Object.assign(c,{phase:'learning',passes:0,anchorAt:e.at,dueAt:e.at+(first?0:LEARN_DELAY),motorRetry:false});
      c.practiced=true;
      history.push(e);continue;
    }
    c.attempts++; c.lastResult=e.grade;
    if(isLapse(e)) {
      Object.assign(c,{phase:'relearning',passes:0,stage:0,dueAt:e.at+LEARN_DELAY,anchorAt:e.at,successDays:[],successTimes:[],motorRetry:false}); c.lapses++;
    } else if(e.mistakes>=2) {
      c.dueAt=e.at+LEARN_DELAY; c.anchorAt=e.at; c.lastResult='motor'; c.motorRetry=c.phase==='review';
    } else {
      const conflict=(failures.get(e.char+'|'+e.dueKey)||[]).some(f=>e.mode==='review' && f.device!==e.device && Math.abs(f.at-e.at)<=5*MINUTE);
      if(!conflict && c.phase==='learning' && ready(c,history,e.at)) {
        c.passes++; c.anchorAt=e.at; c.dueAt=e.at+LEARN_DELAY;
        if(c.passes>=2) {c.phase='review';c.stage=0;}
      } else if(!conflict && c.phase==='review' && e.at>=c.dueAt) {
        // A short retry after recognition feedback is practice, not a spaced success.
        if(c.motorRetry){c.motorRetry=false;c.dueAt=e.at+DAY;history.push(e);continue;}
        if(!c.successDays.includes(e.day) && (!c.successTimes.length || e.at-c.successTimes.at(-1)>=DAY)) {
          c.successDays.push(e.day);c.successTimes.push(e.at);
        }
        c.dueAt=e.at+INTERVALS[Math.min(c.stage,INTERVALS.length-1)]; c.stage=Math.min(c.stage+1,INTERVALS.length);
      }
    }
    history.push(e);
  }
  return cards;
}
export function memoryStatus(c) {
  if(!c || !c.attempts) return 'Ещё не проверен';
  if(c.phase==='relearning') return 'Нужна отработка';
  if(c.successTimes.length>=3 && c.successTimes.at(-1)-c.successTimes[0]>=7*DAY) return 'Устойчиво помню';
  if(c.lastResult==='motor')return 'Отработать движение';
  return c.lastResult==='good'||c.passes>0||c.phase==='review'?'Получается':'Нужна отработка';
}
export function planQueue(rows, events, {now=Date.now(),limit=5,level='1-2',excluded=[],newOnly=false}={}) {
  const cards=replay(events); const used=new Set(excluded);
  const due=rows.filter(r=>cards[r.char] && !used.has(r.char) && ready(cards[r.char],events,now)).sort((a,b)=>cards[a.char].dueAt-cards[b.char].dueAt);
  const today=Object.values(cards).filter(c=>c.introducedDay===localDay(now)).length;
  const fresh=due.length>=20&&!newOnly?[]:rows.filter(r=>r.level===level && !cards[r.char] && !used.has(r.char)).slice(0,Math.max(0,limit-today));
  return {cards,due,fresh,today,items:(newOnly?[...due.filter(r=>cards[r.char].introducedDay===localDay(now)),...fresh]:[...due,...fresh]).slice(0,20)};
}
