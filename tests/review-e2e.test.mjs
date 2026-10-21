import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {startServer,launch,serveStrokeData,stubBackend,drawCharacter,collectErrors,LEGACY_PROGRESS} from './helpers.mjs';
let server,base,browser;
before(async()=>{({server,url:base}=await startServer());browser=await launch();});
after(async()=>{await browser?.close();server?.close();});
async function open(viewport={width:390,height:844}){
 const context=await browser.newContext({viewport,hasTouch:true});await serveStrokeData(context);await stubBackend(context);
 const page=await context.newPage(),errors=collectErrors(page);
 await page.addInitScript(progress=>{if(!localStorage.getItem('bishun_hsk30_progress_v1'))localStorage.setItem('bishun_hsk30_progress_v1',JSON.stringify(progress));},LEGACY_PROGRESS);
 await page.goto(base);await page.waitForFunction(()=>window.__hsk);await page.locator('#memoryOpen').click();await page.locator('#memoryStart').waitFor();
 await page.waitForFunction(()=>document.querySelector('#memoryNew').textContent==='5');
 return {context,page,errors};
}
async function start(page){await page.locator('#memoryStart').click();await page.locator('#memoryHelp:not([disabled])').waitFor();
 if(await page.evaluate(()=>window.__hsk.memory.pending.mode==='practice')){await finish(page);await page.locator('#memoryGood').click();await page.locator('#memoryNext').click();await page.locator('#memoryHelp:not([disabled])').waitFor();}
}
async function current(page){return page.evaluate(()=>window.__hsk.memory.pending.char);}
async function finish(page){await drawCharacter(page,await current(page),'#memoryTarget');await page.locator('#memoryGrade:not(.hidden)').waitFor();}
async function readEvents(page){return page.evaluate(()=>window.__hsk.memory.store.events());}
test('mobile and desktop memory entry has no overflow and hides all answer text',async()=>{
 for(const viewport of [{width:390,height:844},{width:1280,height:900}]){
  const {context,page,errors}=await open(viewport);await start(page);const char=await current(page);
  const content=await page.locator('#memoryExercise').evaluate(el=>({text:el.innerText,aria:[...el.querySelectorAll('[aria-label]')].map(n=>n.getAttribute('aria-label')).join(' ')}));
  assert.ok(!content.text.includes(char),`answer leaked: ${content.text}`);assert.ok(!content.aria.includes(char));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  // HW keeps outline paths in the SVG but they are transparent.
  const visiblePaths=await page.locator('#memoryTarget path').evaluateAll(paths=>paths.filter(p=>{if(p.closest('defs'))return false;let opacity=1;for(let n=p;n&&n.tagName!=='svg';n=n.parentElement)opacity*=Number(getComputedStyle(n).opacity);return opacity>0;}).length);
  assert.equal(visiblePaths,0);assert.deepEqual(errors,[]);
  await context.close();
 }
});
test('two clean writes interleaved with other characters, saved across reload; legacy unchanged',async()=>{
 const {context,page,errors}=await open();await start(page);const char=await current(page);
 await finish(page);await page.locator('#memoryGood').click();await page.locator('#memoryNext').waitFor();
 let es=await readEvents(page);assert.equal(es.filter(e=>e.kind==='answer').length,1);
 assert.equal(es.find(e=>e.kind==='answer').assisted,false);
 assert.deepEqual(await page.evaluate(()=>window.__hsk.progress.completed),LEGACY_PROGRESS.completed);
 await page.locator('#memoryNext').click();await page.locator('#memoryHelp:not([disabled])').waitFor();assert.notEqual(await current(page),char);
 await page.reload();await page.waitForFunction(()=>window.__hsk);await page.locator('#memoryOpen').click();await page.locator('#memoryResume').click();await page.locator('#memoryHelp:not([disabled])').waitFor();
 assert.equal((await readEvents(page)).filter(e=>e.kind==='answer').length,1);assert.equal(await page.evaluate(()=>window.__hsk.memory.pending.assisted),false);assert.deepEqual(errors,[]);
 await context.close();
});
test('forgetting leads to guided practice; hint survives reload and cannot count as clean',async()=>{
 const {context,page}=await open();await start(page);const char=await current(page);
 await page.locator('#memoryHelp').click();await page.locator('#memoryAnswer:not(.hidden)').waitFor();
 await page.reload();await page.waitForFunction(()=>window.__hsk);await page.locator('#memoryOpen').click();await page.locator('#memoryResume').click();await page.locator('#memoryHelp:not([disabled])').waitFor();
 assert.equal(await page.locator('#memoryAnswer').textContent(),char);
 await finish(page);assert.equal(await page.locator('#memoryGood').isDisabled(),true);
 await page.locator('#memoryAgain').click();await page.locator('#memoryNext').click();await page.locator('#memoryHelp:not([disabled])').waitFor();
 assert.equal(await page.evaluate(()=>window.__hsk.memory.pending.mode),'practice');assert.equal(await current(page),char);
 await finish(page);await page.locator('#memoryGood').click();await page.locator('#memoryNext').waitFor();
 const events=await readEvents(page);assert.equal(events.filter(e=>e.kind==='answer'&&e.assisted).length,1);assert.equal(events.filter(e=>e.kind==='practice').length,2);
 await context.close();
});
test('skip and leaving do not create a failed answer',async()=>{
 const {context,page}=await open();await start(page);
 await page.locator('#memorySkip').click();await page.locator('#memoryHelp:not([disabled])').waitFor();
 assert.equal((await readEvents(page)).filter(e=>e.kind==='answer').length,0);
 await page.locator('#memoryView [data-back-home]').click();await page.waitForTimeout(100);
 assert.equal((await readEvents(page)).filter(e=>e.kind==='answer').length,0);
 await context.close();
});
test('copy export includes memory separately; import rejects malformed file without replacing history',async()=>{
 const {context,page}=await open();await start(page);await finish(page);await page.locator('#memoryGood').click();await page.locator('#memoryPause').click();
 const before=await readEvents(page);const dl=page.waitForEvent('download');await page.locator('#memoryExport').click();const download=await dl;assert.match(download.suggestedFilename(),/hanzi-memory/);
 await page.locator('#memoryImport').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{"schema":"wrong"}')});
 await page.waitForFunction(()=>document.querySelector('#memoryMessage').textContent.includes('копия'));
 assert.deepEqual(await readEvents(page),before);await context.close();
});

test('missing stroke data is a technical skip without lapse',async()=>{
 const {context,page}=await open();
 await context.route('**/hanzi-writer-data*/**',route=>route.fulfill({status:404,body:'{}'}));
 await page.locator('#memoryStart').click();await page.waitForFunction(()=>document.querySelector('#memoryLoading').textContent.includes('Нет данных'));
 assert.equal((await readEvents(page)).filter(e=>e.kind==='answer').length,0);
 assert.equal(await page.locator('#memoryForgot').isDisabled(),true);await page.locator('#memoryPause').click();await context.close();
});
test('two motor misses are persisted even if canvas is cleared',async()=>{
 const {context,page}=await open();await start(page);
 const box=await page.locator('#memoryTarget').boundingBox();
 for(let i=0;i<2;i++){await page.mouse.move(box.x+30,box.y+10);await page.mouse.down();await page.mouse.move(box.x+30,box.y+160,{steps:6});await page.mouse.up();}
 await page.waitForFunction(()=>window.__hsk.memory.pending.mistakes>=2);
 await page.locator('#memoryRetry').click();await page.locator('#memoryHelp:not([disabled])').waitFor();
 await finish(page);await page.locator('#memoryGood').click();await page.locator('#memoryNext').waitFor();
 const answer=(await readEvents(page)).find(e=>e.kind==='answer');assert.ok(answer.mistakes>=2);assert.equal(answer.grade,'good');assert.equal(answer.assisted,false);
 await context.close();
});
test('storage failure is visible and does not falsely complete a review',async()=>{
 const {context,page}=await open();await start(page);await finish(page);
 await page.evaluate(()=>{window.__hsk.memory.store.finish=async()=>{throw new Error('Нет места: запись не сохранена');};});
 await page.locator('#memoryGood').click();await page.waitForFunction(()=>document.querySelector('#memoryMessage').textContent.includes('не сохранена'));
 assert.equal((await readEvents(page)).filter(e=>e.kind==='answer').length,0);assert.equal(await page.locator('#memoryNext').isVisible(),false);await context.close();
});

test('new character first teaches writing; all six level choices are available',async()=>{
 const {context,page}=await open();
 assert.deepEqual(await page.locator('#memoryLevel option').evaluateAll(es=>es.map(e=>e.value)),['1-2','3','4','5','6','7-9']);
 await page.locator('#memoryStart').click();await page.locator('#memoryHelp:not([disabled])').waitFor();
 assert.equal(await page.evaluate(()=>window.__hsk.memory.pending.mode),'practice');
 assert.equal(await page.locator('#memoryAnswer').textContent(),await current(page));
 await context.close();
});
test('help survives closed tab, normal start, skip, and next block',async()=>{
 const {context,page}=await open();await start(page);const char=await current(page);
 await page.locator('#memoryHelp').click();await page.locator('#memoryAnswer:not(.hidden)').waitFor();
 await page.close();const reopened=await context.newPage();await reopened.goto(base);await reopened.waitForFunction(()=>window.__hsk);
 await reopened.locator('#memoryOpen').click();await reopened.locator('#memoryStart').click();await reopened.locator('#memoryHelp:not([disabled])').waitFor();
 assert.equal(await current(reopened),char);assert.equal(await reopened.evaluate(()=>window.__hsk.memory.pending.assisted),true);
 await reopened.locator('#memorySkip').click();await reopened.waitForFunction(c=>window.__hsk.memory.pending?.char!==c,char);await reopened.locator('#memoryHelp:not([disabled])').waitFor();
 assert.notEqual(await current(reopened),char);
 // Skip each other sign without grading, then start a new block.
 for(let i=0;i<4;i++){const previous=await current(reopened);await reopened.locator('#memorySkip').click();await reopened.waitForFunction(c=>window.__hsk.memory.pending?.char!==c,previous);if(i<3)await reopened.locator('#memoryHelp:not([disabled])').waitFor();}
 await reopened.locator('#memorySummaryBack').click();await reopened.locator('#memoryStart').click();await reopened.locator('#memoryHelp:not([disabled])').waitFor();
 assert.equal(await current(reopened),char);assert.equal(await reopened.evaluate(()=>window.__hsk.memory.pending.assisted),true);
 assert.equal((await readEvents(reopened)).filter(e=>e.kind==='answer').length,0);
 await context.close();
});
test('dictionary cues never disclose the target, including translations',async()=>{
 const {context,page}=await open();
 const leaks=await page.evaluate(async()=>{
  const {hideAnswer}=await import('./js/review-session.js');const data=await (await fetch('data/writing.json')).json();
  return Object.values(data.groups).flat().filter(r=>hideAnswer(`${r.pinyin} · ${r.meaning} · ${(r.examples||[]).flat().join(' ')}`,r.char).includes(r.char)).map(r=>r.char);
 });
 assert.deepEqual(leaks,[]);await context.close();
});

test('legacy-practiced sign starts with diagnostic recall without gaining memory credit',async()=>{
 const {context,page}=await open();
 await page.evaluate(()=>{const key='bishun_hsk30_progress_v1';const old=JSON.parse(localStorage.getItem(key));old.completed.hsk['1-2:一']=5;localStorage.setItem(key,JSON.stringify(old));});
 await page.locator('#memoryStart').click();await page.locator('#memoryHelp:not([disabled])').waitFor();
 assert.equal(await current(page),'一');assert.equal(await page.evaluate(()=>window.__hsk.memory.pending.mode),'learn');
 assert.equal(await page.locator('#memoryAnswer').isVisible(),false);
 assert.equal((await readEvents(page)).filter(e=>e.kind==='answer').length,0);
 await finish(page);await page.locator('#memoryGood').click();await page.locator('#memoryNext').waitFor();
 assert.equal((await readEvents(page)).filter(e=>e.kind==='practice').length,0);
 assert.equal((await readEvents(page)).filter(e=>e.kind==='answer').length,1);await context.close();
});
