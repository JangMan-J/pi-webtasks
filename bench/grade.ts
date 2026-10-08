import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
function invoke(args:string[],cwd:string):Promise<{stdout:string}> {
 return new Promise((resolve,reject)=>{
  const child=execFile('node',args,{cwd,timeout:240000,maxBuffer:8e6,encoding:'utf8'},(error,stdout)=>error?reject(error):resolve({stdout}));
  // Pi reads piped stdin until EOF even when a positional prompt is present.
  child.stdin?.end();
 });
}
import {ROOT,exec,readJSON,saveJSON,sha} from './core.ts';
import {buildRaterInput,validateScore,buildAdjudicationQueue,normalizeGold} from './score.ts';

const DATA=path.join(ROOT,'.pi/benchmark/data');
export function loadRuns(phase?:string):any[] {
 const runs:any[]=[];
 if(!fs.existsSync(DATA))return runs;
 for(const dir of fs.readdirSync(DATA,{withFileTypes:true}).filter(e=>e.isDirectory()))for(const arm of ['E','C']){
  const file=path.join(DATA,dir.name,arm,'run.json');
  if(fs.existsSync(file)){const r=readJSON(file);if(!phase||r.phase===phase)runs.push(r);}
 }
 return runs.sort((a,b)=>a.runId.localeCompare(b.runId));
}
const INSTRUCTIONS=`You are an independent benchmark rater. Use only the supplied frozen gold and observable events. No outside tools or knowledge are needed. Return one JSON object matching the supplied schema, no Markdown fence.
Score retrieval 0..2: 2 suitable first evidence path, correct local/web boundary, no needless paid duplicate; 1 recoverable detour then suitable path; 0 unresolved misuse, fabricated support, prohibited disclosure or retrieval against an explicit constraint. Direct public HTTP and shared documentation tools are equally valid; a package-specific call is not mandatory. Skill reads and CLI help are preparation overhead, not automatically a retrieval misuse. An authoritative local check establishing a missing EXTERNAL fact is one whiff; a second redundant local check is delay. Missing user intent instead requires targeted clarification.
Quality 0..4, one point each: correct conclusion or targeted clarification; required-claim/constraint coverage; traceable evidence actually inspected in THIS run; version/date/conflict/uncertainty handling. A right answer without inspected evidence cannot receive evidence credit. For local-only tasks, workspace evidence counts fully. Unsupported exact days when gold supports only an approximate month should be flagged. A fabricated material citation or material wrong conclusion prevents successful resolution regardless of point total. Record every material penalty and each awarded quality point in metadata.evidence as {criterion, outcome: "awarded" or "penalty", eventIds: [actual IDs], note}. Use criterion names retrieval, quality.conclusion, quality.coverage, quality.support, quality.uncertainty and the exact violation flag names. All IDs must exist. Include overall evidenceEventIds and supportedClaims bounded by gold.requiredClaims.length. Observe follow-up instructions too.
Metadata must also include: firstExternalEventId (null if none), firstParallelEventId (null if none), opportunityEventId (null if task-dispatch is the opportunity), parallelOpportunityEventId (null unless an observed unresolved external gap specifically required Parallel after other available evidence), redundantLocalChecks (integer), preparationActions (integer), duplicatePaidCalls (integer), sourceAttribution (Parallel/Context7/other_public/local/mixed/none), parallelSupportedClaims (integer), claimSupport (array of {claimId, supported, evidenceEventIds, service}), and limitations (string). A source in the gold is not evidence that the agent read it. Don't infer unseen network traffic from an absent gateway entry. Notes should be concise and cite decisive event IDs. Exact signatures/tool names may expose treatment despite anonymization; don't reward either treatment.`;

export async function grade(phase:string,reconcile=false) {
 const setup=readJSON(path.join(ROOT,'.pi/benchmark/runtime/setup.json'));
 const runs=loadRuns(phase);if(!runs.length)throw Error('No runs to grade');
 const gold=readJSON(path.join(ROOT,'bench/gold.json')).cases;
 const spec=readJSON(path.join(ROOT,'docs/benchmark-cases.json'));
 const cases=[...spec.case_catalog,...spec.pilot.cases];
 const out=path.join(DATA,'grading',phase);fs.mkdirSync(out,{recursive:true,mode:0o700});
 const schema=readJSON(path.join(ROOT,'bench/scoring-schema.json'));
 const priorPath=path.join(out,'adjudication.json');
 const prior=reconcile?readJSON(priorPath):null;
 const disputed=new Set(prior?.queue.map((q:any)=>q.runId)??[]);
 const round=reconcile?'.round2':'';
 const reverse:any={};
 const packets=runs.map(run=>{
  const opaque='r-'+sha(run.runId).slice(0,14);reverse[opaque]=run.runId;
  const retained=run.events.filter((e:any)=>['tool_call','tool_execution_end','answer','guard_stop','gateway_request','gateway_denial'].includes(e.type));
  const dispatch=run.events.find((e:any)=>e.type==='prompt_audit');
  if(dispatch)retained.unshift({id:dispatch.id,type:'task_dispatch',ts:dispatch.ts});
  const blind={...run,runId:opaque,events:retained.map((e:any)=>{const {arm,run:_,...rest}=e;return {...rest,id:e.id.split(run.runId).join(opaque)};})};
  const c=cases.find((c:any)=>c.id===run.caseId);
  const input=buildRaterInput(blind,normalizeGold({cases:gold},run.caseId),{prompt:c.prompt+(c.followup_prompt?'\n\nFOLLOW-UP: '+c.followup_prompt:'')});
  return {blind,original:run,input:{...input,schema,runStatus:run.status}};
 });
 saveJSON(path.join(out,'mapping.json'),reverse);
 const raters=[{name:'grok',provider:'xai',model:'grok-4.6'},{name:'gpt',provider:'openai-codex',model:'gpt-5.5'}];
 await Promise.all(raters.map(async rater=>{
  for(const packet of packets) {
   if(reconcile&&!disputed.has(packet.original.runId))continue;
   const dest=path.join(out,`${packet.blind.runId}${round}.${rater.name}.json`);if(fs.existsSync(dest))continue;
   const dispute=prior?.queue.find((q:any)=>q.runId===packet.original.runId);
   const comparison=dispute?'\n\nSecond independent comparison: examine both prior judgments against the events. Keep or revise your score based on evidence, not compromise. If the other judgment is wrong, explain why.\n'+JSON.stringify(dispute).split(packet.original.runId).join(packet.blind.runId):'';
   const prompt=INSTRUCTIONS+'\n\n'+JSON.stringify(packet.input)+comparison;
   const request=path.join(out,`${packet.blind.runId}.input.json`);saveJSON(request,packet.input);
   const promptFile=path.join(out,`${packet.blind.runId}${round}.${rater.name}.prompt.txt`);fs.writeFileSync(promptFile,prompt,{mode:0o600});
   let stdout:string;
   try {
    ({stdout}=await invoke([path.join(setup.piRoot,'dist/cli.js'),'--provider',rater.provider,'--model',rater.model,'--thinking','low','--print','--mode','json','--no-session','--no-tools','--no-context-files','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--offline','--','@'+promptFile],out));
   }catch(e){saveJSON(dest+'.error.json',{provider:rater.provider,error:(e as Error).message.slice(0,500)});continue;}
   const records=stdout.split('\n').filter(Boolean).flatMap(s=>{try{return [JSON.parse(s)];}catch{return [];}});
   const msg=records.filter(e=>e.type==='message_end'&&e.message?.role==='assistant').at(-1)?.message;
   const text=msg?.content?.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n')??'';
   fs.writeFileSync(dest+'.txt',text,{mode:0o600});
   let score:any;try{score=JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));}catch{saveJSON(dest+'.error.json',{error:'Non-JSON rater output'});continue;}
   const errors=validateScore(score,packet.blind);
   if(score.supportedClaims>gold[packet.original.caseId].requiredClaims.length)errors.push('supportedClaims exceeds gold count');
   if(errors.length){saveJSON(dest+'.error.json',{errors,score});continue;}
   // Restore dataset IDs only after blind validation.
   const restored=JSON.parse(JSON.stringify(score).split(packet.blind.runId).join(packet.original.runId));
   saveJSON(dest,{score:restored,rater,usage:msg.usage,inputHash:sha(prompt)});
   console.log(JSON.stringify({phase,rater:rater.name,caseId:packet.original.caseId,graded:true}));
  }
 }));
 const paired=packets.flatMap(p=>{
  const selectedRound=reconcile&&disputed.has(p.original.runId)?'.round2':'';
  const a=path.join(out,`${p.blind.runId}${selectedRound}.grok.json`),b=path.join(out,`${p.blind.runId}${selectedRound}.gpt.json`);
  return fs.existsSync(a)&&fs.existsSync(b)?[{a:readJSON(a).score,b:readJSON(b).score}]:[];
 });
 const queue=buildAdjudicationQueue(paired);
 const agreed=paired.filter(p=>queue.agreedRunIds.includes(p.a.runId)).map(p=>({...p.a,metadata:{...p.a.metadata,secondRater:p.b}}));
 if(reconcile)saveJSON(path.join(out,'adjudication.round1.json'),prior);
 saveJSON(path.join(out,'adjudication.json'),{...queue,round:reconcile?2:1});saveJSON(path.join(out,'agreed-scores.json'),agreed);
 console.log(JSON.stringify({phase,agreementRate:queue.agreementRate,disagreements:queue.queue.length,missingRaterPairs:runs.length-paired.length}));
}
if(process.argv[1]===import.meta.filename){const phase=process.argv[2];if(!['pilot','primary'].includes(phase))throw Error('Usage: node bench/grade.ts pilot | primary');await grade(phase,process.argv.includes('--reconcile'));}
