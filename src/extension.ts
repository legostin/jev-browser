import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { ConnectOverCDPTransport } from 'playwright';
import { z } from 'zod';

const Tab=z.object({id:z.number().int().nonnegative(),url:z.string().max(8000),title:z.string().max(1000),owned:z.boolean().default(false)});
type Tab=z.infer<typeof Tab>;
type Session={tabId:number;id:string;info:any;children:Set<string>;frameTree:Promise<void>;frameTreeReady:()=>void};

/** A single explicitly shared Chrome tab (plus its popups), never a browser-wide endpoint. */
export class ExtensionBridge {
  private socket?:WebSocket;
  private transport?:ConnectOverCDPTransport;
  private tabs=new Map<number,Tab>();
  private sessions=new Map<number,Session>();
  private attaching=new Map<number,Promise<Session>>();
  private callbacks=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout;method:string;started:number}>();
  private sequence=0;
  private autoAttach=false;
  private userAgent='';
  private ready=false;
  status(){return {connected:this.ready,busy:!!this.transport,tabs:[...this.tabs.values()],pending:[...this.callbacks.values()].map(c=>({method:c.method,elapsedMs:Date.now()-c.started}))};}
  bind(server:Server,origin:()=>string,token:string) {
    const wss=new WebSocketServer({noServer:true,maxPayload:8*1024*1024});
    server.on('upgrade',(req,socket,head)=>{
      if(req.url!=='/extension'||req.headers.host!==new URL(origin()).host||!/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin||'')){
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;
      }
      if(wss.clients.size>=3){socket.destroy();return;}
      wss.handleUpgrade(req,socket,head,ws=>{
        let authenticated=false;
        const timer=setTimeout(()=>ws.close(1008,'Pairing timed out'),5000);
        ws.on('error',()=>{});
        ws.on('message',raw=>{
          try {
            const m=JSON.parse(raw.toString());
            if(!authenticated){
              const supplied=Buffer.from(typeof m.token==='string'?m.token:''),expected=Buffer.from(token);
              if(m.type!=='hello'||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)||this.socket){ws.close(1008,'Pairing rejected');return;}
              const tab=m.tab?Tab.parse(m.tab):undefined;if(tab&&!/^https?:\/\//.test(tab.url))throw new Error('Only web tabs can be shared.');
              authenticated=true;clearTimeout(timer);this.socket=ws;if(tab)this.tabs.set(tab.id,{...tab,owned:false});
              this.userAgent=typeof m.userAgent==='string'?m.userAgent.slice(0,500):'';this.ready=true;ws.send(JSON.stringify({type:'ready'}));return;
            }
            if(m.type==='ping'){ws.send(JSON.stringify({type:'pong'}));return;}
            if(Number.isInteger(m.id)){
              const pending=this.callbacks.get(m.id);if(!pending)return;
              clearTimeout(pending.timer);this.callbacks.delete(m.id);
              m.error?pending.reject(new Error(String(m.error).slice(0,1000))):pending.resolve(m.result);return;
            }
            if(m.type==='tab'){
              const tab=Tab.parse(m.tab);
              if(this.tabs.has(tab.id)||tab.owned){this.tabs.set(tab.id,tab);if(this.autoAttach)void this.attach(tab.id).catch(()=>{});}return;
            }
            if(m.type==='removed'||m.type==='detached'){
              if(!Number.isInteger(m.tabId))return;
              if(m.type==='detached'&&!this.tabs.get(m.tabId)?.owned){ws.close(1000,'Shared tab disconnected');return;}
              this.tabs.delete(m.tabId);const s=this.sessions.get(m.tabId);this.sessions.delete(m.tabId);
              if(s)this.emit({method:'Target.detachedFromTarget',params:{sessionId:s.id,targetId:s.info.targetId}});return;
            }
            if(m.type==='event'&&typeof m.method==='string'){
              const s=this.sessions.get(m.tabId);if(!s)return;
              if(m.method==='Target.attachedToTarget'&&m.params?.sessionId)s.children.add(m.params.sessionId);
              if(m.method==='Target.detachedFromTarget')s.children.delete(m.params?.sessionId);
              this.emit({sessionId:m.sessionId||s.id,method:m.method,params:m.params});
            }
          }catch{ws.close(1008,'Invalid extension message');}
        });
        ws.on('close',()=>{clearTimeout(timer);if(this.socket===ws)this.disconnected();});
      });
    });
    return ()=>{for(const ws of wss.clients)ws.terminate();wss.close();};
  }
  private disconnected(){
    this.socket=undefined;this.ready=false;this.tabs.clear();for(const s of this.sessions.values())s.frameTreeReady();this.sessions.clear();this.attaching.clear();this.autoAttach=false;
    for(const c of this.callbacks.values()){clearTimeout(c.timer);c.reject(new Error('Chrome extension disconnected. Inspect before resuming.'));}this.callbacks.clear();
    const t=this.transport;this.transport=undefined;t?.onclose?.('Chrome extension disconnected');
  }
  private rpc(method:string,params:unknown):Promise<any>{
    if(!this.ready||this.socket?.readyState!==WebSocket.OPEN)return Promise.reject(new Error('Connect a tab in the JEV Chrome extension first.'));
    const id=++this.sequence,label=method==='command'?(params as any).method:method;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.callbacks.delete(id);reject(new Error(`Chrome bridge timed out: ${label}. Inspect before resuming.`));},20000);
      this.callbacks.set(id,{resolve,reject,timer,method:label,started:Date.now()});this.socket!.send(JSON.stringify({id,method,params}));
    });
  }
  private emit(message:object){this.transport?.onmessage?.(message);}
  async selectTab(url:string){
    if(this.tabs.size)return;
    if(this.transport)throw new Error('Chrome is already in use.');
    const result=await this.rpc('selectTab',{url});const tab=Tab.parse(result.tab);
    this.tabs.set(tab.id,{...tab,owned:false});
  }
  private async attach(tabId:number):Promise<Session>{
    const existing=this.sessions.get(tabId);if(existing)return existing;
    if(this.attaching.has(tabId))return this.attaching.get(tabId)!;
    const socket=this.socket;
    const promise=(async()=>{
      await this.rpc('attach',{tabId});
      const {targetInfo}=await this.rpc('command',{tabId,method:'Target.getTargetInfo'});
      if(this.socket!==socket||!this.ready)throw new Error('Chrome connection changed during attachment.');
      let frameTreeReady!:()=>void;const frameTree=new Promise<void>(r=>frameTreeReady=r);
      const s:Session={tabId,id:`jev-${++this.sequence}`,info:targetInfo,children:new Set(),frameTree,frameTreeReady};this.sessions.set(tabId,s);
      this.emit({method:'Target.attachedToTarget',params:{sessionId:s.id,targetInfo:{...targetInfo,attached:true},waitingForDebugger:false}});return s;
    })();
    this.attaching.set(tabId,promise);try{return await promise;}finally{this.attaching.delete(tabId);}
  }
  createTransport():ConnectOverCDPTransport {
    if(!this.ready)throw new Error('Connect a tab in the JEV Chrome extension first.');
    if(this.transport)throw new Error('The shared Chrome tab already belongs to a task. Cancel that task or disconnect it first.');
    const t:ConnectOverCDPTransport={
      send:(message:any)=>{void this.command(message.method,message.params,message.sessionId).then(
        result=>{t.onmessage?.({id:message.id,sessionId:message.sessionId,result});
          // Install Playwright's frame listeners before Chrome can emit Runtime contexts.
          if(message.method==='Page.getFrameTree')queueMicrotask(()=>{for(const s of this.sessions.values())if(s.id===message.sessionId)s.frameTreeReady();});},
        error=>t.onmessage?.({id:message.id,sessionId:message.sessionId,error:{message:error.message}}));},
      close:()=>{if(this.transport===t){this.transport=undefined;this.autoAttach=false;this.ready=false;this.socket?.close(1000,'Task released Chrome');}t.onclose?.();}
    };
    this.transport=t;return t;
  }
  private async command(method:string,params:any={},sessionId?:string):Promise<any>{
    if(!sessionId){
      if(method==='Browser.getVersion')return {protocolVersion:'1.3',product:`Chrome/${this.userAgent.match(/Chrome\/([\d.]+)/)?.[1]||'125.0.0.0'}`,userAgent:this.userAgent,revision:''};
      if(method==='Target.setAutoAttach'){this.autoAttach=!!params.autoAttach;if(this.autoAttach)await Promise.all([...this.tabs.keys()].map(id=>this.attach(id)));return {};}
      if(method==='Target.getTargetInfo')return {targetInfo:this.sessions.values().next().value?.info};
      if(method==='Target.getTargets')return {targetInfos:[...this.sessions.values()].map(s=>s.info)};
      if(method==='Target.closeTarget'){
        const s=[...this.sessions.values()].find(s=>s.info.targetId===params.targetId);
        if(!s||!this.tabs.get(s.tabId)?.owned)throw new Error('User-owned tabs are preserved. Disconnect instead.');
        await this.rpc('closeTab',{tabId:s.tabId});return {success:true};
      }
      throw new Error(`Browser-wide command is unavailable in shared-tab mode: ${method}`);
    }
    const s=[...this.sessions.values()].find(s=>s.id===sessionId||s.children.has(sessionId));
    if(!s)throw new Error('Unknown or detached Chrome session.');
    if(method==='Runtime.enable'&&s.id===sessionId)await s.frameTree;
    if(method==='Target.getTargetInfo'&&s.id===sessionId)return {targetInfo:s.info};
    return this.rpc('command',{tabId:s.tabId,sessionId:s.id===sessionId?undefined:sessionId,method,params});
  }
}
