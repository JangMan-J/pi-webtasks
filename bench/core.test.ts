import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {ROOT,readJSON,schedule,verifyBaseline,publicModelCatalog,exec} from './core.ts';
import {cliArgs,mounts,sanitize} from './sandbox.ts';

test('reduced schedule is deterministic, complete, balanced and excludes optional cases',()=>{
 const spec=readJSON(path.join(ROOT,'docs/benchmark-cases.json'));const a=schedule(spec);assert.deepEqual(a,schedule(spec));assert.equal(a.length,15);
 const p=a.filter(x=>x.phase==='primary');assert.equal(p.length,12);assert.equal(p.filter(x=>x.order[0]==='E').length,6);assert.equal(new Set(p.map(x=>x.caseId)).size,12);
 assert.deepEqual(new Set(p.map(x=>x.caseId)),new Set(spec.primary_task_ids));assert.equal(a.filter(x=>x.armCapMicro===0).length,4);
});
test('all treatment source hashes still match the supplied lock',()=>verifyBaseline(readJSON(path.join(ROOT,'docs/benchmark-cli-baseline.lock.json'))));
test('auth catalog never carries provider secret commands or headers',()=>{
 const c=publicModelCatalog('p','m',{providers:{p:{apiKey:'!secret-command',headers:{Authorization:'secret'},models:[{id:'m',api:'openai-completions',headers:{secret:'x'},apiKey:'secret'}]}}});
 assert(!JSON.stringify(c).includes('secret'));assert.equal(c.providers.p.models[0].id,'m');
});
test('run flags append prompt, disable implicit resources and preserve open network',()=>{
 const s={provider:'fireworks',modelId:'m',thinking:'medium',runtime:'/runtime',piRoot:'/pi'};
 for(const arm of ['E','C']){const c=cliArgs(s,arm,['task','followup']);assert(c.includes('--append-system-prompt'));assert(!c.includes('--system-prompt'));assert(c.includes('--no-context-files'));assert.deepEqual(c.slice(-2),['task','followup']);assert(!mounts(s,'/work',arm).some(x=>x.startsWith('--network')));}
 assert(!mounts(s,'/work','E').join(' ').includes('/opt/cli'));assert(!mounts(s,'/work','C').join(' ').includes('/opt/extension'));
});
test('shareable JSON omits private reasoning and credential fields',()=>{
 assert.deepEqual(sanitize({content:[{type:'thinking',thinking:'hidden'},{type:'text',text:'visible'}],apiKey:'secret'}),{content:[{type:'text',text:'visible'}]});
});
test('helper adapter redirects only exact Responses URL without changing payload, headers or transport args',async()=>{
 const {stdout}=await exec('python3',['-c',`import importlib.util, urllib.request
s=importlib.util.spec_from_file_location('adapter',${JSON.stringify(path.join(ROOT,'bench/helper-adapter.py'))});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
calls=[]
urllib.request.urlopen=lambda request,*a,**kw: calls.append((request.full_url,request.data,dict(request.headers),a,kw)) or 'sentinel'
m.install_redirect('http://gateway:8123/')
r=urllib.request.Request('https://api.parallel.ai/v1/responses',data=b'{"input":"fixture"}',headers={'Authorization':'Bearer dummy'})
assert urllib.request.urlopen(r,timeout=12)=='sentinel'
assert calls[0]==('http://gateway:8123/v1/responses',b'{"input":"fixture"}',{'Authorization':'Bearer dummy'},(),{'timeout':12})
r=urllib.request.Request('https://public.example/doc')
urllib.request.urlopen(r)
assert calls[1][0]=='https://public.example/doc'
print('parity passed')`]);assert.match(stdout,/parity passed/);
});
