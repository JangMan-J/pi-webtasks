import fs from 'node:fs';
import path from 'node:path';
import {once} from 'node:events';
import {ROOT,exec,readJSON,saveJSON,sha,jsonLines} from './core.ts';
import {initWorkspace,launch,stageObserver,sanitize} from './sandbox.ts';
import {withCredentials} from './auth.ts';
import {createGateway} from './gateway.ts';

function checkFrozen(m:any) {
 for(const [file,hash] of Object.entries(m.hashes))if(sha(fs.readFileSync(path.join(ROOT,file)))!==hash)throw Error(`Frozen input changed: ${file}`);
 const preflight=readJSON(path.join(ROOT,'.pi/benchmark/preflight.json'));
 if(!preflight.passed||preflight.manifestHash!==sha(fs.readFileSync(path.join(ROOT,'bench/manifest.json'))))throw Error('Run current preflight after freezing');
}
export async function run(phase:'pilot'|'primary') {
 const manifest=readJSON(path.join(ROOT,'bench/manifest.json'));checkFrozen(manifest);
 const setup=readJSON(path.join(manifest.runtime,'setup.json'));stageObserver(setup);
 const data=path.join(ROOT,'.pi/benchmark/data');fs.mkdirSync(data,{recursive:true,mode:0o700});
 // Exclusive runner ownership prevents overlapping timed workers or ledger instances.
 const lock=path.join(data,'runner.lock');const fd=fs.openSync(lock,'wx',0o600);fs.writeSync(fd,String(process.pid));
 let gateway:any;
 try {
  if(phase==='primary'){
   const gate=readJSON(path.join(data,'pilot-acceptance.json'));
   if(!gate.passed)throw Error('Pilot instrumentation acceptance is missing');
  }
  const {stdout}=await exec('secretspec',['get','PIPARA_API_KEY','--caller','pi-parallelized','--reason','User-authorized reduced benchmark with pre-dispatch Parallel spending limits'],{maxBuffer:100000});
  gateway=createGateway({dbPath:path.join(data,'liability.sqlite'),apiKey:stdout.trim()});
  gateway.server.listen(0,'0.0.0.0');await once(gateway.server,'listening');
  const port=gateway.server.address().port;const base=`http://host.containers.internal:${port}`;
  const gold=readJSON(path.join(ROOT,'bench/gold.json'));
  for(const pair of manifest.pairs.filter((p:any)=>p.phase===phase)) {
   const pairDir=path.join(data,pair.pairId);
   if(fs.existsSync(path.join(pairDir,'pair.json')))throw Error(`Pair already attempted: ${pair.pairId}; no automatic reruns`);
   fs.mkdirSync(pairDir,{recursive:true,mode:0o700});saveJSON(path.join(pairDir,'pair.json'),{...pair,manifestHash:sha(fs.readFileSync(path.join(ROOT,'bench/manifest.json'))),startedAt:new Date().toISOString()});
   const reservations=gateway.ledger.registerPair({pairId:pair.pairId,phase:pair.phase,armCapMicro:pair.armCapMicro});
   for(const arm of pair.order) {
    const identity=reservations[arm];const runId=identity.runId;
    const out=path.join(pairDir,arm);const work=path.join(out,'work');fs.mkdirSync(out,{recursive:true});
    initWorkspace(setup,work,path.join(ROOT,'bench/fixtures',pair.caseId));
    const envFile=path.join(out,'research.env');
    fs.writeFileSync(envFile,[`PIPARA_API_KEY=${identity.token}`,`PARALLEL_API_KEY=${identity.token}`,`PARALLEL_BASE_URL=${base}`,`PARALLEL_API_URL=${base}`,`PARALLEL_PLATFORM_URL=${base}/denied/platform`,`PARALLEL_SERVICE_API_URL=${base}/denied/account`,'PIPARA_LAZY_TOOLS=0'].join('\n')+'\n',{mode:0o600});
    saveJSON(path.join(out,'run-start.json'),{runId,caseId:pair.caseId,pairId:pair.pairId,arm,phase,startedAt:new Date().toISOString()});
    let processResult:any;let harnessError:string|undefined;
    try {
     processResult=await withCredentials(setup,work,()=>launch(setup,arm,work,runId,envFile,[pair.prompt,...(pair.followup_prompt?[pair.followup_prompt]:[])],pair.deadlineMs,out));
    }catch(e){harnessError=e instanceof Error?e.message:String(e);}
    finally{fs.rmSync(envFile,{force:true});gateway.ledger.finishRun(runId);}
    const events=jsonLines(path.join(work,'events.jsonl'));
    const stream=jsonLines(path.join(out,'stdout.jsonl'));
    const assistants=stream.filter(e=>e.type==='message_end'&&e.message?.role==='assistant').map(e=>e.message);
    const answers=assistants.filter(m=>m.stopReason!=='toolUse').map(m=>m.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n')).filter(Boolean);
    const usage=assistants.reduce((a,m)=>{for(const k of ['input','cacheRead','cacheWrite','output'])a[k]+=m.usage?.[k]??0;return a;},{input:0,cacheRead:0,cacheWrite:0,output:0});
    const started=events.find(e=>e.type==='prompt_audit');
    const finished=[...events].reverse().find(e=>e.type==='run_end');
    const timestamp=(e:any)=>e?.mono??Date.parse(e?.ts??'');
    const elapsed=timestamp(finished)-timestamp(started);
    const limited=events.some(e=>['limit','limit_stop','guard_stop'].includes(e.type));
    const auditFail=!events.some(e=>e.type==='prompt_audit')||events.some(e=>e.type==='prompt_audit'&&e.ok!==true);
    const last=assistants.at(-1);
    const status=harnessError?'harness_error':processResult?.timedOut?'timeout':auditFail?'audit_failed':limited?'limit':processResult?.code!==0||['error','aborted'].includes(last?.stopReason)||!answers.length||events.filter(e=>e.type==='run_end').length!==(pair.followup_prompt?2:1)?'failed':'completed';
    const packet=gold.cases?.[pair.caseId]??gold[ pair.caseId]??gold.cases?.find?.((c:any)=>c.id===pair.caseId);
    const accounting=gateway.ledger.runStats(runId);
    for(const q of accounting.requests)events.push({id:`${runId}:gateway:${q.id}`,type:q.status==='denied'?'gateway_denial':'gateway_request',ts:q.at,method:q.method,path:q.path,body:JSON.parse(q.body),liabilityMicro:q.liability,status:q.status,httpStatus:q.http_status,error:q.error});
    events.sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts));
    answers.forEach((text,index)=>events.push({id:`${runId}:answer:${index+1}`,type:'answer',index:index+1,text}));
    const run={runId,parallelLiabilityMicro:accounting.parallelLiabilityMicro,pairId:pair.pairId,caseId:pair.caseId,phase,arm,model:setup.model,status,elapsedMs:Number.isFinite(elapsed)?elapsed:processResult?.processElapsedMs??pair.deadlineMs,deadlineMs:pair.deadlineMs,processElapsedMs:processResult?.processElapsedMs,usage,sourceFamily:packet?.sourceFamily??pair.caseId,answer:answers.join('\n\n--- FOLLOW-UP ---\n\n'),answers,events:sanitize(events),harnessError,manifestHash:sha(fs.readFileSync(path.join(ROOT,'bench/manifest.json')))};
    saveJSON(path.join(out,'run.json'),run);
    console.log(JSON.stringify({pair:pair.pairId,arm,status,elapsedMs:run.elapsedMs,tokens:Object.values(usage).reduce((a:number,b:any)=>a+b,0)}));
    if(auditFail||harnessError)throw Error(`Harness gate failed in ${pair.pairId}/${arm}; original attempt retained`);
   }
  }
 } finally {
  if(gateway){await new Promise<void>(r=>gateway.server.close(()=>r()));saveJSON(path.join(data,'ledger.json'),gateway.ledger.stats());gateway.ledger.close();}
  fs.closeSync(fd);fs.rmSync(lock,{force:true});
 }
}
if(process.argv[1]===import.meta.filename){const phase=process.argv[2];if(phase!=='pilot'&&phase!=='primary')throw Error('Usage: node bench/run.ts pilot | primary');await run(phase);}
