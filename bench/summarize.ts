import fs from 'node:fs';
import path from 'node:path';
import {ROOT,readJSON,saveJSON} from './core.ts';
import {loadRuns} from './grade.ts';
import {buildReport,contextTokens,mean,isSuccessful} from './report.ts';
import {applyFinalAdjudications,type FinalAdjudicationFile} from './score.ts';

export function summarize() {
 const runs=loadRuns('primary').map(r=>{
  const dispatch=r.events.find((e:any)=>e.type==='prompt_audit');const start=Date.parse(dispatch?.ts??'');
  return {...r,events:r.events.map((e:any)=>({...e,wallTs:e.ts,ts:typeof e.ts==='string'&&Number.isFinite(start)?Date.parse(e.ts)-start:undefined}))};
 });
 const manifest=readJSON(path.join(ROOT,'bench/manifest.json'));
 const data=path.join(ROOT,'.pi/benchmark/data'),dir=path.join(data,'grading/primary');
 const scores=readJSON(path.join(dir,'agreed-scores.json'));
 const adjudication=readJSON(path.join(dir,'adjudication.json'));
 const firstRound=readJSON(path.join(dir,'adjudication.round1.json'));
 const mapping=readJSON(path.join(dir,'mapping.json'));
 const overlaySrc=path.join(ROOT,'bench/final-adjudication.json');
 const overlayFile:FinalAdjudicationFile=fs.existsSync(overlaySrc)?readJSON(overlaySrc):{kind:'final_adjudication_overlay',independentThirdModel:false,description:'',records:[]};
 if(overlayFile.independentThirdModel!==false)throw Error('final overlay must not claim a third independent model');
 saveJSON(path.join(dir,'final-adjudication.json'),overlayFile);
 const overlay=applyFinalAdjudications(scores,adjudication.queue,overlayFile.records??[]);
 const remaining=overlay.remaining;
 const strata=Object.fromEntries(runs.map(r=>[r.caseId,['A2','L1','L2','E2'].includes(r.caseId)?'no_web':'web']));
 const expectedPairs=manifest.pairs.filter((p:any)=>p.phase==='primary').map((p:any)=>p.pairId);
 const analyze=(judgments:any[],pending:number,finalOverlayCount=0)=>buildReport({runs,scores:judgments,caseStrata:strata,expectedPairs,
  triggerLabels:judgments.map(s=>{const r=runs.find(r=>r.runId===s.runId);return {runId:s.runId,opportunityEventId:strata[r?.caseId??'']==='no_web'?null:s.metadata?.opportunityEventId??r?.events.find((e:any)=>e.type==='prompt_audit')?.id??null,firstExternalDispatchEventId:s.metadata?.firstExternalEventId??null,firstParallelDispatchEventId:s.metadata?.firstParallelEventId??null,parallelOpportunityEventId:s.metadata?.parallelOpportunityEventId??null};}),
  scoringSummary:{agreementRate:adjudication.agreementRate,adjudicationCount:pending,missingScoreCount:runs.length-judgments.length,finalOverlayCount}});
 const byRater:Record<string,any[]>={grok:[],gpt:[]};
 for(const [opaque,runId]of Object.entries(mapping))for(const rater of ['grok','gpt']){
  const second=path.join(dir,`${opaque}.round2.${rater}.json`),first=path.join(dir,`${opaque}.${rater}.json`);
  const file=fs.existsSync(second)?second:first;
  if(fs.existsSync(file)){const s=readJSON(file).score;if(s.runId!==runId)throw Error('Rater ID mismatch');byRater[rater].push(s);}
 }
 const fullReports=Object.fromEntries(Object.entries(byRater).map(([name,ss])=>[name,analyze(ss,remaining.length,overlay.applied.length)]));
 const consensus=analyze(scores,remaining.length,overlay.applied.length);
 const adjudicated=analyze(overlay.scores,remaining.length,overlay.applied.length);
 const ledger=readJSON(path.join(data,'ledger.json'));
 const summary=readJSON(path.join(data,'execution-summary.json'));
 const report={generatedAt:new Date().toISOString(),decision:remaining.length?'inconclusive':adjudicated.claim.decision,
  scope:'12 primary pairs; full per-rater estimates use every attempted run and keep original rater scores. The agreed-only subset and the Grok overlay set are separate; overlay field copies are not rater consensus and are not averages.',
  consensusSubset:consensus,adjudicated,raters:fullReports,scoring:{firstRoundAgreement:firstRound.agreementRate,secondRoundAgreement:adjudication.agreementRate,unresolved:remaining.length,originalDisagreements:adjudication.queue.length,finalOverlayCount:overlay.applied.length,independentThirdModel:false,notRaterConsensus:true,missingRaterScores:Object.fromEntries(Object.entries(byRater).map(([k,v])=>[k,runs.length-v.length]))},
  accounting:{existingSmokeMicro:24000,pilotMicro:5000,primaryMicro:39000,totalLiabilityMicro:ledger.liabilityMicro,activeReservationMicro:ledger.activeReservationMicro,invoiceReconciled:false},
  execution:summary,
  reportingCorrection:'Post-run presentation correction: identify the consensus subset size, show complete 12-pair estimates separately for both raters, and read the exact sign-test p field. No worker, gold, rubric, or scoring threshold changed. Previous renderer and output are retained in data/frozen-reporting/. Grok overlay records copy disputed fields from a named original rater; they do not rewrite rater files or invent agreement.'};
 saveJSON(path.join(data,'report.json'),report);
 saveJSON(path.join(ROOT,'docs/benchmark-results.json'),report);
 const f=(n:any,d=2)=>typeof n==='number'&&Number.isFinite(n)?n.toFixed(d):'N/A';
 const maps=Object.fromEntries(Object.entries(byRater).map(([k,v])=>[k,new Map(v.map(s=>[s.runId,s]))]));
 const overlayMap=new Map(overlay.applied.map(s=>[s.runId,s]));
 const finalMap=new Map(overlay.scores.map(s=>[s.runId,s]));
 const avg=(rater:string,arm:string,field:'retrieval'|'quality')=>mean(runs.filter(r=>r.arm===arm).map(r=>maps[rater].get(r.runId)?.[field]??0));
 const overlayAvg=(arm:string,field:'retrieval'|'quality')=>mean(runs.filter(r=>r.arm===arm).map(r=>{const s=finalMap.get(r.runId);return s?s[field]:0;}));
 const label=(r:string)=>r==='grok'?'Grok 4.6':'GPT-5.5';
 const overlayNote=remaining.length
  ? `${remaining.length} of ${adjudication.queue.length} original grading disagreements remain unresolved. They prevent one final overlay score set.`
  : `The original ${adjudication.queue.length} disagreements are preserved below. A later Grok 4.6 overlay copied disputed fields from named original raters against frozen gold and traces. That overlay is not a third independent model and is not rater consensus.`;
 const lines=[
 '# Parallel extension versus CLI + Pi-adapted skills',
 '', `Generated ${report.generatedAt}.`,
 '', 'The benchmark does not establish extension superiority. Both full-corpus retrieval estimates have confidence intervals that include zero.',
 overlayNote,
 remaining.length?'':`The overlay 12-pair retrieval mean is ${f(adjudicated.primary.meanDelta)} (95% interval ${f(adjudicated.primary.ci.lo)} to ${f(adjudicated.primary.ci.hi)}). That still does not meet the preregistered superiority gates.`,
 '', '## Experiment', '',
 '- Three pilot pairs and twelve primary pairs: 30 worker runs, as requested.',
 `- Both arms used \`${manifest.model}\`, low reasoning, Pi 0.86.1, and unrestricted network access.`,
 `- Extension commit: \`${manifest.extensionCommit}\`. CLI: 0.9.3 with the supplied Pi-adapted skills and Responses helper.`,
 '- Both arms received the same find-docs skill and frozen Context7 0.5.11.',
 '- Fresh rootless Podman container per worker. No host instructions, shared run state, or gold packets inside workers.',
 '- The gateway kept the real Parallel credential outside workers. No recurring service or account mutation occurred.',
 '- Optional replication and diagnostics stayed disabled. Failed runs were not replaced.',
 '', '## Original rater 12-pair estimates', '',
 'Each row uses all 24 primary runs under one rater’s latest judgments. These are the original corpora. They are not a 24-run agreement set. Scores are not averaged between raters.',
 'Positive score deltas favor the extension. Intervals use 10,000 paired bootstrap resamples with seed 42017.',
 '', '| Rater | Retrieval E / C (0–2) | E − C | 95% interval | Exact sign-test p |',
 '|---|---:|---:|---:|---:|',
 ...['grok','gpt'].map(k=>{const r=fullReports[k];return `| ${label(k)} | ${f(avg(k,'E','retrieval'))} / ${f(avg(k,'C','retrieval'))} | ${f(r.primary.meanDelta)} | ${f(r.primary.ci.lo)} to ${f(r.primary.ci.hi)} | ${f(r.primary.signTest.p,4)} |`;}),
 '', '| Rater | Quality E / C (0–4) | E − C | 95% interval |',
 '|---|---:|---:|---:|',
 ...['grok','gpt'].map(k=>{const r=fullReports[k];return `| ${label(k)} | ${f(avg(k,'E','quality'))} / ${f(avg(k,'C','quality'))} | ${f(r.quality.meanDelta)} | ${f(r.quality.ci.lo)} to ${f(r.quality.ci.hi)} |`;}),
 '', `The agreed-only subset contains ${consensus.primary.nPairs} complete pairs, not twelve, because 18 of 24 runs matched after the comparison round. Its statistics remain in the JSON report, separate from both original rater corpora and from the overlay 12-pair set.`,
 '', '## Final overlay 12-pair estimate', '',
 'Separate from both original rater corpora. Copies only disputed fields from a named original rater. Does not rewrite rater files, average scores, or claim the 24 runs agreed.',
 '', '| Overlay | Retrieval E / C (0–2) | E − C | 95% interval | Exact sign-test p |',
 '|---|---:|---:|---:|---:|',
 `| Grok 4.6 council pass | ${f(overlayAvg('E','retrieval'))} / ${f(overlayAvg('C','retrieval'))} | ${f(adjudicated.primary.meanDelta)} | ${f(adjudicated.primary.ci.lo)} to ${f(adjudicated.primary.ci.hi)} | ${f(adjudicated.primary.signTest.p,4)} |`,
 '', '| Overlay | Quality E / C (0–4) | E − C | 95% interval |',
 '|---|---:|---:|---:|',
 `| Grok 4.6 council pass | ${f(overlayAvg('E','quality'))} / ${f(overlayAvg('C','quality'))} | ${f(adjudicated.quality.meanDelta)} | ${f(adjudicated.quality.ci.lo)} to ${f(adjudicated.quality.ci.hi)} |`,
 '', `Claim decision on the overlay set: ${adjudicated.claim.decision}. ${adjudicated.claim.reasons[0]??''}`,
 '', '## Tokens, time, and money', '',
 '| Observed metric | Extension | CLI + skills |',
 '|---|---:|---:|',
 ...[['Finished within the common limits',summary.arms.E.completed,summary.arms.C.completed],['Hit the 12-request limit',summary.arms.E.limited.length,summary.arms.C.limited.length],['Total context tokens',summary.arms.E.contextTokens,summary.arms.C.contextTokens],['Parallel request dispatches',summary.arms.E.parallelRequests.length,summary.arms.C.parallelRequests.length],['Primary Parallel liability (USD)',summary.arms.E.parallelLiabilityMicro/1e6,summary.arms.C.parallelLiabilityMicro/1e6]].map(([name,e,c])=>`| ${name} | ${e} | ${c} |`),
 '', `The CLI arm used ${f((1-summary.arms.C.contextTokens/summary.arms.E.contextTokens)*100,1)}% fewer context tokens. Cached input counts toward context consumption.`,
 'This is a descriptive total, not an isolated interface-cost estimate. In `primary-L1-E:13–14`, `cat /work/*` also read the worker’s own observer log, adding harness text to context.',
 `Mean first-request input was ${['E','C'].map(a=>f(mean(runs.filter(r=>r.arm===a).map(r=>{const u=r.events.find((e:any)=>e.type==='message_end'&&e.role==='assistant'&&e.usage).usage;return u.input+u.cacheRead+u.cacheWrite;})),0)).join(' for E and ')} for C. Later retries and preparation also affect total tokens.`,
 '', '| Rater | Quality points per 10k tokens, E / C | Successful resolutions, E / C | Restricted mean seconds, E / C | E − C seconds (95% interval) |',
 '|---|---:|---:|---:|---:|',
 ...['grok','gpt'].map(k=>{const r=fullReports[k];const success=(a:string)=>runs.filter(x=>x.arm===a&&isSuccessful(x,maps[k].get(x.runId))).length;return `| ${label(k)} | ${f(r.efficiency.overall.E.qualityPointsPer10kTokens)} / ${f(r.efficiency.overall.C.qualityPointsPer10kTokens)} | ${success('E')} / ${success('C')} | ${f(r.time.perArmMeanMs.E/1000)} / ${f(r.time.perArmMeanMs.C/1000)} | ${f(r.time.meanDeltaMs/1000)} (${f(r.time.ci.lo/1000)} to ${f(r.time.ci.hi/1000)}) |`;}),
 '', 'A successful resolution requires quality ≥3 and no material error, fabricated citation, or critical violation.',
 'Unsuccessful runs count at their common deadline for restricted time. A quick failure is not a quick justified resolution.',
 '', 'Total Parallel liability was $0.068: $0.024 earlier smoke, $0.005 pilot, and $0.039 primary.',
 'All 25 new gateway requests returned HTTP 200. No budget denial occurred, and no reservation remains active.',
 'These amounts are conservative API-price liabilities, not reconciled invoice charges. Model usage does not debit the Parallel-only ceiling.',
 'Unknown Context7 and other-service charges remain unknown. Parallel-only evidence efficiency uses attributed claims, never all-source claims.',
 '', '## What the traces show', '',
 '- A1-E and P2-E reached the 12-request limit during repeated guesses about saved JSON fields and text locations.',
 '- R2-C repeatedly guessed `/opt/pi/skills/...` despite the correct `/opt/resources/...` paths in its actual prompt. It later retrieved evidence but delivered no final table.',
 '- The timed runs exercised Parallel Search and Extract only. Other tools received earlier smoke or offline coverage, not comparative primary performance evidence.',
 '- Both raters scored the ambiguous Atlas case A2 at zero in both arms. Completion did not mean the agent resolved missing user intent correctly.',
 '', 'These observations support three follow-up candidates: clearer saved-artifact navigation, lower always-visible schema cost, and better clarification behavior.',
 'They do not prove that a wording change alone will fix the failures. No product tuning or additional bouts followed these results.',
 '', '## Per-run judgments', '',
 'Scores show Grok / GPT. E means extension; C means CLI plus skills. “Completed” describes execution, not answer correctness. Overlay is shown only where a dispute existed; it is a field copy, not a new rater.',
 '', '| Case | Arm | Execution | Retrieval | Quality | Overlay retrieval / quality | Raw seconds | Context tokens |',
 '|---|---|---|---:|---:|---:|---:|---:|',
 ...runs.map(r=>{const o=overlayMap.get(r.runId);const ov=o?`${o.retrieval} / ${o.quality}`:'—';return `| ${r.caseId} | ${r.arm} | ${r.status} | ${maps.grok.get(r.runId)?.retrieval??'?'} / ${maps.gpt.get(r.runId)?.retrieval??'?'} | ${maps.grok.get(r.runId)?.quality??'?'} / ${maps.gpt.get(r.runId)?.quality??'?'} | ${ov} | ${f(r.elapsedMs/1000)} | ${contextTokens(r.usage)} |`;}),
 '', '## Rating and limitations', '',
 `Initial agreement was ${f(firstRound.agreementRate*100)}%. After one independent comparison round, agreement was ${f(adjudication.agreementRate*100)}% (18 of 24 runs).`,
 'One Grok response needed a structured-citation repair. Its original response and validation error remain in the dataset.',
 remaining.length
  ? `The remaining ${remaining.length} disagreements are in \`docs/benchmark-adjudication.md\`. Neither rater has a missing primary score.`
  : `The original ${adjudication.queue.length} disagreements remain on record in \`docs/benchmark-adjudication.md\`. A Grok overlay copied disputed fields; rater JSON is unchanged. Neither rater has a missing primary score.`,
 '', 'Direct public HTTP and shared Context7 evidence were valid in both arms. A successful non-Parallel lookup did not require another paid request.',
 'The fixed corpus covers developer documentation and local work. It does not establish results for other domains, models, or long research jobs.',
 'The selected model is a router. Its exact underlying deployment was not independently identified.',
 'Capability names were neutralized for grading, but output formats can reveal treatment. Rater judgments are not fully blind.',
 'Source facts repeat across workflows. The JSON report includes source-family sensitivity, web/no-web strata, and conservative failure analysis.',
 'Gateway logs do not reveal all encrypted internet traffic. Absence of a private canary there does not prove absence on another route.',
 'Workspace and HOME artifacts persist. Explicit `/tmp` outputs do not survive container removal; their inspected outputs and receipts remain in event logs.',
 '', '## Reproducibility', '',
 '- Protocol and active cases: `docs/benchmark-plan.md`, `docs/benchmark-cases.json`.',
 '- Frozen manifest and gold: `bench/manifest.json`, `bench/gold.json`, `bench/gold-sources/`.',
 '- Overlay records: `bench/final-adjudication.json`.',
 '- Runner instructions: `bench/README.md`.',
 '- Local dataset, ledger, ratings, and complete statistics: `.pi/benchmark/data/` (Git-ignored).',
 '- Machine-readable report: `.pi/benchmark/data/report.json`.',
 '', 'Post-run reporting corrections label the agreed subset, retain both full-corpus estimates, and fix the sign-test display field.',
 'They change no worker record, gold packet, rubric, or threshold. The previous renderer and output remain in `data/frozen-reporting/`.',
 ];
 fs.writeFileSync(path.join(ROOT,'docs/benchmark-results.md'),lines.join('\n')+'\n');
 const recBy=new Map((overlayFile.records??[]).map((r:any)=>[r.runId,r]));
 const queue=['# Benchmark adjudication queue','',
  `Original record: ${adjudication.queue.length} judgments remained disputed after two independent rounds. No score averaging or replacement worker run occurred.`,
  '',
  overlayNote,
  '',
  'The full per-rater estimates are in `docs/benchmark-results.md`. Both preserve all twelve pairs. Original rater notes below are unchanged.',
  '',
  ...adjudication.queue.flatMap((q:any)=>[
  `## ${q.runId}`,'','| Field | Grok | GPT |','|---|---|---|',...q.fields.map((f:any)=>`| ${f.field} | ${JSON.stringify(f.raterA)} | ${JSON.stringify(f.raterB)} |`),'',`Grok: ${q.raterA.notes}`,'',`GPT: ${q.raterB.notes}`,'',`Evidence: \`.pi/benchmark/data/${q.runId.slice(0,-2)}/${q.runId.slice(-1)}/run.json\`. Full event-linked judgments: \`.pi/benchmark/data/grading/primary/adjudication.json\`.`,''
 ]),
  '## Grok overlay records','',
  'These records are a later Grok 4.6 council pass against frozen gold, rubrics, answers, and traces. Grok was rater A. This is not a third independent model. Field copies from a named rater are not rater consensus.',
  '',
  ...adjudication.queue.flatMap((q:any)=>{
   const rec=recBy.get(q.runId);
   if(!rec) return [`### ${q.runId} overlay`,'','Unresolved. No overlay record.','',];
   return [
    `### ${q.runId} overlay`,'',
    `Adjudicator: ${rec.adjudicator}. independentThirdModel: ${rec.independentThirdModel}. notRaterConsensus: ${rec.notRaterConsensus}.`,
    '',
    `Gold ${rec.provenance.goldCaseId} rubric: ${rec.provenance.goldRubric}`,
    '',
    '| Field | Overlay value | Copied from |',
    '|---|---|---|',
    ...rec.fields.map((f:any)=>`| ${f.field} | ${JSON.stringify(f.value)} | ${f.source} |`),
    '',
    rec.rationale,
    '',
    ...rec.fields.flatMap((f:any)=>[`**${f.field}.** Clause: ${f.rubricClause}`, '', f.rationale, '', `Events: ${f.evidenceEventIds.join(', ')}.`, '']),
    `Provenance: run \`${rec.provenance.runPath}\`; rater A \`${rec.provenance.raterAPath}\`; rater B \`${rec.provenance.raterBPath}\`; original queue \`${rec.provenance.originalQueuePath}\`.`,
    '',
   ];
  }),
 ];
 fs.writeFileSync(path.join(ROOT,'docs/benchmark-adjudication.md'),queue.join('\n')+'\n');return report;
}
if(process.argv[1]===import.meta.filename){const r=summarize();console.log(JSON.stringify({decision:r.decision,unresolved:r.scoring.unresolved,overlays:r.scoring.finalOverlayCount},null,2));}
