import { computeAccessibleName, computeAccessibleDescription, getRole } from 'dom-accessibility-api';
import type { UINode } from './schema.js';

// All facts are read from the browser. No site rules, model calls or generated selectors.
interface Registry { document: string; next: number; ids: WeakMap<Element, string>; refs: Map<string, Element>; sensitive: WeakSet<Element> }
const scope = window as unknown as { __jevUIv1?: Registry };
function registry(): Registry {
  const state = scope.__jevUIv1 ??= { document: crypto.randomUUID(), next: 0, ids: new WeakMap(), refs: new Map(), sensitive: new WeakSet() };
  state.sensitive ??= new WeakSet();
  return state;
}
export function identify(element: Element): string {
  const r = registry();
  let id = r.ids.get(element);
  if (!id) { id = `${r.document}:${++r.next}`; r.ids.set(element, id); }
  r.refs.set(id, element);
  return id;
}
export function resolve(id: string): Element | null {
  const e = registry().refs.get(id);
  return e?.isConnected ? e : null;
}
const clean = (text: string | null | undefined, max = 700) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const parentOf = (e: Element): Element | null => e.parentElement ?? (e.getRootNode() as ShadowRoot).host ?? null;
function hidden(e: Element): boolean {
  for (let p: Element | null = e; p; p = parentOf(p)) {
    if (p.hasAttribute('hidden') || p.getAttribute('aria-hidden') === 'true') return true;
    const css = getComputedStyle(p);
    if (css.display === 'none' || css.visibility === 'hidden' || css.opacity === '0') return true;
  }
  return false;
}
function inherited(e: Element, selector: string): boolean {
  for (let p: Element | null = e; p; p = parentOf(p)) if (p.matches(selector)) return true;
  return false;
}
export function collect(frame: string, limit = 4000) {
  const r = registry();
  for (const [id, e] of r.refs) if (!e.isConnected) r.refs.delete(id);
  const nodes: UINode[] = [], limitations: string[] = [];
  let scanned = 0, truncated = false;
  const stack: { e: Element; parent: string | null }[] = [{ e: document.documentElement, parent: null }];
  while (stack.length) {
    if (nodes.length >= limit || scanned >= limit * 5) { truncated = true; break; }
    const { e, parent } = stack.pop()!;
    scanned++;
    if (e.matches('script,style,noscript,template,head,input[type="hidden"]') || hidden(e)) continue;
    const h = e as HTMLElement, input = e as HTMLInputElement;
    const rect = e.getBoundingClientRect();
    const css = getComputedStyle(e);
    const root = e === document.documentElement;
    const scrollable = root || ((e.scrollHeight > e.clientHeight + 2 || e.scrollWidth > e.clientWidth + 2)
      && /auto|scroll/.test(css.overflow + css.overflowY + css.overflowX));
    const nativeRole = getRole(e);
    const isFrame = e.matches('iframe,frame');
    const isCanvas = e.tagName === 'CANVAS';
    const directText = clean([...e.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(' '));
    const layoutGroup = !nativeRole && e.children.length > 1;
    const editable = e.matches('input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="range"]):not([type="color"]),textarea,[contenteditable="true"]');
    const actionable = editable || e.matches('a[href],button,select,summary,input,[tabindex]')
      || ['button','link','checkbox','radio','switch','tab','menuitem','option','combobox','slider','treeitem','gridcell'].includes(nativeRole ?? '');
    const meaningful = root || nativeRole || directText || layoutGroup || scrollable || actionable || isFrame || isCanvas;
    let nextParent = parent;
    if (meaningful) {
      const id = identify(e); nextParent = id;
      const autocomplete = (e.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
      const sensitive = r.sensitive.has(e) || e.matches('input[type="password"],input[type="file"]')
        || autocomplete.some(token => ['current-password','new-password','one-time-code'].includes(token) || token.startsWith('cc-'));
      if (sensitive) r.sensitive.add(e); // Keep masking when a password visibility toggle changes type to text.
      const disabled = e.matches(':disabled') || inherited(e, '[inert],[aria-disabled="true"]');
      const readonly = !!input.readOnly || e.getAttribute('aria-readonly') === 'true';
      const role = root ? 'document' : isFrame ? 'frame' : isCanvas ? 'opaque' : nativeRole || (editable ? 'textbox' : layoutGroup || scrollable ? 'group' : 'text');
      let name = '';
      try { name = clean(computeAccessibleName(e), 400); } catch { /* Partial semantics remain explicit. */ }
      if (!name && e.matches('input,textarea')) name = clean(e.getAttribute('placeholder'), 400);
      const states: UINode['states'] = { disabled, readonly, sensitive, required: !!input.required,
        invalid: e.getAttribute('aria-invalid') === 'true' || (input.validity ? !input.validity.valid : false),
        busy: e.getAttribute('aria-busy') === 'true' };
      if (sensitive && editable) states.filled = !!input.value;
      if (e.matches('input[type="checkbox"],input[type="radio"]')) states.checked = input.indeterminate ? 'mixed' : input.checked;
      else if (e.hasAttribute('aria-checked')) states.checked = e.getAttribute('aria-checked') === 'mixed' ? 'mixed' : e.getAttribute('aria-checked') === 'true';
      for (const key of ['expanded', 'selected'] as const) if (e.hasAttribute(`aria-${key}`)) states[key] = e.getAttribute(`aria-${key}`) === 'true';
      const relations: Record<string, string[]> = {};
      for (const [attr, key] of [['aria-labelledby','labelledBy'],['aria-describedby','describedBy'],['aria-controls','controls'],['aria-owns','owns'],['aria-errormessage','errors']]) {
        const localRoot = e.getRootNode() as Document | ShadowRoot;
        const refs = (e.getAttribute(attr) || '').split(/\s+/).map(id => localRoot.getElementById(id)).filter((x): x is HTMLElement => !!x);
        if (refs.length) relations[key] = refs.map(identify);
      }
      if (input.labels?.length) relations.labelledBy = [...input.labels].map(identify);
      if (e instanceof HTMLLabelElement && e.control) relations.labels = [identify(e.control)];
      const inViewport = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      const x = Math.min(innerWidth - 1, Math.max(0, rect.x + rect.width / 2));
      const y = Math.min(innerHeight - 1, Math.max(0, rect.y + rect.height / 2));
      const hit = (e.getRootNode() as Document | ShadowRoot).elementFromPoint?.(x, y);
      const obscured = inViewport && !!hit && hit !== e && !e.contains(hit) && !hit.contains(e);
      const capabilities: string[] = [];
      if (!disabled && sensitive && editable && rect.width > 0 && rect.height > 0) {
        if (!readonly) capabilities.push('fill_secret');
        if (states.filled) capabilities.push('press');
      }
      if (!disabled && !sensitive && rect.width > 0 && rect.height > 0) {
        if (actionable && !e.matches('select')) capabilities.push('click', 'hover');
        if (editable && !readonly) capabilities.push('fill');
        if (e.matches('select') && !readonly) capabilities.push('select');
        if (states.checked !== undefined) capabilities.push('set_checked');
        if (actionable) capabilities.push('press');
      }
      const node: UINode = { id, parent, frame, tag: e.tagName.toLowerCase(), role, name,
        text: sensitive ? '' : directText, source: nativeRole || root || editable ? 'semantic' : 'layout', states, relations,
        bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        inViewport, obscured, capabilities };
      if (e instanceof HTMLInputElement) { node.inputType = input.type; node.autocomplete = autocomplete.join(' ') || undefined; }
      try { const d = clean(computeAccessibleDescription(e), 400); if (d) node.text = clean(`${node.text} ${d}`); } catch { /* Optional description. */ }
      if (!sensitive && ('value' in e || h.isContentEditable)) node.value = clean('value' in e ? String(input.value) : h.innerText, 2000);
      if (e instanceof HTMLAnchorElement && /^https?:/.test(e.href)) node.href = e.href;
      if (e instanceof HTMLSelectElement) node.options = [...e.options].map((o, index) => ({ index, label: clean(o.label), value: o.value,
        selected: o.selected, disabled: o.disabled || !!o.closest('optgroup[disabled]') }));
      if (scrollable) {
        const s = root ? document.scrollingElement! : e;
        node.scroll = { x: s.scrollLeft, y: s.scrollTop, maxX: Math.max(0, s.scrollWidth - s.clientWidth), maxY: Math.max(0, s.scrollHeight - s.clientHeight) };
        if (node.scroll.maxX || node.scroll.maxY) capabilities.push('scroll');
      }
      if (isCanvas) limitations.push(`Canvas ${id} has no readable DOM content; visual interpretation is not enabled.`);
      if (e.tagName.includes('-') && !e.shadowRoot && !e.children.length && !directText) limitations.push(`Custom element ${id} has no exposed child structure (possibly closed shadow DOM).`);
      nodes.push(node);
    }
    const children = [...e.children];
    if (e.shadowRoot) children.push(...e.shadowRoot.children);
    for (let i = children.length - 1; i >= 0; i--) stack.push({ e: children[i], parent: nextParent });
  }
  if (truncated) limitations.push(`Document collection reached the ${limit}-node / ${limit * 5}-scan budget; some content is unavailable.`);
  return { document: r.document, url: location.href, title: document.title, nodes, scanned, truncated, limitations };
}
