import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
export const exec = promisify(execFile);
export const ROOT = path.resolve(import.meta.dirname, '..');
/**
 * Frozen extension treatment. Round 1 ran `4c8e7d4`. Tier 1 repins through
 * BENCH_PIN so the baseline and the intervention are both built from current
 * code; see docs/ab-search-plan.md "Pin decision".
 */
export const PIN = process.env.BENCH_PIN ?? '4c8e7d4d4ad34432dbf2ab5e9151daa155b45f2a';
/** Round 1 pinned Pi 0.86.1. Tier 1 pins whatever single version both conditions share. */
export const PI_VERSION = process.env.BENCH_PI_VERSION ?? '0.86.1';
export const ADDENDUM = 'Complete the task using the resources available in this workspace. Ground material factual claims in evidence you can inspect. If essential information is missing, say what is missing. Do not expose private data. Do not make persistent account changes or create recurring services.';
export const readJSON = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
export const sha = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex');
export function saveJSON(p: string, value: unknown) { fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p, JSON.stringify(value,null,2)+'\n', {mode:0o600}); }
export function random(seed: number) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export function schedule(spec: any) {
  const rng = random(spec.seed);
  const shuffle = <T>(xs:T[]) => { const a=[...xs]; for(let i=a.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a; };
  const primary = spec.primary_task_ids.map((id:string)=>spec.case_catalog.find((c:any)=>c.id===id));
  const pilots = spec.pilot.active_case_ids.map((id:string)=>spec.pilot.cases.find((c:any)=>c.id===id));
  if(primary.length!==12 || pilots.length!==3 || [...primary,...pilots].some(x=>!x)) throw Error('Selected case inventory mismatch');
  return ['pilot','primary'].flatMap(phase=>{
    const selected = phase==='pilot'?pilots:primary;
    const orders=shuffle<string[]>(selected.map((_:any,i:number)=>i%2===0?['E','C']:['C','E']));
    const blocks = [...new Set(selected.map((c:any)=>c.block??'pilot'))];
    const cases=blocks.flatMap(block=>shuffle(selected.filter((c:any)=>(c.block??'pilot')===block)));
    return cases.map((c:any,i:number)=>({pairId:`${phase}-${c.id}`,phase,caseId:c.id,order:orders[i],
      armCapMicro:c.per_arm_max_usd===0||c.id==='pilot-L'?0:phase==='pilot'?150000:250000,
      deadlineMs:c.per_arm_max_usd===0||c.id==='pilot-L'?120000:600000,
      prompt:c.prompt,...(c.followup_prompt?{followup_prompt:c.followup_prompt}:{})}));
  });
}
/**
 * Lock paths were recorded under the previous install account. Read the same
 * relative path from $HOME. The responses helper was not migrated into
 * ~/.local/bin; its hash-pinned copy is bench/baseline/parallel-research.
 */
export function resolveBenchPath(recorded: string): string {
  const home = process.env.HOME || os.homedir();
  const match = /^\/home\/([^/]+)\/(.+)$/.exec(recorded);
  if (!match || match[1] === path.basename(home)) return recorded;
  const relocated = path.join(home, match[2]);
  if (fs.existsSync(relocated)) return relocated;
  if (match[2] === '.local/bin/parallel-research') {
    const vendored = path.join(ROOT, 'bench/baseline/parallel-research');
    if (fs.existsSync(vendored)) return vendored;
  }
  return relocated;
}
export function verifyBaseline(lock:any) {
  const skillsRoot = resolveBenchPath(lock.skills_root);
  for(const [name, hash] of Object.entries(lock.files_sha256)) if(sha(fs.readFileSync(path.join(skillsRoot,name)))!==hash) throw Error(`Baseline changed: ${name}`);
  for(const item of [lock.responses_helper,{path:lock.shared_dependency.source,sha256:lock.shared_dependency.sha256}]) if(sha(fs.readFileSync(resolveBenchPath(item.path)))!==item.sha256) throw Error(`Baseline changed: ${item.path}`);
}
export function publicModelCatalog(provider:string, modelId:string, source:any) {
  const p=source.providers?.[provider];
  if(!p) return {providers:{}};
  // Deliberate whitelist: never carry apiKey commands, headers, or credentials.
  const model=p.models?.find((m:any)=>m.id===modelId);
  const cleanModel=model && Object.fromEntries(Object.entries(model).filter(([k])=>['id','name','api','baseUrl','reasoning','input','cost','contextWindow','maxTokens','compat','thinkingLevelMap'].includes(k)));
  const clean:any={};
  for(const key of ['baseUrl','api','compat']) if(p[key]!==undefined) clean[key]=p[key];
  if(cleanModel) clean.models=[cleanModel];
  if(p.modelOverrides?.[modelId]) clean.modelOverrides={[modelId]:p.modelOverrides[modelId]};
  return {providers:{[provider]:clean}};
}
export function jsonLines(p:string) { if(!fs.existsSync(p))return [];return fs.readFileSync(p,'utf8').split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean); }
