import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ROOT,ADDENDUM,exec,saveJSON} from './core.ts';

export function mounts(setup:any,work:string,arm:string,probe=false) {
  const rt=setup.runtime;
  const args=['--rm','--read-only','--cap-drop=all','--security-opt=no-new-privileges','-v',`${work}:/work:rw`,'-v',`${setup.piRoot}:/opt/pi:ro`,'-v',`${rt}/observer:/opt/bench:ro`];
  if(arm==='E')args.push('-v',`${rt}/extension:/opt/extension:ro`,'-v',`${rt}/resources/find-docs:/opt/resources/find-docs:ro`);
  else args.push('-v',`${rt}/resources:/opt/resources:ro`,'-v',`${rt}/helper:/opt/helper:ro`,'-v',`${rt}/bin:/opt/bench-bin:ro`);
  args.push('-e',`BENCH_ARM=${arm}`,'-e','HOME=/work/home','-e','PI_CODING_AGENT_DIR=/work/home/.pi/agent','-e','PI_OFFLINE=1','-e','NO_COLOR=1','-e','BENCH_EVENTS=/work/events.jsonl');
  if(arm==='C')args.push('-e','PATH=/opt/bench-bin:/opt/cli/bin:/opt/ctx7/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
  return args;
}
export function cliArgs(setup:any,arm:string,prompts:string[]) {
  return ['node','/opt/pi/dist/cli.js','--provider',setup.provider,'--model',setup.modelId,'--thinking',setup.thinking,'--mode','json','--print','--no-session','--no-context-files','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--offline','-e','/opt/bench/observer.ts',...(arm==='E'?['-e','/opt/extension/src/index.ts']:[]),'--skill',arm==='E'?'/opt/resources/find-docs':'/opt/resources','--append-system-prompt',ADDENDUM,'--',...prompts];
}
export function stageObserver(setup:any) {
  const dest=path.join(setup.runtime,'observer');fs.mkdirSync(dest,{recursive:true});
  for(const name of ['observer.ts','preflight-probe.mjs'])fs.copyFileSync(path.join(ROOT,'bench',name),path.join(dest,name));
}
export function initWorkspace(setup:any,work:string,fixture?:string) {
  fs.mkdirSync(work,{recursive:true,mode:0o700});
  if(fixture&&fs.existsSync(fixture))fs.cpSync(fixture,work,{recursive:true});
  const agent=path.join(work,'home/.pi/agent');fs.mkdirSync(agent,{recursive:true,mode:0o700});
  fs.copyFileSync(path.join(setup.runtime,'models.json'),path.join(agent,'models.json'));
  saveJSON(path.join(agent,'settings.json'),{quietStartup:true,defaultThinkingLevel:setup.thinking,compaction:{enabled:false},retry:{enabled:false}});
}
export function sanitize(value:any):any {
  if(Array.isArray(value))return value.filter(v=>v?.type!=='thinking'&&!String(v?.type??'').startsWith('thinking_')).map(sanitize);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['thinking','thinkingSignature','reasoning_content','signature','headers','authorization','apiKey','refresh','access'].includes(k)).map(([k,v])=>[k,sanitize(v)]));
  return value;
}
export async function launch(setup:any,arm:string,work:string,runId:string,envFile:string,prompts:string[],deadlineMs:number,out:string) {
  const name=`pbench-${runId.toLowerCase().replace(/[^a-z0-9-]/g,'-').slice(-52)}`;
  const args=['run','--name',name,...mounts(setup,work,arm),'--env-file',envFile,'-e',`BENCH_RUN_ID=${runId}`,setup.images[arm],...cliArgs(setup,arm,prompts)];
  const start=Date.now();let timedOut=false;let buffer='';let dispatched=false;
  let child:ReturnType<typeof spawn>;
  const stop=()=>{timedOut=true;void exec('podman',['kill',name]).catch(()=>{});child?.kill('SIGTERM');};
  let timer=setTimeout(stop,30000);
  const output=fs.createWriteStream(path.join(out,'stdout.jsonl'),{mode:0o600});
  const errors=fs.createWriteStream(path.join(out,'stderr.log'),{mode:0o600});
  child=spawn('podman',args,{stdio:['ignore','pipe','pipe']});
  // Keep complete event records, not hidden reasoning deltas.
  child.stdout!.on('data',chunk=>{buffer+=chunk.toString();let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const v=JSON.parse(line);if(v.type==='agent_start'&&!dispatched){dispatched=true;clearTimeout(timer);timer=setTimeout(stop,deadlineMs);}if(v.type!=='message_update')output.write(JSON.stringify(sanitize(v))+'\n');}catch{output.write(JSON.stringify({type:'non_json',text:line})+'\n');}}});
  child.stderr!.pipe(errors);
  let code:number|null=null;
  try {code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});}
  finally{clearTimeout(timer);await Promise.all([new Promise<void>(r=>output.end(r)),new Promise<void>(r=>errors.end(r))]);await exec('podman',['rm','-f',name]).catch(()=>{});}
  return {code,timedOut,processElapsedMs:Date.now()-start};
}
