import fs from 'node:fs';
import path from 'node:path';
import {ROOT,PIN,PI_VERSION,exec,readJSON,saveJSON,sha,verifyBaseline,schedule,publicModelCatalog} from './core.ts';

export async function prepare() {
  const spec=readJSON(path.join(ROOT,'docs/benchmark-cases.json'));
  const lock=readJSON(path.join(ROOT,'docs/benchmark-cli-baseline.lock.json'));
  verifyBaseline(lock);
  const runtime=path.join(ROOT,'.pi/benchmark/runtime');fs.mkdirSync(runtime,{recursive:true,mode:0o700});
  const globalRoot=(await exec('npm',['root','-g'])).stdout.trim();
  const piRoot=process.env.BENCH_PI_ROOT??path.join(globalRoot,'@earendil-works/pi-coding-agent');
  if(readJSON(path.join(piRoot,'package.json')).version!==PI_VERSION)throw Error(`Pi version drift: expected ${PI_VERSION}`);
  const image=spec.sandbox.image_id;
  await exec('podman',['image','inspect',image]);
  for(const [arm,target] of [['E','extension'],['C','cli']]){
    await exec('podman',['build','--build-arg',`BASE=${image}`,'--target',target,'-t',`localhost/pi-parallel-bench-${arm.toLowerCase()}:frozen`,'-f',path.join(ROOT,'bench/Containerfile'),path.join(ROOT,'bench')],{maxBuffer:8e6});
  }
  const extension=path.join(runtime,'extension'); fs.mkdirSync(extension,{recursive:true});
  // Export the frozen treatment, not the current working tree.
  const tar=path.join(runtime,'extension.tar');await exec('git',['archive','--format=tar','-o',tar,PIN,'src','package.json'],{cwd:ROOT});
  await exec('tar',['-xf',tar,'-C',extension]);fs.unlinkSync(tar);
  const modules=path.join(extension,'node_modules');fs.mkdirSync(modules,{recursive:true});
  for(const name of ['parallel-web','typebox']) fs.cpSync(path.join(ROOT,'node_modules',name),path.join(modules,name),{recursive:true,dereference:true});
  if(readJSON(path.join(modules,'parallel-web/package.json')).version!=='1.3.3')throw Error('SDK version drift');
  const resources=path.join(runtime,'resources');fs.mkdirSync(resources,{recursive:true});
  fs.cpSync(lock.skills_root,resources,{recursive:true});
  fs.mkdirSync(path.join(resources,'find-docs'),{recursive:true});fs.copyFileSync(lock.shared_dependency.source,path.join(resources,'find-docs/SKILL.md'));
  const helper=path.join(runtime,'helper');fs.mkdirSync(helper,{recursive:true});
  fs.copyFileSync(lock.responses_helper.path,path.join(helper,'parallel-research'));
  fs.copyFileSync(path.join(ROOT,'bench/helper-adapter.py'),path.join(helper,'adapter.py'));
  const bin=path.join(runtime,'bin');fs.mkdirSync(bin,{recursive:true});
  fs.writeFileSync(path.join(bin,'parallel-research'),'#!/bin/sh\nexec python3 /opt/helper/adapter.py "$@"\n',{mode:0o755});
  const provider='fireworks',modelId=spec.primary_model.slice(provider.length+1);
  const catalog=publicModelCatalog(provider,modelId,readJSON(path.join(process.env.HOME!,'.pi/agent/models.json')));
  saveJSON(path.join(runtime,'models.json'),catalog);
  const images:any={};for(const arm of ['E','C']) images[arm]=(await exec('podman',['image','inspect',`localhost/pi-parallel-bench-${arm.toLowerCase()}:frozen`,'--format','{{.Id}}'])).stdout.trim();
  const packageLock=(await exec('podman',['run','--rm',images.E,'node','-e','console.log(require("fs").readFileSync("/opt/ctx7/package-lock.json","utf8"))'],{maxBuffer:1e6})).stdout;
  const ctx=JSON.parse(packageLock);if(ctx.packages['node_modules/ctx7'].version!=='0.5.11')throw Error('Context7 version drift');
  saveJSON(path.join(runtime,'context7.lock.json'),ctx);
  const setup={runtime,piRoot,images,provider,modelId,model:spec.primary_model,thinking:'low',context7:{version:'0.5.11',integrity:ctx.packages['node_modules/ctx7'].integrity,lockHash:sha(packageLock)},baselineLockHash:sha(JSON.stringify(lock)),extensionCommit:PIN};
  saveJSON(path.join(runtime,'setup.json'),setup);
  return setup;
}
export function freeze() {
  const setup=readJSON(path.join(ROOT,'.pi/benchmark/runtime/setup.json'));
  const spec=readJSON(path.join(ROOT,'docs/benchmark-cases.json'));
  const hashes:any={};
  const collect=(dir:string)=>{for(const e of fs.readdirSync(path.join(ROOT,dir),{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())collect(p);else hashes[p]=sha(fs.readFileSync(path.join(ROOT,p)));}};
  for(const dir of ['bench/fixtures','bench/gold-sources','bench/price-sources'])collect(dir);
  for(const dir of ['.pi/benchmark/runtime/resources','.pi/benchmark/runtime/helper','.pi/benchmark/runtime/bin','.pi/benchmark/runtime/extension/src'])collect(dir);
  for(const p of ['bench/npx','bench/Containerfile','bench/preflight-probe.mjs','.pi/benchmark/runtime/models.json','.pi/benchmark/runtime/setup.json'])hashes[p]=sha(fs.readFileSync(path.join(ROOT,p)));
  for(const name of fs.readdirSync(path.join(ROOT,'bench')).filter(x=>/\.(ts|json|py)$/.test(x)&&x!=='manifest.json'))hashes[`bench/${name}`]=sha(fs.readFileSync(path.join(ROOT,'bench',name)));
  for(const p of ['docs/benchmark-cases.json','docs/benchmark-cli-baseline.lock.json'])hashes[p]=sha(fs.readFileSync(path.join(ROOT,p)));
  const manifest={schemaVersion:1,frozenAt:new Date().toISOString(),...setup,seed:spec.seed,network:'unrestricted',optionalPhasesEnabled:false,existingLiabilityMicro:24000,plannedCapMicro:13000000,absoluteCapMicro:25000000,pairs:schedule(spec),hashes};
  const manifestPath=path.join(ROOT,'bench/manifest.json');
  const history=path.join(ROOT,'.pi/benchmark/data/manifests');fs.mkdirSync(history,{recursive:true});
  if(fs.existsSync(manifestPath)){const previous=fs.readFileSync(manifestPath);fs.writeFileSync(path.join(history,sha(previous)+'.json'),previous);}
  saveJSON(manifestPath,manifest);fs.copyFileSync(manifestPath,path.join(history,sha(fs.readFileSync(manifestPath))+'.json'));return manifest;
}
if(process.argv[1]===import.meta.filename){ const action=process.argv[2];if(action==='--freeze')console.log(JSON.stringify(freeze(),null,2));else if(action==='--prepare')console.log(JSON.stringify(await prepare(),null,2));else throw Error('Usage: node bench/prepare.ts --prepare | --freeze'); }
