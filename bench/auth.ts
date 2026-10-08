import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {exec,readJSON,saveJSON} from './core.ts';

/**
 * Outcome of post-run credential housekeeping. Recorded in the run record;
 * it never changes the run's status, which reflects agent work only.
 *
 * - written:      host still held the cloned token; our final state applied.
 * - superseded:   another party rotated the host credential mid-run. Ours is
 *                 not applied, so the newer credential is never clobbered.
 * - child-invalid: the child credential is missing or malformed; nothing to apply.
 * - writeback-error: the write-back lock could not be acquired; the child file
 *                 is left in place at childPath for manual recovery.
 * - api-key:      API-key providers need no rotation or write-back.
 */
export type CredentialWritebackOutcome = 'written' | 'superseded' | 'child-invalid' | 'writeback-error' | 'api-key';

export interface CredentialWriteback {
  outcome: CredentialWritebackOutcome;
  /** SHA-256 prefixes, never token material. */
  clonedRefreshHash: string | null;
  hostRefreshHash: string | null;
  childPath: string;
}

const hashPrefix = (value: unknown) =>
  typeof value === 'string' && value ? crypto.createHash('sha256').update(value).digest('hex').slice(0, 16) : null;

/**
 * Pure compare-and-swap decision: apply our final credential only if the host
 * still holds exactly the token we cloned. Anything else means another party
 * rotated meanwhile, and overwriting would destroy their newer rotation.
 */
export function decideWriteback(clonedRefresh: unknown, hostRefresh: unknown): 'written' | 'superseded' {
  return typeof clonedRefresh === 'string' && clonedRefresh !== '' && hostRefresh === clonedRefresh ? 'written' : 'superseded';
}

/**
 * OAuth credential handling for benchmark workers.
 *
 * The lock is held only for the brief clone at start and the brief
 * compare-and-swap at end, never for the run itself. A previous version held
 * the lock across the whole run; any other session refreshing the same
 * provider mid-run compromised the lock, and the resulting write-back refusal
 * was thrown as a harness error on top of fully completed agent work
 * (round 2 Q8 arm C). Long holds also serialize unrelated sessions for up to
 * the full wall-clock deadline. Both failure modes are fixed here: short
 * locks, conditional write-back, and housekeeping that records instead of
 * throwing once agent work is done.
 */
export async function withCredentials<T>(
  setup:any,
  work:string,
  run:()=>Promise<T>,
  report?: (writeback: CredentialWriteback) => void,
):Promise<T> {
  const agent=path.join(work,'home/.pi/agent');fs.mkdirSync(agent,{recursive:true,mode:0o700});
  const authPath=path.join(agent,'auth.json');
  const hostAuth=path.join(process.env.HOME!,'.pi/agent/auth.json');
  const provider=setup.provider;
  const cleanup=()=>fs.rmSync(authPath,{force:true});
  if(provider==='fireworks') {
    const {stdout}=await exec('node',[path.join(setup.piRoot,'dist/cli.js'),'auth','print-api-key','--provider',provider,'--model',setup.modelId],{maxBuffer:1e6});
    const key=stdout.trim();if(!key)throw Error('Empty inference credential');
    saveJSON(authPath,{[provider]:{type:'api_key',key}});
    try{
      const result=await run();
      report?.({outcome:'api-key',clonedRefreshHash:null,hostRefreshHash:null,childPath:authPath});
      return result;
    }finally{cleanup();}
  }
  const {FileAuthStorageBackend}=await import(pathToFileURL(path.join(setup.piRoot,'dist/core/auth-storage.js')).href);
  const backend=new FileAuthStorageBackend(hostAuth);
  // Brief lock: clone only, no write.
  const cloned:any=await backend.withLockAsync(async(current:string)=>{
    const all=JSON.parse(current);const original=all[provider];
    if(original?.type!=='oauth')throw Error('Expected OAuth credential');
    saveJSON(authPath,{[provider]:original});
    return {result:original,next:undefined};
  });
  const clonedRefreshHash=hashPrefix(cloned?.refresh);
  let result:T|undefined;let failure:unknown;
  try{result=await run();}catch(e){failure=e;}
  // Brief lock: compare-and-swap. Never clobber a newer rotation, and never
  // throw for housekeeping once agent work is done; record the outcome.
  let writeback:CredentialWriteback;
  try {
    writeback=await backend.withLockAsync(async(current:string)=>{
      const all=JSON.parse(current);
      const hostNow=all[provider];
      let child:any;
      try{child=readJSON(authPath)[provider];}catch{child=undefined;}
      const childValid=child?.type==='oauth'&&!!child.access&&!!child.refresh;
      const outcome:CredentialWriteback=childValid
        ? {outcome:decideWriteback(cloned?.refresh,hostNow?.refresh),clonedRefreshHash,hostRefreshHash:hashPrefix(hostNow?.refresh),childPath:authPath}
        : {outcome:'child-invalid',clonedRefreshHash,hostRefreshHash:hashPrefix(hostNow?.refresh),childPath:authPath};
      if(outcome.outcome!=='written')return {result:outcome,next:undefined};
      all[provider]=child;
      return {result:outcome,next:JSON.stringify(all,null,2)};
    });
  } catch {
    writeback={outcome:'writeback-error',clonedRefreshHash,hostRefreshHash:null,childPath:authPath};
  }
  // Remove the child credential unless the write-back itself failed, in which
  // case the file stays for manual recovery and its path is in the record.
  if(writeback.outcome!=='writeback-error')cleanup();
  report?.(writeback);
  if(failure)throw failure;
  return result as T;
}
