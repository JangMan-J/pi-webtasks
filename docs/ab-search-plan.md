# A/B plan: search extension versus stock Parallel CLI + quarantined Pi skills

Status: proposal and pre-registration. Supersedes the earlier single-stage draft of this
file. No paid run is authorized by this document. Tier 0 costs nothing and needs no
authorization beyond ordinary local work.

## 1. Arms

- Arm E: the `pi-parallelized` extension. Tools `parallel_search`, `parallel_extract`,
  `parallel_responses` and the rest of the registered set. No CLI in the image.
- Arm C: stock `parallel-cli` 0.9.3 plus the Pi-adapted skills at
  `/home/jangpi/.agents/.quarantined/parallel-cli` (10 skills and `RESPONSES.md`), plus
  the `parallel-research` Responses helper behind the transport-only gateway adapter.
  No extension in the image.

Both arms share the `find-docs` skill and frozen Context7 0.5.11, run Pi 0.86.1 on
`fireworks/accounts/fireworks/routers/kimi-k3-fast` at low reasoning, and receive the same
prompts, deadlines, and system-prompt addendum. Skill sources and the helper are pinned by
`docs/benchmark-cli-baseline.lock.json`. This is the same arm C as round 1.

## 2. What round 1 already settled

Round 1 ran 30 workers, 24 of them primary, and graded them with two independent LLM
raters plus a reconciliation round. Recomputed here from the preserved per-run records in
`.pi/benchmark/data/primary-*/{E,C}/run.json`:

| Finding | Value | Status |
| --- | --- | --- |
| Context tokens, E vs C (input + cache read + cache write) | 534,285 vs 285,974, ratio 1.92 | established |
| Pairs where E consumed more context | 10 of 12, two-sided sign test p = 0.039 | established |
| Mean log token ratio | 0.650, SD 0.742 | established |
| Retrieval quality delta (Grok) | 0.00, 95% CI −0.42 to 0.42 | no detectable difference |
| Retrieval quality delta (GPT) | +0.17, 95% CI −0.17 to 0.50 | no detectable difference |
| Parallel spend, 24 primary runs | $0.039 total ($0.020 E, $0.019 C) | established |
| Fixed first-request input tokens | 5,982 E vs 2,530 C | established |

These figures describe the extension at the round-1 pin `4c8e7d4`. HEAD is materially
different code: `src/index.ts` grew from 23,683 to 40,693 characters, `src/evidence.ts`
(the Markdown companion generator) did not exist at the pin, and `src/ops.ts` changed. What
transfers and what does not was measured, not assumed:

| Round-1 finding | Transfers to HEAD? | Basis |
| --- | --- | --- |
| Fixed prompt overhead (5,982 vs 2,530 first-request input) | yes | same 9 registered tools; description literals 3,258 to 3,331 chars, +2% |
| Arm C behavior and cost | yes | `verifyBaseline` passes; skills and helper hash to locked values |
| Per-result context cost | no | `00615ab` rewrote presentation and added companions |
| The 1.92x aggregate token ratio | partly | the fixed-cost share transfers (L2, with no paid calls, was still 2.33x); the call-driven share does not (P2 11.3x, S2 3.6x) |
| Artifact-navigation failures (A1-E, P2-E hit the request limit) | unknown | `00615ab` added the source index and line ranges that target exactly this failure |
| Run-to-run variance, for sizing only | approximately | scatter is dominated by agent behavior, not presentation; label as prior |
| Quality deltas | no | superseded build, and they were indistinguishable anyway |

Round 1 is therefore evidence about a superseded build. It is reused for scorer validation,
for the arm-C reference, and for sample sizing. It is not reused as a HEAD measurement or
as a control arm, and every Tier 1 comparison is internal to HEAD.

Two consequences drive this plan.

First, money is not the constraint. Four cents bought 24 runs. The costs that matter are
wall clock, grading effort, and the risk of another inconclusive result.

Second, a rerun of the same quality comparison is not worth buying. Paired retrieval
deltas have SD 0.739 on the 0–2 scale, so detecting a 0.10 normalized difference needs
about 53 pairs; 0.15 needs 24; even 0.20 needs 14. Any design capped near 12 pairs will
report "inconclusive" again, whatever it scores.

The open question is therefore not "is the extension better" but "what is the extension's
roughly 2× context tax made of, and can it be removed without losing anything".

## 3. Tier 0: free re-analysis, no runs

Runs nothing. Reads what round 1 preserved and measures what can be measured statically.
Full work-package detail is in `docs/ab-tier0-spec.md`.

Inputs already on disk: per-run `answer` text, complete `events`, token `usage`,
`elapsedMs`, `parallelLiabilityMicro`, and `manifestHash` in every `run.json`; the full
`stdout.jsonl` event stream; the gateway SQLite ledger; and 15 frozen gold packets with
`requiredClaims` and `sources`.

Tier 0 produces four things:

1. Token-tax decomposition per arm: fixed system-prompt and tool-schema cost, per-result
   preview and excerpt cost, and re-read or navigation cost. The first is measurable
   offline from the two prompt compositions; the second from `bench/mock-provider.ts` with
   no model and no API; the third from the preserved event streams.
2. An objective scorer applied retroactively to all 24 round-1 answers, giving claim
   coverage and citation recall and precision for a corpus that cost nothing more.
3. Variance estimates for every candidate metric, which is what decides whether any Tier 1
   run is worth scheduling and at what sample size.
4. A validated metrics extractor, checked by reproducing the published round-1 totals.

Decision rule out of Tier 0: schedule Tier 1 only if the decomposition identifies an
addressable overhead component of at least 25% of the E arm's context total as measured on
HEAD, not on the round-1 totals, and the
objective scorer shows quality variance small enough for the planned Tier 1 sample to
resolve the non-inferiority margin in §4. Otherwise stop and report Tier 0 as the result.

## 4. Tier 1: intervention test, about 12 runs

Tier 1 does not re-ask the round-1 question. The token gap is already established at
p = 0.039 and would need only about 5 pairs to re-establish, which is not a use of runs.
Tier 1 tests whether a specific change identified in Tier 0 — for example artifact
navigation guidance, preview sizing, or schema trimming — actually reduces the tax.

Because the treatment repins to HEAD (
inclusive of the Markdown companion feature absent from round 1), Tier 1 measures its own
baseline rather than borrowing round-1 numbers as a control.

- Design: E at HEAD versus E at HEAD plus the intervention, paired on the same cases, 12
  runs. Grading is blinded to condition. Arm C may run as a six-run reference line at the
  same time; it is unchanged by the repin and is not the comparison under test.
- Round-1 E numbers serve only as variance priors for sizing. They are not a control arm.
- Primary endpoint: context tokens per covered claim, a ratio metric whose paired log SD
  is already known to be 0.742 from round 1. At that variance, 12 pairs resolve a 45%
  reduction and 8 pairs resolve a 60% reduction.
- Non-inferiority guard: claim coverage must not fall by more than 0.10 against the
  pre-change arm. A token win bought by a worse answer is not a win.
- Secondary, descriptive: citation recall and precision, wall seconds, request-limit hits,
  and paid dispatches on the restraint cases where the correct behavior is not to search.
- Cases: the gold-covered search-centric subset D1, D3, S2, K1 plus the two restraint
  cases E2 and L2. No new gold curation.
- Round-1 failure modes to watch, not to score: A1-E and P2-E both exhausted the
  12-request limit navigating saved artifacts, and P2-E alone consumed 92,877 context
  tokens against 8,213 for its pair.

## 5. Tier 2: quality superiority, deferred

A defensible quality claim needs roughly 50 pairs at observed variance, meaning about 100
worker runs. Parallel spend for that is still under a dollar; the real cost is wall clock
and grading. Run it only if an external claim requires it. Otherwise round 1's "no
detectable quality difference" stands as the answer, and it is a legitimate answer.

If Tier 2 ever runs: one blinded judge, objective claim scoring first, judge only for
claims the matchers cannot decide. No dual-rater reconciliation, no adjudication council.

## 6. Scoring

Claim matching is hybrid, because the gold is hybrid. Concrete claims are deterministic
(D3-c1 "final supported date is November 9, 2028", L2-c1 "total is $0.04"). Behavioral
claims are not (E2-c3 requires establishing that no research request was issued, which is
a statement about the event trace, and S2-c4 is comparative). Roughly two-thirds of gold
claims take frozen regex matchers; the remainder are evaluated from the event trace where
mechanical, and only otherwise by the judge. Matchers are frozen with hashes before use,
and the split is recorded per claim so nobody later mistakes a judged claim for a matched
one.

## 7. Isolation

Tier 0 needs no sandbox. It reads preserved records offline. Its only requirement is write
hygiene: new scripts write new paths, and `bench/manifest.json`, `bench/summarize.ts`, and
`.pi/benchmark/data/frozen-reporting/` stay untouched as the frozen record of round 1.

Tier 1 and Tier 2 reuse the round-1 isolation stack unchanged.

Containers (`bench/sandbox.ts:7`): rootless Podman with `--rm --read-only --cap-drop=all
--security-opt=no-new-privileges`. One writable mount, `/work`. Pi at `/opt/pi` and the
observer at `/opt/bench` are read-only. Arm E additionally mounts the extension and only
the `find-docs` skill; arm C mounts the skill bundle, the helper, and the shim bin. Two
arm-specific frozen images, `6532ff36a961…` for E and `c96c1aa2c45e…` for C, recorded in
`bench/manifest.json`, so the other arm's tooling is absent rather than merely unused. The
smoke image `a5c80c8e1a0a` is a build base, not a run image.

Agent configuration (`bench/sandbox.ts:15`): Pi launches with `--no-session
--no-context-files --no-extensions --no-skills --no-prompt-templates --no-themes
--offline`, plus `PI_OFFLINE=1`, `HOME=/work/home`, and `PI_CODING_AGENT_DIR` inside the
workspace. Host `AGENTS.md`, installed skills, sessions, and themes cannot reach a worker.
Only the observer and, for E, the extension load explicitly by path. Both arms receive the
identical `--append-system-prompt` addendum. Per-run `settings.json` disables compaction
and retry, which is what makes token counts comparable.

Credentials (`bench/run.ts:41`): each run gets a mode-0600 env file holding a gateway-only
token in both `PIPARA_API_KEY` and `PARALLEL_API_KEY`, all base URLs pointed at the
gateway, and platform and account URLs pointed at `/denied/*` so account mutations fail
closed. The real key never enters a container. The env file is removed in a `finally` and
the ledger closes the run.

Data: fresh `/work` per run at mode 0700, fixture copied in, gold packets never mounted,
no sibling run state. Host-side capture strips thinking content and credential-shaped
fields before writing `stdout.jsonl`. Deadlines are enforced by `podman kill` and
`rm -f`.

Provenance (`bench/prepare.ts:16`): the treatment is exported with `git archive` from a
pinned commit rather than the working tree, and `freeze()` hashes every mounted file into
the manifest. Pi 0.86.1, `parallel-web` 1.3.3, and Context7 0.5.11 are version-checked at
prepare time and the build fails on drift.

Pin decision, settled: Tier 1 repins to HEAD `3b285e3`. `bench/core.ts:8` `PIN` changes
from `4c8e7d4` to `3b285e3`, then `node bench/prepare.ts --prepare` rebuilds both arm
images and `--freeze` writes a new manifest; the previous manifest is archived by hash
under `.pi/benchmark/data/manifests/`. Arm C is unaffected in content:
`verifyBaseline` against `docs/benchmark-cli-baseline.lock.json` passes today, so the
quarantined skill bundle and Responses helper still hash to their locked values. The
consequence is deliberate: round-1 results become prior evidence, not a shared control,
and every Tier 1 comparison is internal to the HEAD build.

One limit stated plainly. Network is unrestricted by explicit decision, so this is
credential and spend containment, not traffic containment; gateway logs do not prove what
else a worker reached.

## 8. Budget

- Tier 0: $0. No model calls, no API calls, no containers.
- Tier 1: under $0.10 Parallel spend at round-1 rates, cap $0.50. Model inference runs on
  subscription-backed routes and is not billed against the Parallel ceiling.
- Tier 2, if ever: about $0.20 Parallel spend, cap $1.00.
- The $25 Parallel ceiling is unchanged and is not approached by any tier.

## 9. Out of scope

FindAll, Monitor, Memory, enrichment, and webhook comparisons: no gold exists and round 1
did not cover them. New gold curation. The in-extension
`PIPARA_OUTPUT_FORMAT=json|readable` comparison, which is a separate question the README
already documents and which Tier 0's static preview measurement partly answers for free.
Product tuning between Tier 1 looks.
