let socket=null,connected=false,shared=new Map(),attached=new Set(),heartbeat,retryTimer,lastError='',disconnecting=false;
let enabled=true,manualLink='',connecting=false,attempt=0,generation=0,initialized;
const send=m=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(m));};
const tabInfo=(t,owned=false)=>({id:t.id,url:t.url||'',title:t.title||'',owned});
const webTab=t=>/^https?:\/\//.test(t?.url||'');
const remember=()=>chrome.storage.session.set({sharedTabs:[...shared.values()],manualLink});
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(()=>{});
async function dropConnection(){
  disconnecting=true;connected=false;const ws=socket;socket=null;clearInterval(heartbeat);ws?.close();
  const tabs=[...attached];attached.clear();
  await Promise.allSettled(tabs.map(tabId=>chrome.debugger.detach({tabId})));
  await chrome.action.setBadgeText({text:''});disconnecting=false;
}
async function disconnect(){
  enabled=false;generation++;clearTimeout(retryTimer);await chrome.storage.local.set({enabled:false});
  shared.clear();manualLink='';await remember();await dropConnection();
}
function schedule(){
  clearTimeout(retryTimer);if(!enabled)return;
  retryTimer=setTimeout(()=>void reconnect(false),Math.min(15000,1000*2**Math.min(attempt++,4)));
}
async function reconnect(start=false){
  if(!enabled||socket||connecting||disconnecting)return;
  connecting=true;const version=generation;
  try{
    let link=manualLink;
    if(!link){
      const result=await chrome.runtime.sendNativeMessage('in.legost.jev_browser',{type:'endpoint',start});
      if(result?.error)throw new Error(result.error);
      if(!result?.url)throw new Error('Ожидаем локальный JEV…');
      link=result.url;
    }
    if(!enabled||version!==generation)return;
    const u=new URL(link);
    if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||!/^#[a-f0-9]{48}$/.test(u.hash))throw new Error('Некорректный адрес локального JEV.');
    // IDs are restored only within this Chrome session, never after a browser restart.
    for(const [id,info] of shared){const t=await chrome.tabs.get(id).catch(()=>null);if(webTab(t))shared.set(id,tabInfo(t,info.owned));else shared.delete(id);}
    if(!enabled||version!==generation)return;
    const root=[...shared.values()].find(t=>!t.owned);
    if(!root)shared.clear();await remember();
    const ws=new WebSocket(`ws://${u.host}/extension`);socket=ws;
    const sendHere=m=>{if(socket===ws)send(m);};
    ws.onopen=()=>sendHere({type:'hello',token:u.hash.slice(1),tab:root,userAgent:navigator.userAgent});
    ws.onmessage=async event=>{
      if(socket!==ws)return;
      try{
        const m=JSON.parse(event.data);
        if(m.type==='ready'){
          connected=true;attempt=0;lastError='';
          for(const t of shared.values())if(t.owned)sendHere({type:'tab',tab:t});
          await chrome.action.setBadgeText({text:'ON'});await chrome.action.setBadgeBackgroundColor({color:'#218c63'});return;
        }
        if(m.type==='pong')return;
        if(!connected||!Number.isInteger(m.id))return;
        const p=m.params||{};let result;
        try{
          if(m.method==='selectTab'){
            if(shared.size)throw new Error('A tab is already selected.');
            const requested=new URL(p.url);if(!['http:','https:'].includes(requested.protocol)||requested.username||requested.password)throw new Error('Invalid task URL.');
            const tabs=(await chrome.tabs.query({})).filter(webTab);
            const normalized=t=>{const u=new URL(t.url);u.hash='';return u.href;};requested.hash='';
            const matches=tabs.filter(t=>new URL(t.url).origin===requested.origin);
            // Prefer the exact page, then an active existing tab of the requested site.
            let tab=tabs.find(t=>normalized(t)===requested.href)||matches.find(t=>t.active)||matches[0];
            if(!tab)tab=await chrome.tabs.create({url:requested.href,active:true});
            if(socket!==ws||!connected)throw new Error('Connection changed; inspect before retrying.');
            const info=tabInfo(tab);shared.set(tab.id,info);await remember();result={tab:info};
          }else{
            if(!shared.has(p.tabId))throw new Error('Tab is outside this task.');
            if(m.method==='attach'){
              if(!attached.has(p.tabId)){
                await chrome.debugger.attach({tabId:p.tabId},'1.3');
                if(socket!==ws||!connected){await chrome.debugger.detach({tabId:p.tabId}).catch(()=>{});throw new Error('Connection was cancelled.');}
                attached.add(p.tabId);
              }result={};
            }else if(m.method==='command'){
              if(!attached.has(p.tabId))throw new Error('Debugger detached.');
              if(typeof p.method!=='string'||! /^(Accessibility|DOM|DOMSnapshot|Emulation|Input|Log|Network|Page|Runtime|Target)\./.test(p.method))throw new Error('Unsupported protocol domain.');
              if(['Target.createTarget','Target.attachToTarget','Target.attachToBrowserTarget','Target.createBrowserContext','Target.getTargets'].includes(p.method))throw new Error('Cannot attach unrelated tabs.');
              result=await chrome.debugger.sendCommand({tabId:p.tabId,...(p.sessionId?{sessionId:p.sessionId}:{})},p.method,p.params);
            }else if(m.method==='closeTab'){if(!shared.get(p.tabId).owned)throw new Error('User tab must stay open.');await chrome.tabs.remove(p.tabId);result={};}
            else throw new Error('Unknown bridge operation.');
          }
          sendHere({id:m.id,result:result??{}});
        }catch(error){sendHere({id:m.id,error:error.message});}
      }catch{lastError='Некорректное сообщение сервиса';await disconnect();}
    };
    ws.onclose=()=>{if(socket===ws){lastError='Восстанавливаем связь с JEV…';void dropConnection().then(schedule);}};
    ws.onerror=()=>{if(socket===ws)lastError='Локальный JEV недоступен. Повторяем подключение…';};
    heartbeat=setInterval(()=>{if(socket===ws)send({type:'ping'});},20000);
  }catch{if(version===generation){lastError=manualLink?'Не удалось подключиться к JEV.':'Локальный JEV не найден. Установите или обновите JEV Browser.';schedule();}}
  finally{connecting=false;if(version!==generation&&enabled&&!socket)schedule();}
}
chrome.debugger.onEvent.addListener((source,method,params)=>{if(shared.has(source.tabId))send({type:'event',tabId:source.tabId,sessionId:source.sessionId,method,params});});
chrome.debugger.onDetach.addListener(source=>{
  const expected=!attached.has(source.tabId);attached.delete(source.tabId);
  if(!expected&&shared.has(source.tabId)){send({type:'detached',tabId:source.tabId});if(!shared.get(source.tabId).owned)void disconnect();}
});
const addPopup=async(tab,ws=socket)=>{
  if(!connected||socket!==ws||shared.size>=8||shared.has(tab.id))return;
  const info=tabInfo(tab,true);shared.set(tab.id,info);send({type:'tab',tab:info});await remember();
};
chrome.tabs.onCreated.addListener(tab=>{if(shared.has(tab.openerTabId))void addPopup(tab);});
chrome.webNavigation.onCreatedNavigationTarget.addListener(async details=>{
  const ws=socket;if(!connected||!shared.has(details.sourceTabId)||shared.size>=8)return;
  const tab=await chrome.tabs.get(details.tabId).catch(()=>null);
  if(tab&&shared.has(details.sourceTabId))await addPopup(tab,ws);
});
chrome.tabs.onUpdated.addListener((id,change,tab)=>{if(shared.has(id)){const info=tabInfo(tab,shared.get(id).owned);shared.set(id,info);send({type:'tab',tab:info});void remember();}});
chrome.tabs.onRemoved.addListener(id=>{if(shared.has(id)){const owned=shared.get(id).owned;shared.delete(id);attached.delete(id);send({type:'removed',tabId:id});if(!owned)void disconnect();else void remember();}});
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('panel.html'))return;
  void(async()=>{
    await initialized;
    if(m.type==='status')return {connected,connecting:connecting||!!socket&&!connected,enabled,tabs:[...shared.values()],error:lastError};
    if(m.type==='connect'){
      // Changing the selection is explicit; automatic retries never change it.
      generation++;clearTimeout(retryTimer);await dropConnection();shared.clear();
      if(m.tabId){const tab=await chrome.tabs.get(m.tabId);if(!webTab(tab))throw new Error('Выберите веб-страницу.');shared.set(tab.id,tabInfo(tab));}
      manualLink=typeof m.link==='string'?m.link.trim():'';enabled=true;await chrome.storage.local.set({enabled:true});await remember();await reconnect(true);return {ok:true};
    }
    if(m.type==='disconnect'){lastError='';await disconnect();return {ok:true};}
    throw new Error('Unknown message.');
  })().then(reply,error=>reply({error:error.message}));return true;
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='jev-reconnect')void initialized.then(()=>reconnect(false));});
initialized=(async()=>{
  const [local,session]=await Promise.all([chrome.storage.local.get('enabled'),chrome.storage.session.get(['sharedTabs','manualLink'])]);
  enabled=local.enabled!==false;manualLink=session.manualLink||'';
  shared=new Map((session.sharedTabs||[]).map(t=>[t.id,t]));
  await chrome.alarms.create('jev-reconnect',{periodInMinutes:.5});
})();
void initialized.then(()=>reconnect(true));
