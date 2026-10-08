# Round 2 results: extension versus CLI + Pi skills on transcript-sourced questions

Round 2 finds no correctness difference between the arms. Both arms answered all eight questions correctly. Both graders marked every source as supported, and every self-reported retrieval matches the trace. The extension arm did less cumulative token processing in 6 of 8 pairs, but that difference is not significant. On peak context fullness the arms split the other way (see "Two token measures").

## Setup

| Setting | Value |
| --- | --- |
| Questions | 8, taken from actual transcripts on this system and source-checked by the author (riddler). Grader-only material: `bench/gold-round2.json` and `bench/gold-round2-references.json` |
| Arms | E: extension, all research tools active. C: stock `parallel-cli` 0.9.3 with the quarantined Pi skills |
| Worker | `openai-codex/gpt-5.6-sol`, high thinking, the same in both arms |
| Graders | `openrouter/meta/muse-spark-1.3` and `openrouter/sakana/fugu-max`, both at high thinking. Grading is blind and the two graders' scores are never averaged |
| Bounds | 30 minutes of wall clock per run. No request cap or tool-call cap. Spend is capped by the gateway ceiling |
| Isolation | Rootless Podman. No host filesystem. No memory: the account is not provisioned, and the gateway refuses memory routes. Network is unrestricted, by decision |
| Prompt | Each question verbatim, the author's citation wrapper, and a structured JSON tail (RIDDLER-FORMAT-B-20260922). The prompt is identical in both arms |
| Treatment | Branch commit `b850010` with `PIPARA_LAZY_TOOLS` off, so all nine research tools plus the small `parallel_tools` activator are active. Pi 0.87.0 |

## Results

| Dimension | Arm E | Arm C |
| --- | --- | --- |
| Correct answers, Muse Spark | 8 / 8 | 8 / 8 |
| Correct answers, Fugu Max | 8 / 8 | 8 / 8 |
| Source support, both graders | 8 / 8 supported | 8 / 8 supported |
| Deterministic JSON fields | 0 fails | 0 fails |
| Self-reported retrievals that match the trace | 49 / 49 | 49 / 49 |
| Execution claims that match the trace | 2 / 2 | 1 / 1 |
| Cumulative processed tokens, total (see below) | 5.99 M | 8.54 M |
| Peak context per request, mean | 55.8 K | 69.7 K |
| Wall minutes, total | 45.0 | 46.7 |
| Parallel spend | $0.112 | $0.100 |

The correctness comparison has 8 ties and 0 discordant pairs for each grader, so a sign test cannot distinguish the arms.

### Two token measures

The "context tokens" figure used in round 1 and earlier drafts of this report is a sum across requests: input, cache read, and cache write for every request in the run. Every turn resends the whole transcript, so this sum measures cumulative processing, which drives cost and latency. It does not measure how full the agent's context was. Cache reads are 77–95% of it. Cached tokens are fully in the window for the request that uses them; the sum counts the same prefix again on every turn.

Peak context per request is the fullness measure. No run exceeded 45% of the 272K window.

| Pair | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Cumulative, E / C | 0.78 | 0.65 | 1.07 | 1.89 | 0.27 | 0.93 | 0.37 | 0.88 |
| Peak, E (K) | 24.5 | 103.0 | 63.8 | 54.6 | 41.1 | 69.4 | 33.3 | 56.5 |
| Peak, C (K) | 23.1 | 100.3 | 56.7 | 36.6 | 98.7 | 72.0 | 123.2 | 47.4 |

C had the lower peak in 5 of 8 pairs. E's lower mean peak comes from two C runs, Q5 and Q7.

On cumulative processing, E used fewer tokens in 6 of 8 pairs. The geometric mean ratio is 0.73, with a 95% CI of 0.49–1.07 and a sign test p of 0.289. The interval includes 1, so the difference is not significant. Wall time is effectively equal: the ratio is 0.97, with a CI of 0.82–1.12.

The direction is opposite to round 1, where C used 45% fewer tokens. The worker, the build, and the tasks all changed between rounds, so this report does not assign a cause to the reversal.

### Routes

| Route | Arm E | Arm C |
| --- | ---: | ---: |
| Gateway dispatches (Parallel API) | 40 | 34 |
| `parallel-cli` / `parallel-research` calls | — | 34 |
| Context7 calls | 17 | 13 |
| Direct HTTP from the shell | 38 | 63 |

Arm E made at least one gateway dispatch in every run. Arm C used its CLI heavily on Q5–Q7 (8, 13, and 8 calls). On Q2 and Q8, arm C made no CLI calls and did all of its retrieval as raw shell HTTP. Q8 was run twice in arm C: one attempt read the `parallel-web-search` skill and made 5 CLI calls, and the other read only `find-docs` and made none. The two attempts had the same image, prompt, and PATH, so skill discovery varies from run to run. On the source-code questions, both arms retrieved mostly from GitHub directly.

Every pair has at least one arm that used its research interface, so the interface-use subset contains all 8 cases. The result is still conditional, because the arm assignment affects whether an agent uses its interface.

## Grader validity

Every run passed, so the graders needed a check that they can fail an answer. The calibration probes (`bench/r2-calibrate.ts`) took real answers and inserted a trap from the author's list into the prose conclusion. The JSON stayed correct.

| Probe | Expected | Muse Spark | Fugu Max |
| --- | --- | --- | --- |
| Q4, three-tool allowlist asserted | fail | fail | fail |
| Q5, automatic fallback asserted | fail | fail | fail |
| Q8, omission means rejection asserted | fail | fail | fail |
| Q4, three-tool claim mentioned only to reject it | pass | pass | pass |

8 of 8 probes got the expected grade. Both graders quoted the planted sentence. The perfect scores therefore show a real ceiling, not lenient grading.

## Interpretation

The author's questions are hard for many models, but this worker answered all of them correctly in both arms. The questions therefore cannot separate the two toolchains on correctness. The remaining differences are in route, efficiency, and consistency:

- Arm E always used its research tools. Arm C's use of the interface depended on whether it chose to read a skill file.
- Arm E tended to do less cumulative processing. The effect is not established at n = 8. On peak context fullness, neither arm was consistently lower.
- The extension's tool schemas add a fixed ~5K tokens to every request. That dominates the window early in a run, which is where round 1's "~60% of context" figure came from, and is about 9% of a typical peak in these longer runs.
- Spend and wall time were effectively equal.

To separate the arms on correctness, a future round needs one of two things: a weaker or cheaper worker, where these questions fall below the ceiling, or questions whose settling source cannot be fetched from GitHub or npm with `curl`.

## Incidents, and what each one changed

All five superseded attempts are kept under `.pi/benchmark/data/r2-superseded/`. The replaced original of Q5 is kept at `r2-Q5`.

| Incident | Cause | Fix |
| --- | --- | --- |
| Q8, first attempt, both arms failed instantly | The observer added `max_completion_tokens`, and the Codex Responses API rejects that field | Payloads in Responses-API shape now pass through, and the observer records that it applied no cap (`bench/observer.ts`, 2 tests) |
| Q8, retry refused | The ledger primary key blocks reuse of a pair ID | Added `--attempt N`, which gives a retry a distinct ID. Deleted two void ledger rows after backing up the database |
| Q8, arm C, harness error after the run completed | The OAuth lock was held for the whole run, and another session refreshed the token during it | The lock is now held only to clone the credential and for a compare-and-swap write-back. The write-back never overwrites a newer rotation (`bench/auth.ts`, 1 test) |
| Q7, runner killed | The runner was a child of an aborted tool call | The runner now starts detached (`setsid`). Q7 was rerun as a new pair |
| Q5, arm C, no answer | The Codex `WebSocket error` occurred at request 36. Provider retries are off by design | Q5 was rerun as a new pair, with operator approval. The original is recorded as an infrastructure failure |

The route classifier also counted `parallel-cli extract 'https://…'` as direct HTTP. It now puts each shell command into one of four classes (CLI, Context7, direct, other). All runs were recounted from the raw events with the fixed classifier.

## Limits and known issues

- The worker can read the observer's log at `/work/events.jsonl`. The final Q8/C run read it in step 3. The issue affects both arms equally, and the log contains no answers. It was not fixed during the round, because a fix would have put the pairs under two different harness conditions. Fix it before the next round.
- Blinding is partial. The graders see neutralized tool names, and an audit found 0 leaked names in 16 runs. However, the style of an answer can still suggest its arm.
- Format lapses: Q1/C copied the type suffixes into its key names. The cause is the wrapper rendering `name:S`, and the values were read with the suffixes removed. Q5-a2/E did not include a JSON tail, so its correctness was graded from the prose.
- Retrieval verification matches document identity (repository and path, host and path). It does not compare content bytes. A claim that matches nothing would be reported as unverified, not fabricated. No claim was unverified.
- The results apply to 8 questions, one worker, one build, and this skill bundle. Q2/Q3 and Q6/Q8 share subject matter.

## Reproduction

```sh
node bench/r2-run.ts Q1 … Q8        # the worker runs (use --attempt N for a retry)
node bench/r2-score.ts              # deterministic check of the JSON tails
node bench/r2-grade.ts              # blinded grader pass; skips runs that are already graded
node bench/r2-calibrate.ts          # grader calibration probes
node bench/r2-report.ts             # all dimensions -> .pi/benchmark/data/r2-report.json
```
