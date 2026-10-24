import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {startServer,launch,serveStrokeData,stubBackend,drawCharacter} from './helpers.mjs';
let browser,server,base;
before(async()=>{({server,url:base}=await startServer());browser=await launch();});
after(async()=>{await browser?.close();server?.close();});
async function open(char='安',known=true,width=390){
 const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});await serveStrokeData(context);await stubBackend(context);
 const data=JSON.parse(fs.readFileSync(new URL('../data/writing.json',import.meta.url)));const row=Object.values(data.groups).flat().find(r=>r.char===char);
 await context.route('**/data/writing.json',r=>r.fulfill({json:{...data,groups:{'1-2':[row]}}}));
 const page=await context.newPage();if(known)await page.addInitScript(c=>localStorage.setItem('bishun_hsk30_progress_v1',JSON.stringify({completed:{hsk:{['1-2:'+c]:5}}})),char);
 await page.goto(base);await page.waitForFunction(()=>window.__hsk);await page.locator('#memoryOpen').click();await page.locator('#memoryStart').click();await page.locator('#memoryHelp:not([disabled])').waitFor();return {context,page};
}
async function partial(page,stage){
 assert.equal(await page.locator('#memoryAnswer').isVisible(),false);
 assert.equal(await page.evaluate(()=>window.__hsk.memory.pending.hintStage),stage);
 const paths=await page.locator('#memoryTarget path').evaluateAll(ps=>ps.filter(p=>{if(p.closest('defs'))return false;let o=1;for(let n=p;n&&n.tagName!=='svg';n=n.parentElement)o*=Number(getComputedStyle(n).opacity);return o>0;}).length);assert.equal(paths,0);
}
test('story then parts survive reload/retry without full answer; assisted cannot pass cleanly',async()=>{
 const {context,page}=await open();assert.equal(await page.locator('#memoryMnemonic').textContent(),'');
 await page.locator('#memoryStoryHint').click();await page.waitForFunction(()=>window.__hsk.memory.pending.hintStage===1);await partial(page,1);
 assert.equal(await page.locator('.mnemonic-glyph').count(),0);assert.equal(await page.locator('#mnemonicNote').count(),0);
 await page.reload();await page.waitForFunction(()=>window.__hsk);await page.locator('#memoryOpen').click();await page.locator('#memoryResume').click();await page.locator('#memoryHelp:not([disabled])').waitFor();await partial(page,1);
 await page.locator('#memoryPartsHint').click();await page.waitForFunction(()=>window.__hsk.memory.pending.hintStage===2);await partial(page,2);
 assert.deepEqual(await page.locator('.mnemonic-glyph').allTextContents(),['宀','女']);
 await page.locator('#memoryRetry').click();await page.locator('#memoryHelp:not([disabled])').waitFor();await partial(page,2);
 await drawCharacter(page,'安','#memoryTarget');await page.locator('#memoryGrade:not(.hidden)').waitFor();assert.equal(await page.locator('#memoryGood').isDisabled(),true);
 await page.locator('#memoryAgain').click();await page.locator('#memoryNext').waitFor();
 const es=await page.evaluate(()=>window.__hsk.memory.store.events());const answer=es.find(e=>e.kind==='answer');assert.equal(answer.assisted,true);assert.equal('hintStage' in answer,false);await context.close();
});
test('practice explains left/right, saves personal text safely, and fits mobile',async()=>{
 const {context,page}=await open('好',false);assert.deepEqual(await page.locator('.mnemonic-position').allTextContents(),['Слева','Справа']);
 const note='<img src=x onerror=alert(1)> моя история';await page.locator('#mnemonicNote').fill(note);await page.getByRole('button',{name:'Сохранить мою историю',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#memoryMessage').textContent.includes('сохранена'));
 await page.reload();await page.waitForFunction(()=>window.__hsk);await page.locator('#memoryOpen').click();await page.locator('#memoryResume').click();await page.locator('#memoryHelp:not([disabled])').waitFor();
 assert.equal(await page.locator('#mnemonicNote').inputValue(),note);assert.equal(await page.locator('#memoryMnemonic img').count(),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:'/tmp/hanzi-mnemonic-good.png',fullPage:true});await context.close();
});
test('failed hint persistence never discloses story or parts',async()=>{
 const {context,page}=await open();await page.evaluate(()=>{window.__hsk.memory.store.patchPending=async()=>{throw new Error('Не сохранено');};});
 await page.locator('#memoryStoryHint').click();await page.waitForFunction(()=>document.querySelector('#memoryMessage').textContent==='Не сохранено');
 assert.equal(await page.locator('#memoryMnemonic').textContent(),'');assert.equal(await page.locator('#memoryAnswer').isVisible(),false);await context.close();
});
test('uncovered character has honest fallback and full help',async()=>{
 const {context,page}=await open('学');assert.equal(await page.locator('#memoryStoryHint').isDisabled(),true);assert.equal(await page.locator('#memoryPartsHint').isDisabled(),true);
 await page.locator('#memoryHelp').click();await page.locator('#memoryAnswer:not(.hidden)').waitFor();assert.match(await page.locator('#memoryMnemonic').textContent(),/пока нет проверенной/);await context.close();
});

async function delayHint(page){
 await page.evaluate(()=>{
  const store=window.__hsk.memory.store,patch=store.patchPending.bind(store);
  store.patchPending=(...args)=>args[1].hintStage?new Promise(resolve=>{window.releaseHint=async()=>resolve(await patch(...args));}):patch(...args);
 });
 await page.locator('#memoryStoryHint').click();await page.waitForFunction(()=>window.releaseHint);
}
test('hint finishing after the final stroke cannot reveal content or offer clean success',async()=>{
 const {context,page}=await open();await delayHint(page);
 await drawCharacter(page,'安','#memoryTarget');await page.locator('#memoryGrade:not(.hidden)').waitFor();
 await page.evaluate(()=>window.releaseHint());await page.waitForFunction(()=>document.querySelector('#memoryGood').disabled);
 assert.equal(await page.locator('#memoryMnemonic').textContent(),'');assert.equal(await page.locator('#memoryAnswer').isVisible(),false);
 for(const id of ['memoryStoryHint','memoryPartsHint','memoryHelp'])assert.equal(await page.locator('#'+id).isDisabled(),true);
 await page.locator('#memoryAgain').click();await page.locator('#memoryNext').waitFor();
 const es=await page.evaluate(()=>window.__hsk.memory.store.events());assert.equal(es.find(e=>e.kind==='answer').assisted,true);await context.close();
});
test('leaving and reopening during a delayed hint restores usable dashboard without disclosure',async()=>{
 const {context,page}=await open();await delayHint(page);
 await page.evaluate(async()=>{window.__hsk.memory.leave();await window.__hsk.memory.open();});
 await page.evaluate(()=>window.releaseHint());await page.locator('#memoryDashboard:not(.hidden)').waitFor();
 await page.locator('#memoryResume:not([disabled])').waitFor();assert.equal(await page.locator('#memoryMnemonic').textContent(),'');
 await page.locator('#memoryResume').click();await page.locator('#memoryHelp:not([disabled])').waitFor();await partial(page,1);await context.close();
});
test('warmed offline reload retains mnemonic modules and renders the saved practice card',async()=>{
 const {context,page}=await open('好',false);await page.evaluate(()=>navigator.serviceWorker.ready);await page.waitForFunction(()=>navigator.serviceWorker.controller);
 const cached=await page.evaluate(async()=>{const name=(await caches.keys()).find(k=>/^bishun-shell-v\d+$/.test(k));const c=await caches.open(name);return Promise.all(['mnemonic-ids','mnemonic-data','mnemonic-panel'].map(async name=>!!await c.match('js/'+name+'.js')));});assert.deepEqual(cached,[true,true,true]);
 await context.setOffline(true);await page.reload();await page.waitForFunction(()=>window.__hsk);await page.locator('#memoryOpen').click();await page.locator('#memoryResume').click();await page.locator('#mnemonicNote').waitFor();
 assert.deepEqual(await page.locator('.mnemonic-position').allTextContents(),['Слева','Справа']);await context.close();
});
test('component panels fit desktop and preserve spatial labels',async()=>{
 for(const [char,labels] of [['好',['Слева','Справа']],['安',['Сверху','Снизу']]]){
  const {context,page}=await open(char,false,1280);assert.deepEqual(await page.locator('.mnemonic-position').allTextContents(),labels);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await context.close();
 }
});
test('hint stages 1–2 never print the target character for any card (incl. observations)',async()=>{
 const context=await browser.newContext();await stubBackend(context);const page=await context.newPage();
 await page.goto(base);await page.waitForFunction(()=>window.__hsk);
 const leaks=await page.evaluate(async()=>{const {MNEMONICS}=await import('./js/mnemonic-data.js');const {renderMnemonic}=await import('./js/mnemonic-panel.js');
  const out=[];for(const char of Object.keys(MNEMONICS))for(const stage of [1,2]){const host=document.createElement('div');renderMnemonic(host,{char,stage,note:`заметка про ${char}`,onSave:()=>{}});if(host.textContent.includes(char))out.push(`${char}@${stage}`);}return out;});
 assert.deepEqual(leaks,[]);await context.close();
});
test('parts hint for 安 in the real exercise keeps the comparison but hides 安',async()=>{
 const {context,page}=await open('安');
 await page.locator('#memoryStoryHint').click();await page.waitForFunction(()=>window.__hsk.memory.pending.hintStage===1);
 await page.locator('#memoryPartsHint').click();await page.waitForFunction(()=>window.__hsk.memory.pending.hintStage===2);await partial(page,2);
 const text=await page.locator('#memoryExercise').innerText();
 assert.ok(text.includes('字'),'пояснение о похожем знаке показано');assert.ok(!text.includes('安'),`ответ не раскрыт: ${text}`);
 await context.close();
});
