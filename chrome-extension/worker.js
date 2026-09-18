let socket=null,connected=false,shared=new Map(),attached=new Set(),heartbeat,lastError='',disconnecting=false;
const send=m=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(m));};
const tabInfo=(t,owned=false)=>({id:t.id,url:t.url||'',title:t.title||'',owned});
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(()=>{});
async function disconnect(){
  disconnecting=true;connected=false;const ws=socket;socket=null;clearInterval(heartbeat);ws?.close();
  const tabs=[...attached];attached.clear();shared.clear();
  await Promise.allSettled(tabs.map(tabId=>chrome.debugger.detach({tabId})));
  await chrome.action.setBadgeText({text:''});disconnecting=false;
}
async function connect(link,tabId){
  if(disconnecting)throw new Error('Подождите завершения отключения.');
  if(socket)throw new Error('Сначала отключите текущую вкладку.');
  const u=new URL(link);
  if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||!/^#[a-f0-9]{48}$/.test(u.hash))throw new Error('Вставьте полную приватную ссылку панели JEV, включая #токен.');
  const tab=await chrome.tabs.get(tabId);if(!/^https?:\/\//.test(tab.url||''))throw new Error('Выберите обычную веб-страницу.');
  const token=u.hash.slice(1);lastError='';shared.set(tabId,tabInfo(tab));
  const ws=new WebSocket(`ws://${u.host}/extension`);socket=ws;
  ws.onopen=()=>send({type:'hello',token,tab:tabInfo(tab),userAgent:navigator.userAgent});
  ws.onmessage=async event=>{
    try{
      const m=JSON.parse(event.data);
      if(m.type==='ready'){connected=true;await chrome.action.setBadgeText({text:'ON'});await chrome.action.setBadgeBackgroundColor({color:'#218c63'});return;}
      if(m.type==='pong')return;
      if(socket!==ws||!connected||!Number.isInteger(m.id))return;
      const p=m.params||{};let result;
      try{
        if(!shared.has(p.tabId))throw new Error('Tab was not shared by the user.');
        if(m.method==='attach'){if(!attached.has(p.tabId)){await chrome.debugger.attach({tabId:p.tabId},'1.3');if(socket!==ws||!connected){await chrome.debugger.detach({tabId:p.tabId}).catch(()=>{});throw new Error('Connection was cancelled.');}attached.add(p.tabId);}result={};}
        else if(m.method==='command'){
          if(!attached.has(p.tabId))throw new Error('Debugger detached.');
          // Only the fixed executor uses this transport. No website content receives an RPC endpoint.
          if(typeof p.method!=='string'||! /^(Accessibility|DOM|DOMSnapshot|Emulation|Input|Log|Network|Page|Runtime|Target)\./.test(p.method))throw new Error('Unsupported protocol domain.');
          if(['Target.createTarget','Target.attachToTarget','Target.attachToBrowserTarget','Target.createBrowserContext','Target.getTargets'].includes(p.method))throw new Error('Cannot attach unrelated tabs.');
          result=await chrome.debugger.sendCommand({tabId:p.tabId,...(p.sessionId?{sessionId:p.sessionId}:{})},p.method,p.params);
        }else if(m.method==='closeTab'){if(!shared.get(p.tabId).owned)throw new Error('User tab must stay open.');await chrome.tabs.remove(p.tabId);result={};}
        else throw new Error('Unknown bridge operation.');
        if(socket===ws)send({id:m.id,result:result??{}});
      }catch(error){if(socket===ws)send({id:m.id,error:error.message});}
    }catch{lastError='Некорректное сообщение сервиса';await disconnect();}
  };
  ws.onclose=()=>{if(socket===ws){lastError||='Соединение закрыто. Подключите вкладку снова.';void disconnect();}};
  ws.onerror=()=>{lastError='Не удалось подключиться к локальной панели JEV.';};
  heartbeat=setInterval(()=>send({type:'ping'}),20000);
  await chrome.storage.session.set({lastLink:link});
}
chrome.debugger.onEvent.addListener((source,method,params)=>{if(shared.has(source.tabId))send({type:'event',tabId:source.tabId,sessionId:source.sessionId,method,params});});
chrome.debugger.onDetach.addListener(source=>{attached.delete(source.tabId);if(shared.has(source.tabId)){send({type:'detached',tabId:source.tabId});if(!shared.get(source.tabId).owned)void disconnect();}});
chrome.tabs.onCreated.addListener(tab=>{if(connected&&shared.has(tab.openerTabId)&&shared.size<8){const info=tabInfo(tab,true);shared.set(tab.id,info);send({type:'tab',tab:info});}});
// target=_blank with implicit noopener may omit tabs.openerTabId. Chrome supplies
// the actual source tab here, so unrelated newly opened tabs are never adopted.
chrome.webNavigation.onCreatedNavigationTarget.addListener(async details=>{
  const ws=socket;
  if(!connected||!shared.has(details.sourceTabId)||shared.size>=8)return;
  const tab=await chrome.tabs.get(details.tabId).catch(()=>null);
  if(!tab||socket!==ws||!connected||!shared.has(details.sourceTabId))return;
  const info=tabInfo(tab,true);shared.set(tab.id,info);send({type:'tab',tab:info});
});
chrome.tabs.onUpdated.addListener((id,change,tab)=>{if(shared.has(id)){const info=tabInfo(tab,shared.get(id).owned);shared.set(id,info);send({type:'tab',tab:info});}});
chrome.tabs.onRemoved.addListener(id=>{if(shared.has(id)){const owned=shared.get(id).owned;shared.delete(id);attached.delete(id);send({type:'removed',tabId:id});if(!owned)void disconnect();}});
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('panel.html'))return;
  void(async()=>{
    if(m.type==='status')return {connected,connecting:!!socket&&!connected,tabs:[...shared.values()],error:lastError};
    if(m.type==='connect'){await connect(m.link,m.tabId);return {ok:true};}
    if(m.type==='disconnect'){lastError='';await disconnect();return {ok:true};}
    throw new Error('Unknown message.');
  })().then(reply,error=>reply({error:error.message}));return true;
});
