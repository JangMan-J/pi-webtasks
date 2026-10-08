import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {ROOT,exec,readJSON,saveJSON,sha,verifyBaseline} from './core.ts';
import {mounts,stageObserver,initWorkspace} from './sandbox.ts';

export async function preflight() {
 const setup=readJSON(path.join(ROOT,'.pi/benchmark/runtime/setup.json'));
 verifyBaseline(readJSON(path.join(ROOT,'docs/benchmark-cli-baseline.lock.json')));
 stageObserver(setup);
 const reports=[];
 for(const arm of ['E','C']) {
   const work=fs.mkdtempSync(path.join(setup.runtime,`preflight-${arm}-`));initWorkspace(setup,work);
   try {
    const {stdout}=await exec('podman',['run',...mounts(setup,work,arm,true),setup.images[arm],'node','/opt/bench/preflight-probe.mjs'],{maxBuffer:4e6,timeout:30000});
    reports.push(JSON.parse(stdout.trim()));
   } finally {fs.rmSync(work,{recursive:true,force:true});}
 }
 const m=readJSON(path.join(ROOT,'bench/manifest.json'));
 for(const [p,hash] of Object.entries(m.hashes))assert.equal(sha(fs.readFileSync(path.join(ROOT,p))),hash,`Frozen input changed: ${p}`);
 // Distinct images are necessary: hiding the CLI executable through PATH alone is not isolation.
 assert.notEqual(m.images.E,m.images.C);
 const result={passed:true,at:new Date().toISOString(),manifestHash:sha(fs.readFileSync(path.join(ROOT,'bench/manifest.json'))),reports,network:'unrestricted; no firewall or destination allowlist',liveConnectivityEvidence:'docs/benchmark-preflight-results.json'};
 saveJSON(path.join(ROOT,'.pi/benchmark/preflight.json'),result);return result;
}
if(process.argv[1]===import.meta.filename)console.log(JSON.stringify(await preflight(),null,2));
