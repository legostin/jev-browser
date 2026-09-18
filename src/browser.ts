import { chromium, type Browser as PWBrowser, type BrowserContext, type Page, type Frame, type ElementHandle } from 'playwright';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Snapshot, FrameState, Action, UINode } from './schema.js';
import type { ExtensionBridge } from './extension.js';

import { validateAction, StaleObservation } from './action-guard.js';
export { StaleObservation } from './action-guard.js';
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
export function httpUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without embedded credentials.');
  return url.href;
}
export class BrowserAdapter {
  private browser!: PWBrowser;
  private context!: BrowserContext;
  private page!: Page;
  private pages = new Map<string, Page>();
  private frameRefs = new Map<string, Frame>();
  private frameIds = new WeakMap<Frame, string>();
  private pageIds = new WeakMap<Page, string>();
  private counter = 0;
  private attached = false;
  private script = '';
  private dialogMessage: string | null = null;
  private userPages = new Set<Page>();
  constructor(private extension?:ExtensionBridge) {}

  isConnected() { return !!this.browser?.isConnected(); }
  async open(url: string, headless: boolean) {
    httpUrl(url);
    this.script = await readFile(fileURLToPath(new URL('../collector.js', import.meta.url)), 'utf8');
    const cdp = process.env.JEV_CDP_URL;
    if(this.extension){
      this.browser=await chromium.connectOverCDP(this.extension.createTransport(),{noDefaults:true,timeout:20000});
      this.context=this.browser.contexts()[0];this.attached=true;
      const selected=this.context.pages()[0];if(!selected)throw new Error('The shared Chrome tab is unavailable.');
      this.page=selected;this.userPages.add(selected);this.registerPage(selected);
    } else if (cdp) {
      const u = new URL(cdp);
      if (!['127.0.0.1','localhost','[::1]'].includes(u.hostname)) throw new Error('JEV_CDP_URL must point to a local browser.');
      this.browser = await chromium.connectOverCDP(cdp);
      this.context = this.browser.contexts()[0];
      this.attached = true;
    } else {
      this.browser = await chromium.launch({ headless, channel: process.env.JEV_BROWSER_CHANNEL || 'chrome' });
      this.context = await this.browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: false });
    }
    this.context.setDefaultTimeout(2500);
    this.context.on('page', async p => {
      const opener = await p.opener();
      if (this.extension || (opener && this.pageIds.has(opener))) this.registerPage(p);
    });
    if(!this.extension){
      this.page = await this.context.newPage();
      this.registerPage(this.page);
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    }
  }
  private registerPage(page: Page) {
    if (this.pageIds.has(page)) return;
    const id = `tab-${++this.counter}`;
    this.pageIds.set(page, id); this.pages.set(id, page);
    page.on('dialog', async d => { this.dialogMessage = `Browser ${d.type()} dialog was dismissed: ${d.message().slice(0,300)}`; await d.dismiss().catch(() => {}); });
    page.on('close', () => this.pages.delete(id));
  }
  async observe(): Promise<Snapshot> {
    // Retrying an interrupted read is safe; never replay a browser mutation here.
    for(let attempt=0;attempt<3;attempt++) {
      const page=this.page;
      let navigating=false;
      const onNavigation=()=>{navigating=true;};
      page.on('framenavigated',onNavigation);
      try {
        const snapshot=await this.observeOnce();
        if(navigating)throw new Error('Document navigated during observation.');
        return snapshot;
      } catch(error) {
        const transient=navigating || /Execution context was destroyed|Cannot find context|Document navigated during observation/.test(error instanceof Error?error.message:'');
        if(!transient||attempt===2||page.isClosed())throw error;
        await page.waitForLoadState('domcontentloaded',{timeout:5000}).catch(()=>{});
        await page.waitForTimeout(150);
      } finally {page.off('framenavigated',onNavigation);}
    }
    throw new Error('Page did not settle for observation.');
  }
  private async observeOnce(): Promise<Snapshot> {
    if (this.page.isClosed()) {
      const available = [...this.pages.values()].find(p => !p.isClosed());
      if (!available) throw new Error('All task tabs are closed.');
      this.page = available;
    }
    this.frameRefs.clear();
    const frames: FrameState[] = [];
    const limitations: string[] = [];
    if (this.dialogMessage) { limitations.push(this.dialogMessage); this.dialogMessage = null; }
    const assign = (frame: Frame) => {
      let id = this.frameIds.get(frame);
      if (!id) { id = `frame-${++this.counter}`; this.frameIds.set(frame,id); }
      this.frameRefs.set(id, frame); return id;
    };
    for (const frame of this.page.frames()) assign(frame);
    for (const frame of this.page.frames()) {
      const id = assign(frame), parentFrame = frame.parentFrame();
      try {
        await frame.evaluate(this.script);
        const state = await frame.evaluate(({ id }) => (window as any).__jevCollector.collect(id), { id });
        let host: string | undefined;
        if (parentFrame) {
          const element = await frame.frameElement();
          host = await element.evaluate(e => (window as any).__jevCollector?.identify(e));
          await element.dispose();
          if (host && state.nodes[0]) state.nodes[0].parent = host;
        }
        frames.push({ ...state, id, parent: parentFrame ? assign(parentFrame) : null, host });
      } catch(error) {
        if(!parentFrame) throw new Error(`Main document could not be observed: ${error instanceof Error?error.message:'collector failed'}`);
        limitations.push(`Frame ${id} could not be observed (detached, navigating or inaccessible).`);
      }
    }
    const tabs = await Promise.all([...this.pages].filter(([,p]) => !p.isClosed()).map(async ([id,p]) => ({ id, url:p.url(), title:await p.title().catch(() => ''), active:p===this.page })));
    const nodes: UINode[] = frames.flatMap(f => f.nodes);
    limitations.push(...frames.flatMap(f => f.limitations));
    const url = this.page.url(), title = await this.page.title();
    // Cosmetic animation and timestamps do not invalidate semantic decisions.
    const semantics = nodes.map(({ bounds, ...n }) => n);
    return { version:digest({url, semantics, tabs}), observedAt:new Date().toISOString(), pageId:this.pageIds.get(this.page)!,
      url, title, tabs, frames, nodes, limitations };
  }
  async act(action: Action, observed: Snapshot, text?: string):Promise<void|{target:string;rebound:boolean}> {
    const current = await this.observe();
    const validated=validateAction(action,observed,current);
    if (action.op === 'wait') { await this.page.waitForTimeout(350); return; }
    if (action.op === 'switch_tab') {
      const p = this.pages.get(action.argument!);
      if (!p || p.isClosed()) throw new StaleObservation('Tab is no longer available.');
      this.page = p; return;
    }
    if (action.op === 'back') { await this.page.goBack({waitUntil:'domcontentloaded', timeout:10000}); return; }
    const node = validated;
    if (!node) throw new StaleObservation('Observed node is no longer available.');
    const capability = action.op === 'reveal' ? null : action.op;
    if (capability && !node.capabilities.includes(capability)) throw new Error('Operation is not supported by this observed node.');
    const frame = this.frameRefs.get(node.frame)!;
    const handle = await frame.evaluateHandle(id => (window as any).__jevCollector.resolve(id), node.id);
    const element = handle.asElement() as ElementHandle<HTMLElement> | null;
    if (!element) { await handle.dispose(); throw new StaleObservation('Element was detached.'); }
    try {
      switch (action.op) {
        case 'click': await element.click({noWaitAfter:true}); break;
        case 'hover': await element.hover(); break;
        case 'fill_secret':
          if (!node.states.sensitive) throw new Error('Private input requires a sensitive field.');
          if (typeof text !== 'string') throw new Error('Private input required.');
          try { await element.fill(text); } catch { throw new Error('Private input result is uncertain. Inspect the browser before continuing.'); }
          break;
        case 'fill':
          if (typeof text !== 'string') throw new Error('A supplied text value is required.');
          await element.fill(text); break;
        case 'select': {
          const option = node.options?.find(o=>o.index===Number(action.argument)&&!o.disabled);
          if(!option) throw new StaleObservation('Observed option is no longer available.');
          await element.selectOption({ value: option.value }); break;
        }
        case 'set_checked':
          if (node.tag === 'input') await element.setChecked(action.argument === 'true');
          else if (String(node.states.checked) !== action.argument) await element.click({noWaitAfter:true});
          break;
        case 'press':
          if (!['Enter','Tab','Escape','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Space'].includes(action.argument!)) throw new Error('Unsupported key.');
          await element.press(action.argument!); break;
        case 'reveal': await element.scrollIntoViewIfNeeded(); break;
        case 'scroll':
          await element.evaluate((e, direction) => {
            const s = e === document.documentElement ? document.scrollingElement! : e;
            const amount = Math.max(200, (direction==='left'||direction==='right' ? s.clientWidth : s.clientHeight)*0.75);
            s.scrollBy({ left:direction==='left'?-amount:direction==='right'?amount:0,
              top:direction==='up'?-amount:direction==='down'?amount:0, behavior:'instant' });
          }, action.argument); break;
        default: throw new Error('Unsupported operation.');
      }
    } finally { await handle.dispose(); }
    await this.page.waitForTimeout(100);
    return {target:node.id,rebound:node.id!==action.target};
  }
  async close() {
    if (this.attached) for (const page of this.pages.values()) {if(!this.userPages.has(page))await page.close().catch(() => {});}
    else await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}
