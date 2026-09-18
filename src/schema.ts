import { z } from 'zod';

export function defaultConfidence() {
  const value=process.env.JEV_MIN_CONFIDENCE?.trim();
  const threshold=value?Number(value):0.55;
  if(!Number.isFinite(threshold)||threshold<0||threshold>1) throw new Error('JEV_MIN_CONFIDENCE must be between 0 and 1.');
  return threshold;
}
export const TaskInput = z.object({
  goal: z.string().min(1).max(8000),
  url: z.string().url(),
  browser: z.enum(['isolated','extension']).default('extension'),
  plan: z.array(z.string().min(1).max(600)).max(12).default([]),
  values: z.array(z.object({ label: z.string().min(1).max(200), text: z.string().max(4000) })).max(50).default([]),
  checks: z.array(z.object({
    kind: z.enum(['url_contains', 'text_contains', 'field_equals', 'collected_count']),
    value: z.string().min(1).max(2000), name: z.string().max(500).optional()
  }).refine(c=>c.kind!=='field_equals'||!!c.name,'field_equals needs a field name')
    .refine(c=>c.kind!=='collected_count'||(/^[1-9]\d*$/.test(c.value)),'collected_count needs a positive integer')).max(30).default([]),
  maxSteps: z.number().int().min(1).max(300).default(60),
  maxSeconds: z.number().int().min(10).max(3600).default(300),
  minConfidence: z.number().min(0).max(1).default(defaultConfidence),
  headless: z.boolean().default(false)
}).strict();
export type TaskInput = z.infer<typeof TaskInput>;
// Values are accepted only at the request boundary, never as part of a persisted TaskRecord.
export const SecretInput = z.object({label:z.string().min(1).max(200),text:z.string().min(1).max(4000),
  origin:z.string().url().refine(value=>{try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash;}catch{return false;}},'Use an exact HTTP(S) origin')}).strict();
export const TaskRequest = TaskInput.extend({secrets:z.array(SecretInput).max(20).optional()});
export type TaskRequest = z.infer<typeof TaskRequest>;
export interface SecretDescriptor { id:string; label:string; origin:string }


export interface UINode {
  id: string; parent: string | null; frame: string; role: string; name: string; text: string;
  tag: string; source: 'semantic' | 'layout';
  value?: string; href?: string; inputType?: string; autocomplete?: string;
  states: { disabled: boolean; readonly: boolean; checked?: boolean | 'mixed'; expanded?: boolean;
    selected?: boolean; required?: boolean; invalid?: boolean; sensitive?: boolean; filled?: boolean; busy?: boolean };
  relations: Record<string, string[]>;
  bounds: { x: number; y: number; width: number; height: number };
  inViewport: boolean; obscured: boolean;
  scroll?: { x: number; y: number; maxX: number; maxY: number };
  options?: { index: number; label: string; value: string; disabled: boolean; selected: boolean }[];
  capabilities: string[];
}
export interface FrameState {
  id: string; parent: string | null; host?: string; url: string; title: string; document: string;
  nodes: UINode[]; limitations: string[]; scanned: number; truncated: boolean;
}
export interface Snapshot {
  version: string; observedAt: string; pageId: string; url: string; title: string;
  tabs: { id: string; url: string; title: string; active: boolean }[];
  frames: FrameState[]; nodes: UINode[]; limitations: string[];
}
export interface Action {
  id: string; op: string; label: string; target?: string; argument?: string;
}
export interface Projection {
  version: string; page: { url: string; title: string }; tabs: Snapshot['tabs'];
  regions: { id: string; role: string; name: string; nodes: number }[];
  nodes: UINode[]; actions: Action[];
  coverage: { total: number; included: number; page: number; pages: number; limitations: string[] };
}
export interface Decision {
  action: Action; confidence: number | null; probabilities: Record<string, number>;
  latencyMs: number; usage: { inputTokens: number; cost: number | null };
}
export interface Evidence {
  id: string; url: string; title: string; observedAt: string; snapshot: string;
  nodes: Pick<UINode, 'id' | 'parent' | 'role' | 'name' | 'text' | 'value' | 'href'>[];
}
export type Status = 'running' | 'paused' | 'needs_input' | 'needs_review' | 'completed' | 'failed' | 'cancelled';
export interface PageLocation { tab: string; url: string; title: string }
export interface BrowserMemory {
  session: number;
  tabs: { id:string; session:number; nativeId:string; url:string; title:string; open:boolean; visited:boolean;
    firstSeen:string; lastSeen:string; lastVisited?:string; recentUrls:string[]; lastAction?:{step:number;op:string;label:string} }[];
  current?:PageLocation;
  navigations: { from?:PageLocation; to:PageLocation; at:string; observedAfterStep?:number; source:string }[];
  omittedNavigations:number;
}
export interface StepContext {
  from:PageLocation; to?:PageLocation;
  target?:{role:string;name:string;href?:string;frameUrl?:string};
  parameter?:string; requestedText?:string; enteredText?:string;
  observed?:{pageChanged:boolean;tabChanged:boolean;structureChanged:boolean;openedTabs:string[];closedTabs:string[];
    field?:{before?:string;after?:string;checkedBefore?:boolean|'mixed';checkedAfter?:boolean|'mixed'}};
}
export interface TaskRecord {
  id: string; input: TaskInput; status: Status; createdAt: string; updatedAt: string;
  steps: number; requests: number; elapsedMs: number; cost: number; inputTokens: number;
  history: { step: number; op: string; target?: string; label: string; url: string; version: string;
    outcome: string; confidence?: number | null; at: string; context?:StepContext }[];
  browserMemory?:BrowserMemory;
  evidence: Evidence[]; snapshot?: Snapshot; projection?: Projection;
  message: string; pending?: { kind: 'text' | 'secret' | 'review' | 'blocked'; target?: string; version?: string; context: string };
  lastDecision?: { action: Action; confidence: number | null; threshold: number;
    alternatives: { action: Action; probability: number }[] };
  verification?: { passed: boolean; checks: { check: string; passed: boolean }[] };
}
