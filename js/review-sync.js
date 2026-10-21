// Memory has its own durable journal; it must never enter the legacy 500-event queue.
export class ReviewSync {
  constructor({store,getClient,getUser,onStatus=()=>{}}){Object.assign(this,{store,getClient,getUser,onStatus});this.busy=false;this.dirty=false;}
  async bind(options={}){
    const user=this.getUser();if(!user)throw new Error('Сначала войдите в аккаунт в настройках сайта');
    await this.store.bindOwner(user.id,options);
  }
  async flush(){
    if(this.busy){this.dirty=true;return;}
    this.busy=true;
    try{
      const user=this.getUser(),owner=await this.store.get('sync-owner');
      if(!user||!owner||user.id!==owner){this.onStatus('Расписание только на этом устройстве. Сохраните копию для переноса.');return;}
      if(globalThis.navigator?.onLine===false){this.onStatus('Нет сети. Попытки сохранены на устройстве.');return;}
      const client=await this.getClient();if(!client)throw new Error('Нет подключения');
      const ackKey='ack:'+owner,cursorKey='cursor:'+owner;
      let rounds=0,more=true;
      while(more && rounds++<100){
        this.dirty=false;
        if(this.getUser()?.id!==owner)break;
        const ack=await this.store.get(ackKey,{accepted:[],rejected:[]});
        const sent=new Set([...ack.accepted,...ack.rejected.map(e=>e.id)]);
        const pending=(await this.store.events()).filter(e=>!sent.has(e.id)).slice(0,100);
        const cursor=await this.store.get(cursorKey,0);
        const {data,error}=await client.rpc('sync_writing_reviews',{p_events:pending,p_after:cursor,p_limit:200});
        if(error)throw error;
        if(this.getUser()?.id!==owner)break;
        if(!data || !Array.isArray(data.rows)||!Array.isArray(data.acceptedIds)||!Array.isArray(data.rejected))throw new Error('Неожиданный ответ сервера');
        let previous=cursor;for(const row of data.rows){const seq=Number(row.seq);if(!Number.isSafeInteger(seq)||seq<=previous)throw new Error('Неверный порядок сервера');previous=seq;}
        const next=data.rows.length?Number(data.rows.at(-1).seq):cursor;
        if(!Number.isSafeInteger(next)||next<cursor)throw new Error('Неверный курсор сервера');
        await this.store.mergeRemote(data.rows.map(r=>r.event),{trustedRemote:true,cursorKey,cursor:next,ackKey,accepted:data.acceptedIds,rejected:data.rejected});
        const allAck=await this.store.get(ackKey);const done=new Set([...allAck.accepted,...allAck.rejected.map(e=>e.id)]);
        more=this.dirty||data.rows.length===200||(await this.store.events()).some(e=>!done.has(e.id));
        if(pending.length && !data.acceptedIds.length && !data.rejected.length)throw new Error('Сервер не подтвердил попытки');
        this.onStatus(allAck.rejected.length?`Синхронизация выполнена. ${allAck.rejected.length} попыток остались только здесь: ${/clock/i.test(allAck.rejected[0].reason)?'проверьте часы устройства':'сервер не принял часть записей'}. Сохраните копию.`:'Расписание синхронизировано. Новые события могут уточнить сроки.');
      }
      if(more)this.onStatus('Часть истории ещё отправляется. Нажмите синхронизацию ещё раз.');
    }catch(error){this.onStatus(`Расписание сохранено только здесь. Синхронизация пока недоступна. Можно скачать копию.`);}
    finally{this.busy=false;}
  }
}
