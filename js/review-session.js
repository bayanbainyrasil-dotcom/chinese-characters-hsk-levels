import {ReviewStore} from './review-store.js';
import {planQueue, replay, localDay, memoryStatus, MINUTE} from './review-scheduler.js';
import {uuid, deviceId, readJson, KEYS} from './storage.js';
import {ReviewSync} from './review-sync.js';
import {mnemonicFor,hintStageOf} from './mnemonic-data.js';
import {renderMnemonic} from './mnemonic-panel.js';
import * as audio from './audio.js';
const $=id=>document.getElementById(id);
export const hideAnswer=(text,char)=>String(text??'').split(char).join('□');
const date=at=>new Date(at).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
export function createReviewSession({loadWriter,getClient,getUser}) {
  const store=new ReviewStore();
  const tab='device:'+deviceId(); // Stable across closed tabs; IndexedDB arbitrates simultaneous starts.
  let notes={},rows=[],events=[],settings={level:'1-2',limit:5},pending=null,writer=null,token=0,active=false,busy=false,complete=false,reopen=false;
  let block={count:0,failures:{},excluded:[],remembered:0,practice:0}; let started=0;
  const sync=new ReviewSync({store,getClient,getUser,onStatus:text=>{$('memorySyncState').textContent=text;}});
  function error(e){$('memoryMessage').textContent=e?.message||'Не удалось сохранить. Не закрывайте страницу';}
  // queue:true — действие не отбрасывается, а ждёт текущего (выбранный файл импорта не должен теряться молча).
  let idle=Promise.resolve();
  async function safe(action,{queue=false}={}){if(busy){if(!queue)return;while(busy)await idle;}busy=true;let release;idle=new Promise(r=>{release=r;});$('memoryStart').disabled=true;$('memoryNewOnly').disabled=true;$('memoryResume').disabled=true;try{await action();}catch(e){error(e);}finally{busy=false;release();$('memoryStart').disabled=false;$('memoryNewOnly').disabled=false;$('memoryResume').disabled=false;if(reopen&&active){reopen=false;await open();}}}
  let lastSize=0,boardObserver=null;
  function syncSize(){if(!writer||!active||!$('memoryBoard'))return;const size=Math.max(220,Math.min(360,$('memoryBoard').getBoundingClientRect().width));if(!size||Math.abs(size-lastSize)<2)return;lastSize=size;try{writer.updateDimensions?.({width:size,height:size,padding:Math.max(10,Math.round(size*.045))});}catch{}}
  function observeMemoryBoard(){const b=$('memoryBoard');if(!b||boardObserver||typeof ResizeObserver!=='function')return;boardObserver=new ResizeObserver(()=>syncSize());boardObserver.observe(b);}
  function stopWriter(){token++;try{writer?.cancelQuiz();}catch{}writer=null;complete=false;}
  function panel(name){for(const p of ['memoryDashboard','memoryExercise','memorySummary']) $(p).classList.toggle('hidden',p!==name);}
  async function refresh(){events=await store.events();}
  async function init(){
    if(rows.length)return;
    await store.migrate(readJson(KEYS.progress,null));
    const responses=await Promise.all([fetch('data/writing.json'),fetch('data/stroke-counts.json')]);
    if(responses.some(r=>!r.ok))throw new Error('Не загрузился набор знаков. Попробуйте ещё раз');
    const [data,counts]=await Promise.all(responses.map(r=>r.json()));
    rows=Object.entries(data.groups).flatMap(([level,list])=>list.map(r=>({...r,level,strokes:counts[r.char]??null}))).sort((a,b)=>(a.strokes??99)-(b.strokes??99)||a.number-b.number);
    notes=await store.notes();
    settings=await store.get('settings',settings); if(!['1-2','3','4','5','6','7-9'].includes(settings.level))settings.level='1-2';
    if(![3,5,10].includes(settings.limit))settings.limit=5;
    $('memoryLevel').value=settings.level;$('memoryLimit').value=settings.limit;
  }
  async function dashboard(){
    stopWriter();pending=null;panel('memoryDashboard');await refresh();
    const q=planQueue(rows,events,settings),cards=Object.values(q.cards);
    $('memoryDue').textContent=q.due.length;
    $('memoryNew').textContent=q.fresh.length;
    $('memoryStable').textContent=cards.filter(c=>memoryStatus(c)==='Устойчиво помню').length;
    const attempts=events.filter(e=>e.kind!=='introduce');
    $('memoryHistoryStats').textContent=`Попыток: ${attempts.length} · Дней занятий: ${new Set(attempts.map(e=>e.day)).size} · Ответов без помощи и заметных промахов: ${attempts.filter(e=>e.kind==='answer'&&e.grade==='good'&&!e.assisted&&e.mistakes<2).length}. Это история упражнений, а не число выученных знаков.`;
    $('memoryLearning').textContent=cards.filter(c=>c.phase!=='review').length;
    const next=cards.filter(c=>c.dueAt>Date.now()).sort((a,b)=>a.dueAt-b.dueAt)[0];
    $('memoryNextDue').textContent=next?`Ближайшая проверка: ${date(next.dueAt)}.`:'Начни с небольшой группы. Новые знаки появляются постепенно.';
    $('memoryResume').classList.toggle('hidden',!(await store.pending(tab)));
    $('memoryMessage').textContent='';
  }
  async function open(){active=true;if(busy){reopen=true;panel('memoryDashboard');return;}reopen=false;await safe(async()=>{await init();await dashboard();});}
  function leave(){active=false;stopWriter();}
  function makeEvent(kind,char,extra={}){const id=uuid(),at=Date.now();return {id,attemptId:id,char,kind,mode:kind==='practice'?'practice':'learn',dueKey:'',grade:null,assisted:false,mistakes:0,at,day:localDay(at),device:deviceId(),durationMs:0,version:1,...extra};}
  async function begin(row,card){
    const legacy=readJson(KEYS.progress,{})?.completed?.hsk||{};
    const previouslyPracticed=Object.entries(legacy).some(([key,count])=>key.endsWith(':'+row.char)&&Number(count)>0);
    const mode=card?.phase==='relearning'||(!card?.practiced&&!card?.attempts&&!previouslyPracticed)?'practice':card?.phase==='review'?'review':'learn';
    pending={...makeEvent(mode==='practice'?'practice':'answer',row.char,{mode,dueKey:mode==='review'?`${row.char}:${card.stage}:${card.dueAt}`:''}),grade:mode==='practice'?null:'good'};
    pending=await store.claimPending(tab,pending);await render();
  }
  async function next(){
    stopWriter();await refresh();
    pending=await store.pending(tab);if(pending){await begin(rows.find(r=>r.char===pending.char),replay(events)[pending.char]);return;}
    if(block.count>=20){await summary();return;}
    const q=planQueue(rows,events,{...settings,excluded:block.excluded,newOnly:block.newOnly});const row=q.items[0];
    if(!row){await summary();return;}
    let card=q.cards[row.char];
    if(!card){await store.finish(makeEvent('introduce',row.char));await refresh();card=replay(events)[row.char];}
    await begin(row,card);
  }
  async function start(newOnly=false){await safe(async()=>{block={count:0,failures:{},excluded:[],remembered:0,practice:0,newOnly};await store.set('block:'+tab,block);await next();});}
  async function resume(){await safe(async()=>{
    block=await store.get('block:'+tab,block);await next();
  });}
  function showMnemonic(char,stage){
    renderMnemonic($('memoryMnemonic'),{char,stage,note:notes[char]||'',onSave:(target,text)=>safe(async()=>{
      notes=await store.saveNote(target,text);$('memoryMessage').textContent='Личная история сохранена на этом устройстве.';
    })});
  }
  function setHintButtons(disabled=false){
    const entry=pending&&mnemonicFor(pending.char);
    const story=entry?.story||(pending&&notes[pending.char]);
    $('memoryStoryHint').disabled=disabled||!story||hintStageOf(pending)>=1;
    $('memoryPartsHint').disabled=disabled||!entry||hintStageOf(pending)>=2;
  }
  function reveal(row){
    $('memoryAnswer').textContent=row.char;$('memoryAnswer').classList.remove('hidden');
    $('memoryExample').textContent=(row.examples||[]).slice(0,2).map(e=>`${e[0]} · ${e[1]} · ${e[2]}`).join(' / ');
    $('memoryExample').classList.remove('hidden');showMnemonic(row.char,3);
  }
  async function render(){
    stopWriter();const myToken=token;const row=rows.find(r=>r.char===pending.char);if(!row)throw new Error('Знак не найден в учебном наборе');
    const practice=pending.mode==='practice';panel('memoryExercise');
    $('memoryPhase').textContent=practice?'1 · Разбери и отработай':pending.mode==='review'?'3 · Проверка через время':'2 · Вспомни написание';
    $('memoryCue').textContent=hideAnswer(`${row.pinyin} · ${row.meaning}`,row.char);
    const example=(row.examples||[]).find(e=>e[0].length>1);
    $('memoryContext').textContent=example?hideAnswer(`В слове: ${example[0]} · ${example[1]} · ${example[2]}`,row.char):'Напиши знак по чтению и значению.';
    $('memoryAnswer').textContent='';$('memoryAnswer').classList.add('hidden');$('memoryExample').textContent='';$('memoryExample').classList.add('hidden');
    $('memoryShape').textContent=`${row.strokes??'—'} ${row.strokes%10===1&&row.strokes%100!==11?'черта':row.strokes%10>=2&&row.strokes%10<=4&&!(row.strokes%100>=12&&row.strokes%100<=14)?'черты':'черт'} · HSK ${row.level}. Число черт — сложность формы, не оценка памяти.`;
    $('memoryFeedback').textContent=practice?'Смотри образец и порядок черт, затем напиши.':`Пиши без образца. ${pending.mistakes?`Сохранено промахов: ${pending.mistakes}.`:''}`;
    $('memoryGrade').classList.add('hidden');$('memoryNext').classList.add('hidden');$('memoryControls').classList.remove('hidden');
    $('memoryHelp').disabled=true;$('memoryRetry').disabled=true;$('memoryForgot').disabled=true;setHintButtons(true);
    $('memoryHelp').textContent=practice?'▶ Порядок черт':'Показать и разобрать';
    $('memoryForgot').classList.toggle('hidden',practice);
    const stage=practice?3:hintStageOf(pending);showMnemonic(row.char,stage);
    if(stage>=3)reveal(row);
    $('memoryTarget').replaceChildren();$('memoryLoading').classList.remove('hidden');$('memoryLoading').textContent='Загрузка поля…';
    started=Date.now();
    const Writer=await loadWriter();if(myToken!==token||!active)return;
    const size=Math.max(220,Math.min(360,$('memoryBoard').getBoundingClientRect().width));lastSize=size;
    writer=Writer.create($('memoryTarget'),row.char,{
      width:size,height:size,padding:Math.max(10,Math.round(size*.045)),showCharacter:false,showOutline:stage>=3,
      showHintAfterMisses:false,highlightOnComplete:false,strokeColor:'#232323',outlineColor:'#d4cbbb',drawingColor:'#be482f',
      onLoadCharDataSuccess:()=>{queueMicrotask(()=>{if(myToken!==token||!active)return;
        $('memoryLoading').classList.add('hidden');$('memoryHelp').disabled=false;$('memoryRetry').disabled=false;$('memoryForgot').disabled=false;setHintButtons(practice);
        if(practice)animate(myToken);else quiz(myToken);
      });},
      onLoadCharDataError:()=>{if(myToken!==token)return;$('memoryLoading').textContent='Нет данных о чертах. Пропусти без штрафа или попробуй позже.';},
    });
  }
  function quiz(myToken){
    if(!writer||myToken!==token||!active)return;
    writer.quiz({showHintAfterMisses:false,onMistake:()=>{
      if(myToken!==token||complete||!pending)return;
      pending.mistakes=Math.min(10000,pending.mistakes+1);
      store.patchPending(tab,{mistakes:pending.mistakes},pending.id).catch(error);
      $('memoryFeedback').textContent=`Промахов пера: ${pending.mistakes}. Можно попросить образец.`;
    },onComplete:()=>{
      if(myToken!==token||complete||!pending)return;complete=true;
      $('memoryGrade').classList.remove('hidden');$('memoryHelp').disabled=true;$('memoryRetry').disabled=true;$('memoryForgot').disabled=true;setHintButtons(true);
      $('memoryGood').textContent=pending.mode==='practice'?'Готово, проверим без образца':'Вспомнил сам';
      $('memoryAgain').classList.toggle('hidden',pending.mode==='practice');
      $('memoryGood').disabled=pending.mode!=='practice'&&pending.assisted;
      $('memoryFeedback').textContent=pending.mode==='practice'?'Движение отработано. Теперь дадим памяти небольшую паузу.':pending.assisted?'Была подсказка — это тренировка. Вернёмся к отработке, самостоятельный успех не засчитан.':pending.mistakes>=2?'Есть несколько промахов: сохраним тренировку и перепроверим, не увеличивая интервал.':'Получилось. Вспомнил форму сам?';
    }});
  }
  function animate(myToken){
    if(!writer||myToken!==token)return;writer.cancelQuiz();
    $('memoryHelp').disabled=true;$('memoryRetry').disabled=true;
    writer.animateCharacter({onComplete:()=>{if(myToken!==token||!active)return;writer.hideCharacter();$('memoryHelp').disabled=false;$('memoryRetry').disabled=false;quiz(myToken);}});
  }
  async function hint(stage){await safe(async()=>{
    if(!pending||complete||!writer||!active)return;
    const myToken=token,attempt=pending.id,char=pending.char;
    const saved=await store.patchPending(tab,{assisted:true,hintStage:stage},attempt);
    if(!active||token!==myToken||pending?.id!==attempt)return;
    pending={...saved,mistakes:Math.max(saved.mistakes||0,pending.mistakes||0)};
    if(complete){
      $('memoryGood').disabled=true;setHintButtons(true);
      $('memoryFeedback').textContent='Была запрошена подсказка — это тренировка. Повторим без помощи позже.';
      return;
    }
    const actual=hintStageOf(saved);showMnemonic(char,actual);setHintButtons();
    $('memoryFeedback').textContent='Подсказка открыта. Эта попытка станет тренировкой; позже проверим без помощи.';
    if(actual>=3){reveal(rows.find(r=>r.char===char));writer.showOutline();animate(token);}
  });}
  async function help(){
    if(pending?.mode==='practice'){await safe(async()=>{if(writer&&!complete)animate(token);});}
    else await hint(3);
  }
  async function grade(value){await safe(async()=>{
    if(!pending||(!complete && value!=='again'))return;
    const at=Date.now();const {hintStage:ignoredStage,...terminal}=pending;const event={...terminal,at,day:localDay(at),durationMs:Math.min(86400000,pending.durationMs+Math.max(0,at-started)),grade:pending.mode==='practice'?null:value};
    if(!(await store.finish(event,tab))){await dashboard();return;}
    block.count++;
    if(event.kind==='practice')block.practice++;
    else if(value==='again'||event.assisted){block.failures[event.char]=(block.failures[event.char]||0)+1;if(block.failures[event.char]>=3)block.excluded.push(event.char);}
    else if(event.mistakes<2)block.remembered++;
    await store.set('block:'+tab,block);await refresh();const card=replay(events)[event.char];
    stopWriter();$('memoryTarget').replaceChildren();reveal(rows.find(r=>r.char===event.char));
    $('memoryGrade').classList.add('hidden');$('memoryControls').classList.add('hidden');$('memoryLoading').classList.add('hidden');
    $('memoryFeedback').textContent=block.excluded.includes(event.char)?'Три трудные попытки — сделаем паузу. Знак сохранён для следующего занятия.':card.phase==='relearning'?'Вернёмся к образцу и порядку черт. История сохранена.':`${memoryStatus(card)}. Следующая проверка: ${date(card.dueAt)}${card.phase==='learning'?' или после двух других знаков':''}.`;
    $('memoryNext').textContent=card.phase==='relearning'&&!block.excluded.includes(event.char)?'Разобрать и отработать':'Дальше';$('memoryNext').classList.remove('hidden');pending=null;sync.flush();
  });}
  async function skip(){await safe(async()=>{if(!pending)return;block.excluded.push(pending.char);await store.suspendPending(tab,pending.id);await store.set('block:'+tab,block);pending=null;await next();});}
  async function summary(){
    stopWriter();pending=null;panel('memorySummary');const cards=Object.values(replay(events));
    $('memorySummaryText').textContent=`Самостоятельных ответов в этом блоке: ${block.remembered}. Отработок с образцом: ${block.practice}. Готовы к повторению ещё: ${planQueue(rows,events,settings).due.length}. Остальная очередь сохранена.`;
    const next=cards.filter(c=>!block.excluded.includes(c.char)).sort((a,b)=>a.dueAt-b.dueAt)[0];
    $('memorySummaryDue').textContent=next?`Ближайшее повторение: ${date(next.dueAt)}. Можно вернуться позже; ждать на этом экране не нужно.`:'На сегодня блок завершён. Можно вернуться позже.';
  }
  $('memoryStart').onclick=()=>start();$('memoryNewOnly').onclick=()=>start(true);$('memoryResume').onclick=resume;
  $('memoryStoryHint').onclick=()=>hint(1);$('memoryPartsHint').onclick=()=>hint(2);
  $('memoryHelp').onclick=help;$('memoryGood').onclick=()=>grade('good');$('memoryAgain').onclick=()=>grade('again');$('memoryForgot').onclick=()=>grade('again');
  $('memoryNext').onclick=()=>safe(next);$('memoryRetry').onclick=()=>safe(async()=>{if(pending&&!complete)await render();});
  $('memorySkip').onclick=skip;$('memoryPause').onclick=()=>safe(dashboard);$('memorySummaryBack').onclick=()=>safe(dashboard);$('memoryContinue').onclick=()=>start();
  for(const id of ['memoryLevel','memoryLimit'])$(id).onchange=()=>safe(async()=>{settings={level:$('memoryLevel').value,limit:Number($('memoryLimit').value)};await store.set('settings',settings);await dashboard();});
  async function downloadBackup(){const blob=new Blob([JSON.stringify(await store.export(),null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`hanzi-memory-${localDay()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  $('memoryExport').onclick=()=>safe(downloadBackup);
  $('memoryImport').onchange=()=>safe(async()=>{try{
    const file=$('memoryImport').files[0];if(!file)return;if(file.size>10*1024*1024)throw new Error('Файл больше 10 МБ');
    const data=JSON.parse(await file.text());const es=store.validateImport(data);
    if(!confirm(`Добавить ${es.length} попыток из копии? Текущая история останется.`))return;
    await store.import(data);notes=await store.notes();await dashboard();$('memoryMessage').textContent='История объединена. Расписание пересчитано.';sync.flush();
  }finally{$('memoryImport').value='';}},{queue:true});
  $('memoryRebind').onclick=()=>safe(async()=>{
    const user=getUser();if(!user)throw new Error('Сначала войдите в аккаунт в настройках сайта');
    const owner=await store.get('sync-owner');
    if(owner===user.id){await sync.flush();return;}
    if(!confirm(`Связать всю историю памяти на этом устройстве с аккаунтом ${user.email||user.id}? Она будет отправлена в этот аккаунт. Перед этим скачается копия. Данные прежнего аккаунта останутся на сервере.`))return;
    await downloadBackup();await sync.bind({replace:true,expectedOwner:owner});await sync.flush();
  });
  $('memorySync').onclick=()=>safe(async()=>{await sync.bind();await sync.flush();await refresh();});
  $('memorySpeak').onclick=()=>{if(pending){audio.unlockAudio();audio.speak(pending.char);}};
  window.addEventListener('online',()=>sync.flush());document.addEventListener('visibilitychange',()=>{if(!document.hidden){started=Date.now();sync.flush();}});
  observeMemoryBoard();window.addEventListener('resize',syncSize);window.addEventListener('orientationchange',()=>setTimeout(syncSize,160));
  return {open,leave,store,sync,get pending(){return pending;},get events(){return events;}};
}
