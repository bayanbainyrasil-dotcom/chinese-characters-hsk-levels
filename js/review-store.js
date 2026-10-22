import {hintStageOf,validateNotes} from './mnemonic-data.js';
import {validateEvent} from './review-scheduler.js';
const DB_NAME='bishun-writing-memory-v1';
const request = req => new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
export class ReviewStore {
  constructor(name=DB_NAME) {this.name=name;this.promise=null;}
  async open() {
    if(!this.promise) this.promise=new Promise((resolve,reject)=>{
      const req=indexedDB.open(this.name,1);
      req.onupgradeneeded=()=>{req.result.createObjectStore('events',{keyPath:'id'});req.result.createObjectStore('meta');};
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>{this.promise=null;reject(req.error);};
      req.onblocked=()=>reject(new Error('Закройте другую вкладку для обновления хранилища'));
    });
    return this.promise;
  }
  async tx(mode, action) {
    const db=await this.open(); const tx=db.transaction(['events','meta'],mode);
    const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||new Error('Запись не сохранена'));tx.onerror=()=>{};});
    try {const value=await action(tx.objectStore('events'),tx.objectStore('meta'));await done;return value;}
    catch(error){try{tx.abort();}catch{} await done.catch(()=>{});throw error;}
  }
  async migrate(legacy) {
    return this.tx('readwrite',async(_,meta)=>{
      if(await request(meta.get('memory-migration-v1'))) return;
      await request(meta.put({savedAt:Date.now(),progress:legacy},'legacy-memory-backup-v1'));
      await request(meta.put(true,'memory-migration-v1'));
    });
  }
  async events(){return this.tx('readonly',store=>request(store.getAll()));}
  async get(key,fallback=null){return this.tx('readonly',async(_,meta)=>(await request(meta.get(key)))??fallback);}
  async set(key,value){return this.tx('readwrite',(_,meta)=>request(meta.put(value,key)));}
  async pending(key){return this.get('pending:'+key);}
  async setPending(key,value){return this.set('pending:'+key,value);}
  async claimPending(key,value){return this.tx('readwrite',async(_,meta)=>{
    const active=await request(meta.get('pending:'+key));
    if(active&&active.char!==value.char)return active;
    const parkedKey='parked:'+key+':'+value.char;
    const old=active||(await request(meta.get(parkedKey)));
    const stale=old&&(old.mode!==value.mode||old.kind!==value.kind||old.dueKey!==value.dueKey);
    const next=stale?{...value,assisted:old.assisted||old.mode==='practice',mistakes:old.mistakes,hintStage:old.mode==='practice'?3:hintStageOf(old)}:old||value;
    await request(meta.put(next,'pending:'+key));await request(meta.delete(parkedKey));return next;
  });}
  async suspendPending(key,expectedId=null){return this.tx('readwrite',async(_,meta)=>{
    const value=await request(meta.get('pending:'+key));
    if(expectedId&&value?.id!==expectedId)throw new Error('Попытка изменилась в другой вкладке. Откройте занятие снова');
    if(value)await request(meta.put(value,'parked:'+key+':'+value.char));
    await request(meta.delete('pending:'+key));
  });}
  async patchPending(key,patch,expectedId=null){return this.tx('readwrite',async(_,meta)=>{
    const value=await request(meta.get('pending:'+key));if(!value || expectedId&&value.id!==expectedId) throw new Error('Попытка изменилась в другой вкладке. Откройте занятие снова');
    const hintStage=Math.max(hintStageOf(value),hintStageOf(patch));
    const next={...value,...patch,hintStage,assisted:value.assisted||patch.assisted||hintStage>0,mistakes:Math.max(value.mistakes||0,patch.mistakes||0)};await request(meta.put(next,'pending:'+key));return next;
  });}
  async finish(raw,pendingKey=null) {
    const event=validateEvent(raw);
    return this.tx('readwrite',async(store,meta)=>{
      const existing=await request(store.get(event.id));
      if(existing) return false; // stale duplicate completion cannot rewrite a terminal attempt
      if(pendingKey) {
        const pending=await request(meta.get('pending:'+pendingKey));
        if(!pending || pending.id!==event.id) throw new Error('Попытка уже изменилась. Откройте занятие снова');
        event.assisted ||= pending.assisted; event.mistakes=Math.max(event.mistakes,pending.mistakes||0);
      }
      await request(store.add(event));
      if(pendingKey) await request(meta.delete('pending:'+pendingKey));
      return true;
    });
  }
  async pause(key){return this.tx('readwrite',(_,meta)=>request(meta.delete('pending:'+key)));}
  async bindOwner(userId,{replace=false,expectedOwner=null}={}){return this.tx('readwrite',async(_,meta)=>{
    const owner=(await request(meta.get('sync-owner')))??null;
    if(owner&&owner!==userId){
      if(!replace||owner!==expectedOwner)throw new Error('Это расписание связано с другим аккаунтом. Используйте явную смену привязки после сохранения копии');
      await request(meta.put({previousOwner:owner,nextOwner:userId,at:Date.now()},'last-owner-change'));
      await request(meta.delete('ack:'+userId));await request(meta.delete('cursor:'+userId));
    }
    await request(meta.put(userId,'sync-owner'));
  });}
  async notes(){return this.get('mnemonic-notes',{});}
  async saveNote(char,text){
    validateNotes({[char]:text});
    return this.tx('readwrite',async(_,meta)=>{
      const notes=(await request(meta.get('mnemonic-notes')))||{};
      if(text.trim())notes[char]=text.trim();else delete notes[char];
      await request(meta.put(notes,'mnemonic-notes'));return notes;
    });
  }
  async export(){return this.tx('readonly',async(store,meta)=>({schema:'bishun-memory-backup-v1',schedulerVersion:1,events:await request(store.getAll()),notes:(await request(meta.get('mnemonic-notes')))||{}}));}

  validateImport(data) {
    if(data?.schema!=='bishun-memory-backup-v1' || data.schedulerVersion!==1 || !Array.isArray(data.events) || data.events.length>50000) throw new Error('Нужна копия расписания памяти. Старые копии словаря импортируются в прежнем разделе');
    validateNotes(data.notes);return data.events.map(e=>validateEvent(e));
  }
  async import(data){const events=this.validateImport(data);return this.mergeRemote(events,{notes:validateNotes(data.notes)});}
  async mergeRemote(events,{cursorKey=null,cursor=null,ackKey=null,accepted=[],rejected=[],trustedRemote=false,notes=null}={}) {
    const quarantined=[];const validated=[];
    for(const [index,event] of events.entries()){
      try{validated.push(validateEvent(event,trustedRemote?Infinity:Date.now()));}
      catch(error){if(!trustedRemote)throw error;quarantined.push({id:`remote:${cursor}:${index}`,reason:error.message,event});}
    }
    return this.tx('readwrite',async(store,meta)=>{
      let count=0;
      for(const event of validated) {
        const old=await request(store.get(event.id));
        if(old && JSON.stringify(validateEvent(old,trustedRemote?Infinity:Date.now()))!==JSON.stringify(event)){
          if(!trustedRemote)throw new Error('Конфликт одинаковых номеров попыток');
          quarantined.push({id:event.id,reason:'Конфликт одинаковых номеров попыток',event});continue;
        }
        if(!old){await request(store.add(event));count++;}
      }
      if(notes){const current=(await request(meta.get('mnemonic-notes')))||{};await request(meta.put({...notes,...current},'mnemonic-notes'));}
      if(quarantined.length){
        const previous=await request(meta.get('remote-quarantine'))||[];
        await request(meta.put([...previous,...quarantined],'remote-quarantine'));
      }
      if(cursorKey) await request(meta.put(cursor,cursorKey));
      if(ackKey){
        const state=(await request(meta.get(ackKey)))||{accepted:[],rejected:[]};
        const allRejected=new Map([...state.rejected,...rejected,...quarantined.map(({id,reason})=>({id,reason}))].map(e=>[e.id,e]));
        await request(meta.put({accepted:[...new Set([...state.accepted,...accepted,...validated.map(e=>e.id)])],rejected:[...allRejected.values()]},ackKey));
      }
      return count;
    });
  }
}
