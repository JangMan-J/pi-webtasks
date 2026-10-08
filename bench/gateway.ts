import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {Readable,Transform} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';
import {pipeline} from 'node:stream/promises';
import {sha,readJSON} from './core.ts';

const LOCK=readJSON(path.join(import.meta.dirname,'prices.lock.json'));
const PHASES:Record<string,number>={gold:1000000,pilot:1000000,primary:6000000,replication:3000000,diagnostics:1000000,contingency:1000000};
export class Ledger {
 db:DatabaseSync;
 cap:number;
 phases:Record<string,number>;
 constructor(dbPath:string,options:{capMicro?:number,existingMicro?:number,phaseCaps?:Record<string,number>}={}) {
  fs.mkdirSync(path.dirname(dbPath),{recursive:true});this.db=new DatabaseSync(dbPath);this.cap=options.capMicro??13000000;this.phases=options.phaseCaps??PHASES;
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,pair_id TEXT,phase TEXT,arm TEXT,token_hash TEXT UNIQUE,cap INTEGER,active INTEGER,UNIQUE(pair_id,arm));
   CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,run_id TEXT,method TEXT,path TEXT,body TEXT,liability INTEGER,status TEXT,http_status INTEGER,error TEXT,at TEXT);
   CREATE TABLE IF NOT EXISTS owners(id TEXT PRIMARY KEY,run_id TEXT);
   CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);`);
  const config=JSON.stringify({cap:this.cap,phases:this.phases,existing:options.existingMicro??24000,priceHash:sha(JSON.stringify(LOCK))});
  const stored=this.db.prepare('SELECT value FROM settings WHERE key=?').get('config') as any;
  if(stored&&stored.value!==config)throw Error('Ledger configuration drift');
  if(!stored)this.db.prepare('INSERT INTO settings VALUES(?,?)').run('config',config);
 }
 tx<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 existing(){return JSON.parse((this.db.prepare('SELECT value FROM settings WHERE key=?').get('config') as any).value).existing;}
 totals(phase?:string) {
  const rows=this.db.prepare(`SELECT r.*,COALESCE(SUM(q.liability),0) spent FROM runs r LEFT JOIN requests q ON q.run_id=r.id GROUP BY r.id`).all() as any[];
  const selected=phase?rows.filter(r=>r.phase===phase):rows;
  const existing=!phase||phase==='contingency'?this.existing():0;
  const liabilityMicro=existing+selected.reduce((n,r)=>n+r.spent,0);
  const activeReservationMicro=selected.reduce((n,r)=>n+(r.active?Math.max(0,r.cap-r.spent):0),0);
  return {liabilityMicro,activeReservationMicro,committedMicro:liabilityMicro+activeReservationMicro};
 }
 registerPair({pairId,phase,armCapMicro}:{pairId:string,phase:string,armCapMicro:number}) {
  return this.tx(()=>{
   if(!Number.isSafeInteger(armCapMicro)||armCapMicro<0||!this.phases[phase])throw Error('Invalid pair reservation');
   if(this.totals().committedMicro+2*armCapMicro>this.cap||this.totals(phase).committedMicro+2*armCapMicro>this.phases[phase])throw Error('Pair exceeds phase or total cap');
   const out:any={};for(const arm of ['E','C']){const runId=`${pairId}-${arm}`;const token=crypto.randomBytes(32).toString('hex');this.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,1)').run(runId,pairId,phase,arm,sha(token),armCapMicro);out[arm]={runId,token};}return out;
  });
 }
 authenticate(token:string){const row=this.db.prepare('SELECT * FROM runs WHERE token_hash=? AND active=1').get(sha(token)) as any;if(!row)throw Error('Invalid or inactive run credential');return row.id as string;}
 owns(runId:string,id:string){return (this.db.prepare('SELECT run_id FROM owners WHERE id=?').get(id) as any)?.run_id===runId;}
 own(runId:string,id:string){if(!/^(trun_|tgrp_|tgroup_|resp_|response_)/.test(id))return;const old=this.db.prepare('SELECT run_id FROM owners WHERE id=?').get(id) as any;if(old&&old.run_id!==runId)throw Error('Upstream ID ownership conflict');this.db.prepare('INSERT OR IGNORE INTO owners VALUES(?,?)').run(id,runId);}
 capture(runId:string,value:any){if(!value||typeof value!=='object')return;for(const [k,v]of Object.entries(value)){if(['id','run_id','taskgroup_id','interaction_id','response_id'].includes(k)&&typeof v==='string')this.own(runId,v);else if(typeof v==='object')this.capture(runId,v);}}
 admit(runId:string,method:string,url:string,body:any,liability:number){
  return this.tx(()=>{
   const run=this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as any;
   const spent=(this.db.prepare('SELECT COALESCE(SUM(liability),0) n FROM requests WHERE run_id=?').get(runId) as any).n;
   if(!run?.active||!Number.isSafeInteger(liability)||liability<0||spent+liability>run.cap)throw Error('Run spending ceiling reached');
   const id=crypto.randomUUID();this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,runId,method,url,JSON.stringify(body??null),liability,'reserved',null,null,new Date().toISOString());
   if(this.totals().committedMicro>this.cap||this.totals(run.phase).committedMicro>this.phases[run.phase])throw Error('Spending invariant failed');return id;
  });
 }
 deny(runId:string,method:string,url:string,body:any,error:string){const id=crypto.randomUUID();this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,runId,method,url,JSON.stringify(body??null),0,'denied',403,error,new Date().toISOString());}
 complete(id:string,httpStatus:number|null,error?:string){this.db.prepare('UPDATE requests SET status=?,http_status=?,error=? WHERE id=?').run(error?'uncertain':'returned',httpStatus,error??null,id);}
 finishRun(runId:string){this.tx(()=>this.db.prepare('UPDATE runs SET active=0 WHERE id=?').run(runId));}
 requests(runId?:string){return this.db.prepare(`SELECT * FROM requests${runId?' WHERE run_id=?':''} ORDER BY at,id`).all(...(runId?[runId]:[])) as any[];}
 runStats(runId:string){const requests=this.requests(runId);return {parallelLiabilityMicro:requests.reduce((n,r)=>n+r.liability,0),requests};}
 stats(){return {...this.totals(),existingLiabilityMicro:this.existing(),capMicro:this.cap,phases:Object.fromEntries(Object.keys(this.phases).map(p=>[p,this.totals(p)])),requests:this.requests()};}
 close(){this.db.close();}
}
function keys(body:any,allowed:string[]){if(!body||typeof body!=='object'||Array.isArray(body))throw Error('Expected JSON object');for(const k of Object.keys(body))if(!allowed.includes(k))throw Error(`Unpriced or unsupported field: ${k}`);}
function boundedInt(v:any,defaultValue:number,max:number){const n=v??defaultValue;if(!Number.isSafeInteger(n)||n<1||n>max)throw Error('Unbounded request size');return n;}
function processor(p:any){if(typeof p!=='string')throw Error('Explicit processor required');const n=LOCK.taskMicro[p.replace(/-fast$/,'')];if(!Number.isSafeInteger(n))throw Error('Unpriced processor');return n as number;}
function own(ledger:Ledger,runId:string,id:any){if(typeof id!=='string'||!ledger.owns(runId,id))throw Error('Research ID is not owned by this run');}
function taskPrice(body:any,ledger:Ledger,runId:string){
 keys(body,['input','processor','task_spec','enable_events','metadata','source_policy','advanced_settings','betas','previous_interaction_id','memory_scope_key','mcp_servers','webhook']);
 if(body.webhook||body.memory_scope_key||body.mcp_servers?.length)throw Error('External webhook, memory scope or MCP outside benchmark boundary');
 if(body.previous_interaction_id)own(ledger,runId,body.previous_interaction_id);
 if(body.advanced_settings)keys(body.advanced_settings,['location']);
 return processor(body.processor);
}
/** Only documented, bounded prices can authorize the real credential. */
export function quote(method:string,raw:string,body:any,ledger:Ledger,runId:string):number {
 const u=new URL(raw,'http://gateway');const p=u.pathname;
 if(method!=='GET'&&u.search)throw Error('Unpriced query fields on create');
 // Existing SDK/CLI versions legitimately use either Search/Extract version.
 if(method==='POST'&&/^\/v1(?:beta)?\/search$/.test(p)){
  keys(body,['search_queries','objective','mode','max_results','max_chars_total','advanced_settings','excerpts','fetch_policy','source_policy','session_id','client_model']);
  if(body.advanced_settings)keys(body.advanced_settings,['max_results','location','source_policy','fetch_policy','excerpt_settings']);
  const mode=body.mode??'basic';const base=LOCK.searchMicro[mode];if(base===undefined)throw Error('Unpriced Search mode');
  const counts=[body.advanced_settings?.max_results,body.max_results].filter(x=>x!==undefined);
  const n=counts.length?Math.max(...counts.map(x=>boundedInt(x,10,10000))):10;return base+Math.max(0,n-10)*1000;
 }
 if(method==='POST'&&/^\/v1(?:beta)?\/extract$/.test(p)){
  keys(body,['urls','objective','search_queries','max_chars_total','advanced_settings','excerpts','full_content','fetch_policy','session_id','client_model']);
  if(body.advanced_settings)keys(body.advanced_settings,['full_content','fetch_policy','excerpt_settings']);
  if(!Array.isArray(body.urls)||body.urls.some((s:any)=>typeof s!=='string'))throw Error('URLs required');return boundedInt(body.urls.length,0,20)*LOCK.extractUrlMicro;
 }
 if(method==='POST'&&p==='/v1/responses'){
  keys(body,['model','input','reasoning','previous_response_id','instructions','tools','metadata','text','stream']);
  if(body.model!=='parallel')throw Error('Unpriced Responses model');
  if(body.reasoning)keys(body.reasoning,['effort']);const cost=LOCK.responsesMicro[body.reasoning?.effort??'medium'];if(cost===undefined)throw Error('Unpriced Responses effort');
  if(body.previous_response_id)own(ledger,runId,body.previous_response_id);
  if(body.tools)for(const t of body.tools){keys(t,['type','filters']);if(t.type!=='web_search')throw Error('Unsupported external tool');}
  return cost;
 }
 if(method==='POST'&&p==='/v1/tasks/runs')return taskPrice(body,ledger,runId);
 if(method==='POST'&&p==='/v1/tasks/groups'){keys(body,['metadata']);return 0;}
 const groupAdd=p.match(/^\/v1\/tasks\/groups\/([^/]+)\/runs$/);
 if(method==='POST'&&groupAdd){own(ledger,runId,groupAdd[1]);keys(body,['inputs','default_task_spec','betas']);if(!Array.isArray(body.inputs)||!body.inputs.length||body.inputs.length>100)throw Error('Bounded group inputs required');return body.inputs.reduce((n:number,b:any)=>n+taskPrice(b,ledger,runId),0);}
 if(method==='GET'){
  const task=p.match(/^\/v1\/tasks\/runs\/([^/]+)(?:\/(result|input|events))?$/);
  const group=p.match(/^\/v1\/tasks\/groups\/([^/]+)(?:\/(runs|events)(?:\/([^/]+))?)?$/);
  if(task||group){const id=task?.[1]??group![1];own(ledger,runId,id);if(group?.[3])own(ledger,runId,group[3]);
   for(const k of u.searchParams.keys())if(!['timeout','last_event_id','include_input','include_output','status'].includes(k))throw Error(`Unpriced query field: ${k}`);
   return 0;
  }
 }
 throw Error(`Endpoint is outside this benchmark's priced boundary: ${method} ${p}`);
}
export function createGateway(options:{dbPath:string,apiKey:string,upstream?:string,fetchImpl?:typeof fetch,ledgerOptions?:ConstructorParameters<typeof Ledger>[1]}) {
 if(!options.apiKey)throw Error('Host research credential is empty');
 const ledger=new Ledger(options.dbPath,options.ledgerOptions);const requestFetch=options.fetchImpl??fetch;
 const server=createServer(async(req,res)=>{
  let runId='',requestId:string|undefined,body:any;const method=req.method??'GET',url=req.url??'/';
  try {
   const token=String(req.headers['x-api-key']??req.headers.authorization?.replace(/^Bearer\s+/i,'')??'');runId=ledger.authenticate(token);
   const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>2000000)throw Error('Request body too large');chunks.push(chunk);}
   const raw=Buffer.concat(chunks);body=raw.length?JSON.parse(raw.toString()):undefined;
   const liability=quote(method,url,body,ledger,runId);requestId=ledger.admit(runId,method,url,body,liability);
   const headers:Record<string,string>={'content-type':'application/json','x-api-key':options.apiKey,Authorization:`Bearer ${options.apiKey}`};
   // Forward only protocol fields. No caller Host, proxy, cookie or real-key echo.
   for(const h of ['parallel-beta','accept','last-event-id'])if(typeof req.headers[h]==='string')headers[h]=req.headers[h];
   const upstream=await requestFetch((options.upstream??'https://api.parallel.ai')+url,{method,headers,body:raw.length?raw:undefined,redirect:'error',signal:AbortSignal.timeout(650000)});
   res.statusCode=upstream.status;res.setHeader('content-type',upstream.headers.get('content-type')??'application/json');
   const contentType=upstream.headers.get('content-type')??'';
   if(contentType.includes('text/event-stream')&&upstream.body){
    let pending='',tail='';const decoder=new StringDecoder('utf8');
    const filter=new Transform({transform(chunk,_enc,done){
     tail+=decoder.write(chunk);
     // Keep a possible key prefix across chunk boundaries; redact complete keys first.
     tail=tail.split(options.apiKey).join('[REDACTED]');
     let keep=0;for(let n=1;n<options.apiKey.length&&n<=tail.length;n++)if(tail.endsWith(options.apiKey.slice(0,n)))keep=n;
     const cut=tail.length-keep;this.push(tail.slice(0,cut));tail=tail.slice(cut);done();
    },flush(done){this.push((tail+decoder.end()).split(options.apiKey).join('[REDACTED]'));done();}});
    const stream=Readable.fromWeb(upstream.body as any);
    stream.on('data',(chunk:Buffer)=>{pending+=chunk.toString();let i;while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);if(line.startsWith('data:')){try{ledger.capture(runId,JSON.parse(line.slice(5)));}catch{}}}});
    await pipeline(stream,filter,res);
   }else{
    const text=await upstream.text();try{ledger.capture(runId,JSON.parse(text));}catch{}
    // A provider must not echo the host secret into worker-visible output.
    res.end(text.split(options.apiKey).join('[REDACTED]'));
   }
   ledger.complete(requestId,upstream.status);
  }catch(e){
   const error=e instanceof Error?e.message:String(e);
   if(requestId)ledger.complete(requestId,null,error);else if(runId)ledger.deny(runId,method,url,body,error);
   if(!res.headersSent){res.writeHead(requestId?502:403,{'content-type':'application/json'});res.end(JSON.stringify({error:requestId?'Upstream failure; original liability retained':error}));}else res.destroy();
  }
 });
 return {server,ledger};
}
