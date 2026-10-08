# Benchmark plan: native tools versus Parallel CLI and Pi-adapted skills

Status: implementation, the reduced 30-worker sequence, and a later Grok overlay of the six remaining grading disagreements are complete. Original rater scores are unchanged. The overlay is not a third independent model and is not rater consensus. The benchmark does not establish extension superiority.
Results: [benchmark-results.md](benchmark-results.md). Original disputes and overlay records: [benchmark-adjudication.md](benchmark-adjudication.md).
The sections below preserve the protocol and its original planning decisions. The later user instruction “go” authorized execution.

The spending ceiling is $25 for Parallel.ai usage only. Model inference is outside that ceiling.
Planning made no Parallel API calls. The benchmark must not change either product under test.

## 1. Question and limits

Does the extension help an agent retrieve needed evidence sooner, select suitable capabilities, and resolve problems accurately at lower token or time cost?

The primary comparison uses the same Pi version and model for both arms. It compares the [frozen treatments](#3-frozen-treatments).
It does not isolate the causal effect of wording from tool schemas, defaults, output formatting, or skill discovery.
It does not establish superiority across all models, hosts, domains, or research tasks.
This first corpus focuses on developer documentation and local project work. It does not measure news, markets, medicine, or general business research.

The primary result uses 12 task pairs on Kimi-K3. Three pilot pairs precede it.
The default sequence contains 30 worker runs, down from 60. A pair contains one run of each treatment.
Optional replication uses three selected tasks on each of Grok 4.6 and GPT-5.5.
Replication and live diagnostics are disabled by default. Enabling them requires an explicit choice before primary results are visible.
The reduced sample preserves category coverage but gives less precise comparisons. Inconclusive results become more likely.
Fewer worker runs reduce elapsed work, but do not guarantee exactly half the wall-clock time.
No test implementation or live benchmark execution is authorized by this planning artifact alone.

## 2. Fusion decision record

Two independent proposals completed. GPT-5.5 compared their agreements, disagreements, coverage, and omissions.

| Role | Canonical model | Fabric run |
|---|---|---|
| Practical design | `fireworks/accounts/fireworks/routers/kimi-k3-fast` | `ee1e78b0256e44c2a1356ad363df42ed` |
| Fairness and adversarial review | `xai/grok-4.6` | `a6efdc13aaca4bada523a108f6dc14f9` |
| Judge | `openai-codex/gpt-5.5` | `308f9f7c10ae4ec88c0ab3f5f32e228b` |

Panel agreement covers paired runs, isolated environments, unchanged skills, hidden gold answers, separate cost accounting, negative controls, and limited claims.
Kimi proposed a simpler single-model primary sample. Grok emphasized leakage, spending controls, and incomplete pairs.
The judge selected Kimi's primary sample and Grok's stronger controls.

Main resolved these remaining design problems:

- An asymmetric feature inventory cannot count toward the primary paired sample. It is a separate descriptive check.
- An offline answer does not need web citations. Its quality rubric uses local evidence instead.
- Cached input tokens count toward context consumption. They appear separately in the report as well.
- Zero-dollar tasks have no evidence-per-dollar ratio. They do not receive an artificial denominator.
- A ledger after dispatch cannot guarantee the cap. The gateway reserves liability before each dispatch.
- A $1.50 ceiling for every pair does not fit 24 pairs within $21. The [budget allocation](#9-budget-and-hard-admission) fits arithmetically.
- The original matrix contained 24 shared-capability tasks, separate from fixture-only safety tests.

The user subsequently requested half as many bouts to reduce wall-clock time.
The active matrix now contains 12 primary pairs and three pilot pairs. Optional replication and live diagnostic counts are also halved.
This revision does not rerun the fusion panel or weaken fairness and spending controls.

The user then supplied `/home/jangpi/.agents/.quarantined/parallel-cli` as the Pi-adapted baseline.
The comparison now uses that bundle and its Responses helper rather than the upstream skill tree.
The original fusion findings remain historical advice, not a review of this newly supplied bundle.

The panel did not unanimously select every analysis threshold. These are Main's preregistered design choices after adjudication.

## 3. Frozen treatments

| Component | Pin |
|---|---|
| Extension | `4c8e7d4d4ad34432dbf2ab5e9151daa155b45f2a` |
| Parallel CLI repository | `12393045b6a17b32a9a28f68c48f1526066b5c29` |
| Pi-adapted skills and helper | SHA-256 entries in `benchmark-cli-baseline.lock.json` |
| Upstream skills comparison reference only | `26574f44949334bee46ec6bc7a1c4eba9c08c3c2` |
| Observed local Pi version | `0.86.1` |
| Observed local CLI version | `0.9.3` |

The repositories are [parallel-web-tools](https://github.com/parallel-web/parallel-web-tools) and [parallel-agent-skills](https://github.com/parallel-web/parallel-agent-skills).
The CLI retains its original-session commit. The skills use the supplied local bundle, not the upstream tree or a moving latest release.
The source bundle contains ten skills and one additional Responses reference. Nine skill files differ from upstream, while `status` is unchanged.
The bundle omits upstream `choose-your-parallel-api`, `migrate-to-parallel`, and `parallel-mcp-setup`.
A future upstream replication needs a separate treatment label and does not add bouts to this reduced sequence.

Arm E loads the extension and the neutral observation extension. It has no Parallel skills or CLI executable.
Arm C loads the same observer, the pinned CLI, ten Pi-adapted skills, and the pinned `parallel-research` helper.
It has no native Parallel tools. The helper is a supplied capability, not a forbidden direct-API workaround.
Both arms receive the same ordinary Pi tools and task files.
Both arms also receive the same pinned find-docs skill and Context7 CLI access, as selected by the user.
No other research tools, MCP servers, web browsers, global skills, or home instructions are available.

The baseline preserves the supplied skill descriptions, body text, referenced files, helper behavior, and CLI defaults.
Explicit benchmark loading does not move or activate the quarantined files in the user's normal environment.
It does not preload every skill body or force a skill invocation. Skill discovery is part of the measured product.
Installation and authentication occur before timed runs. Installation reliability is not a primary endpoint.

The Pi-adapted Search and Extract skills remove the upstream Claude-specific fork metadata.
The supplied router recommends fast Search with five results and a 12,000-character starting excerpt allowance.
It also covers direct Responses synthesis, saved-artifact reuse, continuation, and account-specific Memory eligibility.
These are substantive guidance changes, not just host-format changes. The report attributes them to the baseline.
Historical account-eligibility statements remain supplied advice, not verified current service facts.

Arm C supports Responses through `parallel-research`, with low effort by default and `--previous-response-id` for follow-ups.
Search/Extract, Responses, and justified research workflows can receive full synthesis credit in either arm.
The inventory report still lists genuinely unavailable features without assigning an artificial zero.

### Shared documentation prerequisite

The Search router first directs developer API questions to `../find-docs/SKILL.md`.
That path is absent from the supplied bundle. The user selected shared find-docs access rather than a benchmark-only skill edit.
Both arms receive `/home/jangpi/.agents/skills/find-docs/SKILL.md`, pinned in the baseline lock.
The harness mounts it at the same read-only path in both arms, as a sibling of the CLI skill directories.
This resolves the existing relative reference without changing the supplied files.

Both skill catalogs include find-docs. E has one shared skill. C has ten Parallel skills plus that same shared skill.
Both arms receive the same Context7 executable, configuration, credential eligibility, and network access.
The skill requests `npx ctx7@latest`. Preflight freezes its resolved package version and integrity in an identical local cache for both arms.
Timed runs cannot update that package. The execution manifest records this common reproducibility constraint.

A successful Context7 lookup can settle the evidence gap without a Parallel call.
The benchmark now compares the two research packages within this shared documentation environment.
No new bouts, subscription purchases, or top-ups follow from this choice.
Claims about Parallel use remain conditional on a gap that the shared documentation tool did not settle.

## 4. Isolation and prompt parity

The selected sandbox is rootless Podman, with unrestricted outbound access and a fresh container per run.
The smoke image is `localhost/pi-parallel-smoke:20260920`. Its immutable ID and observed versions are in `benchmark-preflight-results.json`.
The tested launch uses a read-only root, dropped capabilities, no-new-privileges, and explicit read-only package mounts.
Each run receives a fresh workspace, HOME, Pi agent directory, temporary directory, session, and artifact directory.
The working directory is outside this repository and outside any ancestor with agent instructions.
Only task files and the arm's read-only package mounts are visible.
Gold answers, other runs, this plan, and the author's guidance are absent.

Common launch settings disable implicit context, extensions, skills, templates, and themes.
Explicit paths then load the observation extension and the arm's resources.
Pi supports explicit `--skill` paths with `--no-skills`, and explicit `-e` paths with `--no-extensions`.
The implementation must assert the effective resource list, not trust flags alone.

The shared task addendum is exactly:

> Complete the task using the resources available in this workspace. Ground material factual claims in evidence you can inspect. If essential information is missing, say what is missing. Do not expose private data. Do not make persistent account changes or create recurring services.

It contains no product name, preferred tool, one-miss rule, or tool-selection ladder.
The harness uses `--append-system-prompt`, never a replacement prompt.
It preserves extension guidelines in E and the supplied Pi-adapted skill catalog in C.
Natural prompt sizes remain unequal. Their token cost is part of the comparison.

Before dispatch, the observer records a redacted effective provider prompt and tool schemas.
Assertions reject leaked home instructions, duplicate extension copies, missing skills, unexpected tools, or cross-arm paths.
The CLI catalog must contain exactly the ten pinned Parallel skills.
The shared find-docs prerequisite must appear identically in both arms and in the final resource lock.
Effective skill counts are one for E and eleven for C, including the shared skill.

Both arms use one pinned model, provider route, reasoning level, and sampling configuration per block.
The Kimi route can resolve to a changing upstream model. The lockfile records both selected and resolved identities when available.
An undisclosed router change limits model-specific claims. It must never trigger a silent fallback to another model.

### Model authentication and refresh

The selected OAuth providers, Codex and xAI, both refreshed successfully inside Podman after forced expiry.
Both rotated their access and refresh tokens. Each then completed a new inference request with the refreshed credentials.
Only the selected provider's credential record entered each writable profile. The host's full auth file was not mounted.

The probe held Pi's host auth-file lock during each refresh and saved the rotated record before releasing it.
The benchmark runner must preserve this coordinated persistence behavior. It must not discard a rotated token with an ephemeral container.
Independent copies of the same refresh token must not refresh concurrently.
A single credential owner must coordinate refresh and update the authoritative provider record without overwriting unrelated providers.
The preflight recorded successful forced refresh and persistence.
The runner now calls `withCredentials` in `bench/auth.ts`, which holds the host auth lock through execution and writes rotated credentials back.
Primary workers used a Fireworks API key, so the timed primary sequence did not exercise long-lived OAuth refresh.

The gateway keeps the real Parallel credential outside both agent environments.
E receives a per-run dummy `PIPARA_API_KEY` and `PARALLEL_BASE_URL`.
C receives a per-run dummy `PARALLEL_API_KEY` and `PARALLEL_API_URL`.
Both URLs point to the gateway, which replaces authentication only after admission.
The supplied Responses helper hardcodes its HTTPS URL and ignores these base-URL overrides.
A harness-only transport adapter must redirect that exact URL to the same gateway without changing request bodies, retries, outputs, or exit behavior.
The helper itself remains byte-identical to its lockfile. The adapter has a separate hash and a visible treatment note.
Offline request-parity tests must prove the redirect and dummy-key isolation before live use.
Account and platform URLs point to a deny-only endpoint.
No secret store or real Parallel credential is mounted inside a run.

The user requires unrestricted network access for both arms.
The harness applies no outbound firewall, destination allowlist, DNS filter, or general-purpose proxy requirement.
Direct public HTTP requests, curl, and other public research routes are permitted equally in both arms.
Filesystem, process, session, and credential isolation remain in place. Network access does not grant access to host credentials or sibling files.

The Parallel gateway is a credential and spending boundary, not an internet access restriction.
The supplied tools and Responses adapter use it because it alone holds the real Parallel key.
A direct unauthenticated Parallel request can reach the service but cannot spend through the user's withheld credential.
The gateway authenticates per-run tokens, binds research IDs to their owning run, and never returns the real key to agents.
Account-mutation gates remain application authorization controls, not network blocks.

The report records external routes visible in tool events, outputs, saved sources, and gateway logs.
It does not claim complete inspection of encrypted network traffic or prove absence of unobserved disclosures.
A suitable non-Parallel route is not a protocol failure. The benchmark measures the packages in an open-network environment.

## 5. Cases, pilot, and order

The companion `benchmark-cases.json` contains exact prompts, fixture requirements, acceptable capabilities, and hidden-oracle instructions.
Only `primary_task_ids` and `pilot.active_case_ids` select scheduled cases. Other catalog entries are deferred, not additional work.
Gold preparation and scoring cover only selected cases. Its hidden fields never enter the agent workspace.

| Primary block | Tasks | Main purpose |
|---|---:|---|
| Known URL | 1 | K1: read a supplied source without redundant discovery |
| Source discovery | 2 | D1, D3: retrieve missing external evidence |
| Cited synthesis | 1 | S2: resolve several facts without a mandatory tool ladder |
| Ambiguous problems | 2 | A1, A2: local miss versus missing user intent |
| Local and offline | 2 | L1, L2: avoid unnecessary retrieval |
| Existing evidence | 1 | E2: recover omitted content from a saved artifact |
| Private boundaries | 1 | P2: permit sanitized research without disclosing private data |
| Multi-step research | 2 | R1, R2: follow-up reuse and multi-row research |
| Total | 12 | 24 primary runs |

Three pilot cases use different facts from the primary set: pilot-K, pilot-L, and pilot-R.
They exercise extraction, local evidence, and a lookup followed by artifact reuse.
The reduced suite defers repeated facts and the dedicated deep-research case. It retains every primary category.
Pilot runs calibrate instrumentation and rubrics. They do not contribute to primary scores.
Any harness or rubric change after the pilot freezes a new manifest hash before primary runs start.

The scheduler uses a seeded permutation within blocks and balances E-first and C-first across all pairs.
It executes the two arms of a pair consecutively, without sharing results.
It serializes timed runs to reduce local contention. It records unavoidable provider queue and backend variation.
Paired timing does not eliminate upstream cache effects. Order balance and timestamps make that limitation inspectable.

The primary analysis uses one run per arm per task. It measures task coverage, not within-task variance.
Optional replication repeats tasks D1, A1, and L1 on both Grok and GPT-5.5.
The primary block has six E-first and six C-first pairs.
The three-pair pilot uses a seeded 2:1 order split. The two replication models use complementary 2:1 and 1:2 splits.
Model results remain separate. Their small samples are descriptive.

Run limits are identical across arms: 12 model turns, 20 agent tool calls, and 150,000 cumulative context/output tokens.
The output ceiling is 4,096 tokens per model response where the provider supports it.
A prior local Codex run rejected `max_output_tokens`. Preflight must not assume support from another provider's payload shape.
For an unsupported route, both arms retain the same native output limit and record it explicitly.
Token limits stop admission of another request after the cumulative threshold. They are not a promise to truncate an in-flight response.
An external supervisor enforces deadlines. A thrown Pi hook error is not a reliable stop mechanism.
The mocked preflight must prove that the chosen abort path prevents another provider request.
Local-only tasks allow 120 seconds. Retrieval tasks allow 600 seconds.
Limits include skill reads, shell calls, and failed tool attempts. HTTP polling is logged separately from agent tool calls.
Both arms receive the same terse limit notice. The notice does not suggest a retrieval method.

## 6. Gold answers and ambiguity

A curator freezes each answer packet before the primary run.
The packet records required claims, authoritative URLs, source dates, exact evidence passages, valid alternatives, and a grading rule.
Direct downloads from already known official URLs need no Parallel API charge.
Any Parallel calls for answer preparation still debit the dedicated gold budget.

For version-specific tasks, the oracle uses documentation for that version.
For current facts, the oracle records an explicit UTC observation time.
If sources change between arms, the task receives a drift flag and results include a sensitivity analysis.
No outcome disappears merely because one arm encountered worse sources.

The ambiguous block contains one resolvable question and one case where user intent is genuinely missing.
A correct targeted clarification is terminal success in the latter case.
For resolvable questions, needless clarification is not equivalent to a supported answer.
The scorer uses the task's predeclared distinction, not a retrospective preference.

The external transcript-mining project is not available to this benchmark yet.
Its later cases can form a held-out replication after de-identification and leakage review.
They must not replace difficult primary cases after results are known.

## 7. Metrics

### Primary: appropriate retrieval behavior

Each task receives a score from 0 to 2:

- Full credit (2): Suitable first evidence action, correct local/web boundary, and no unnecessary paid duplicate.
- Partial credit (1): A recoverable selection detour or needless extra step, followed by a suitable evidence path.
- No credit (0): Unresolved misuse, fabricated support, prohibited disclosure, or retrieval against an explicit restriction.

Each oracle defines acceptable capabilities as a set, not one required tool name.
Shared documentation and other public retrieval routes are acceptable when they supply the task's required external evidence.
The agent receives no penalty for omitting Parallel after another route settles the gap.
Treatment-specific usage is recorded separately from the correctness of that choice.
Local-only, offline, artifact-only, and missing-user-intent constraints still apply.
A higher tier is not automatically wrong. Its suitability depends on the task and evidence need.
Feature availability, syntax mistakes, boundary violations, and backend failures receive separate diagnostic labels.

The primary effect is the mean paired score difference, E minus C, across the 12 selected tasks.
The report also separates web-needed and no-web strata. An aggregate cannot conceal excessive retrieval on negative controls.

### Trigger timing

For obvious external gaps, the opportunity begins when the agent receives the task.
For seeded local misses, it begins when the agent receives the decisive missing-evidence tool result.

A whiff is an authoritative, task-relevant local check that fails to supply the needed external fact.
An ordinary filename search or productive debugging step is not automatically a whiff.
Repeated reads that establish new local facts are not penalized as repeated misses.

The report records:

- Retrieval before any unnecessary local attempt on obvious external gaps.
- Retrieval before a second redundant check after a decisive local miss.
- Agent actions and elapsed time from opportunity to valid research dispatch.
- Skill reads, CLI help calls, and command repairs as separate preparation overhead.
- Cases where the agent answers without adequate evidence.

Raters label opportunity events from observable inputs and outputs. They do not inspect private reasoning.
No external retrieval yields a censored latency, not a zero-time success.
The report separates first external evidence from first Parallel dispatch.
Sufficient evidence from Context7 or another public route makes Parallel escalation unnecessary, not a missed trigger.
For an unresolved external lookup, the Parallel opportunity starts when that result exposes the remaining evidence gap.
Parallel-specific trigger results are conditional diagnostics because each treatment can produce a different set of unresolved gaps.

### Answer quality, 0 to 4

One point each measures:

1. Correct required conclusion or correct targeted clarification.
2. Coverage of the task's required claims and constraints.
3. Traceable support from sources or local artifacts that this run actually inspected.
4. Appropriate treatment of versions, dates, conflicting evidence, and unresolved uncertainty.

For web tasks, support includes claim-level citation accuracy and source authority.
For local tasks, support refers to the supplied files and computations.
A fabricated material citation makes the run unsuccessful regardless of its total points.
A successful resolution requires at least 3 points and no material wrong conclusion or critical boundary violation.

### Tokens, money, and evidence efficiency

The record stores uncached input, cache-read input, cache-write input, output, and reported reasoning tokens separately.
The implementation follows each provider's accounting semantics and avoids counting reasoning tokens twice.

Context tokens equal input plus cache-read plus cache-write plus output, where those fields are disjoint.
The report includes total context tokens, output tokens, prompt overhead, tool-result tokens when measurable, and monetary model estimates separately.
Provider subscription estimates are not Parallel charges.

Evidence efficiency equals `sum(quality points) * 10000 / sum(context tokens)` within each comparable stratum.
A second measure uses supported required claims per 10,000 context tokens.
Both include failed and timed-out runs. Neither rewards an unsupported short answer.

The report separates evidence from Parallel, Context7, other public routes, local sources, and mixed sources using claim-level provenance.
Parallel-specific efficiency uses supported claims attributable to Parallel per actual Parallel dollar.
Mixed-source resolutions report end-to-end quality and separate service costs, not wholly Parallel-attributed credit.
Zero-dollar strata report N/A for this ratio and show zero spend directly.
Context7 calls, latency, returned evidence, token impact, and available charge data appear separately.
Unknown Context7 or other service charges remain unknown, not zero. They do not debit the Parallel-only ceiling.
Open network access does not authorize new subscriptions, purchases, or top-ups.
API costs include retries, partial jobs, errors with uncertain billing, and preparation calls.
If the provider does not expose exact billing, the report labels a conservative reserved-liability amount instead of calling it actual spend.

### Time and reliability

Total time starts at task dispatch to an already initialized agent and ends at its final answer or clarification.
A follow-up case includes its prescribed second user message and final reply.
Startup time is recorded separately. Agent CPU, model latency, and research wait appear separately where measurable.

Time to justified resolution is defined only for answers that pass the rubric.
The primary time comparison uses restricted mean time at the common deadline, with unsuccessful runs censored there.
Successful-only medians are descriptive because they can reward fast failures.
Two ambiguous cases support case-level comparisons, not a broad latency claim.

Additional metrics cover malformed calls, repair turns, artifact reuse, duplicate creation, missing continuation IDs, and partial results presented as complete.
They also cover unnecessary paid calls, private query content, blocked mutations, and gateway denials.

## 8. Rating and analysis

Two independent model raters, Grok 4.6 and GPT-5.5, score anonymized answers against frozen gold packets.
They receive neutral capability labels instead of product names wherever possible.
The transcript mapper preserves meaningful actions and does not remove errors or extra steps.
A scorer cannot be fully blind when output formats reveal the treatment. The report states that limitation.

Raters must cite evidence-event IDs for every penalty and awarded evidence point.
Disagreements receive a second structured comparison. Remaining disagreements go to the operator for adjudication.
No judge fetches new paid evidence by default. Missing gold support is a curator defect, not permission to invent an answer.
The report includes agreement rates and adjudication counts.

The analysis computes paired deltas and a 95% bootstrap interval over task pairs using 10,000 resamples.
The fixed mixture of task blocks remains explicit. Results include raw scores so another analysis can reproduce the comparison.
An exact paired sign test provides a small-sample robustness check for the primary ordinal endpoint.
The corpus repeats some underlying source facts across different workflows. Those tasks are not independent samples of technical knowledge.
The manifest also records source-family clusters, and the report includes leave-one-family-out results.
The bootstrap interval describes this task mix. It is not a population confidence claim across unseen domains.
If one source family explains the advantage, the report labels the result family-specific instead of generally superior.
Secondary metrics are descriptive. No selection of a favorable secondary metric can replace a failed primary result.

A bounded superiority statement requires all these preregistered conditions:

- Primary mean improvement is at least 0.25 points on the 0–2 scale.
- Its 95% paired interval excludes zero in the favorable direction.
- Quality degradation is ruled out beyond 0.25 points on the 0–4 scale by the paired interval.
- There are no extension-specific critical privacy or authorization violations.
- Results remain favorable when incomplete runs receive their conservative failure scores.

Otherwise, the report states inconclusive, mixed, or worse as appropriate.
The margins are engineering choices, not validated psychometric thresholds.
The report does not convert 12 tasks into a universal superiority claim.
The smaller sample does not lower the claim thresholds. It instead increases the chance of an inconclusive result.

An attempted primary pair stays in the outcome table.
Product errors, tool misuse, budget denials, and timeouts are outcomes, not reasons to rerun until success.
Only a verified harness transport fault permits one replacement pair, with the original attempt and its charges retained.
Unattempted pairs due to the global cap remain visible. A truncated sample loses the planned superiority claim.

## 9. Budget and hard admission

| Envelope | Maximum Parallel spend |
|---|---:|
| Gold preparation | $1.00 |
| Three pilot pairs | $1.00 |
| 12 primary pairs | $6.00 |
| Three pairs on each of two replication models | $3.00 |
| Optional live lifecycle diagnostic | $1.00 |
| Contingency, including verified harness-fault retries | $1.00 |
| Planned total, including optional phases | $13.00 |

The default gold, pilot, and primary allocations total $8.00 before contingency.
The completed sandbox smoke test reserves $0.024 against contingency, leaving $0.976 in that envelope.
This is conservative request-price accounting, not invoice reconciliation. `benchmark-preflight-results.json` records the six successful requests.
The original $25 authorization remains an absolute ceiling, not a reason to add bouts or spend unused funds.
The reduced plan allocates only $13.00. Additional phases remain disabled unless explicitly selected.

Each primary or replication pair reserves at most $0.50, equally split between arms.
This is a ceiling, not a target or prediction. Known zero-retrieval cases reserve zero.
Each pilot pair reserves at most $0.30. Three pairs leave $0.10 inside the pilot envelope.
Unused allocations do not justify extra exploratory runs or post-result tuning.
Optional phases start only after both primary arms finish and all open liabilities fit the remaining cap.

The gateway stores integer microdollars in a durable SQLite ledger.
Every transaction preserves `settled + uncertain_liability + active_reservations <= 13000000` for this reduced plan.
The absolute authorization limit remains 25,000,000 microdollars. It never overrides a tighter phase or plan limit.
Envelope and per-arm limits must hold within the same transaction.
The pair reservation guarantees equal funds before either arm starts.

Before every authenticated Parallel request that it forwards, the gateway performs these steps:

1. Validate the per-run identity, endpoint, request shape, price entry, and remaining reservation.
2. Calculate the maximum possible charge, including rows, URLs, matches, or hidden subruns.
3. Persist the charge liability before network dispatch.
4. Forward the request with the real credential and a unique request record.
5. Reconcile only when authoritative billing or a documented terminal outcome permits it.

An SDK retry is a separate HTTP dispatch and needs separate admission.
Polling is free only when the locked price contract says so.
A timeout never releases uncertain liability merely because the caller stopped waiting.
A crash after dispatch retains liability after restart. Duplicate job creation is never used as a recovery shortcut.
The gateway itself must not retry an uncertain billable create automatically.

Search pricing includes result-count surcharges. Extract pricing counts every submitted URL.
Task Group pricing reserves the sum of all runs before adding the batch.
FindAll needs bounded matches, an explicit tier, and a documented billing maximum.
If matches can exceed the requested cap without a billing guarantee, live FindAll is denied in this benchmark.
Unknown endpoints, unpriced fields, and unbounded requests fail closed.

Recurring monitor creation, account mutations, credit purchases, and destructive memory actions never reach the live service.
Safety fixtures can record attempted calls without executing them.
The authorization tests do not accidentally create recurring spend.

Current source prices are starting estimates, not a permanent billing contract.
Before live execution, the curator freezes official prices and effective billing terms in `prices.lock.json`.
If taxes, billing multipliers, or unknown units prevent a strict dollar bound, the preflight fails until they are bounded.
An unproven hard cap means no paid dispatch, not a best-effort promise.

## 10. Fixture-only checks and optional diagnostics

Nonbillable deterministic checks cover repeated create after timeout, partial Responses output, event cursor continuation, and canceled streams.
They also cover artifact recovery, known memory entries, denied recurring monitors, and denied account mutations.
All nine extension tools receive an inventory or lifecycle check.
Shared semantics receive a CLI counterpart where one exists.
These checks report routing and lifecycle behavior, not live research quality or latency.

The optional $1 live diagnostic envelope covers at most one lifecycle pair.
The predetermined scenario is a Task continuation after a short caller wait. Dedicated live enrichment diagnostics are deferred.
No new job replaces an existing job merely to obtain a clean result.

A matched-configuration Search replay can use existing recorded requests without another model call.
It belongs in the diagnostic envelope and must fit its reservation before dispatch.
It can investigate default-mode effects. It is not a substitute for the unmodified primary treatments.

## 11. Implementation work packages

The existing repository is TypeScript. The harness can reuse its Node test setup and Pi integration patterns.
No new framework or production extension changes are needed.

| Planned file | Responsibility | Acceptance check |
|---|---|---|
| `bench/manifest.json` | Frozen cases, model pins, versions, order, limits, and hashes | Exactly 12 selected primary cases, three pilot cases, and balanced primary order |
| `bench/gateway.ts` | Price admission, proxy, SQLite liabilities, fixture mode | Concurrent, retry, crash, and unknown-price tests never exceed cap |
| `bench/observer.ts` | Neutral Pi events, prompt capture, timestamps, usage | Identical observer in both arms, no prompt mutation |
| `bench/run.ts` | Isolated resources, pair scheduler, deadlines, exports, helper transport adapter | No real Parallel credential inside runs, no cross-arm reads, helper payload parity |
| `bench/score.ts` | Gold packets, two-rater scoring, disagreement queue | Hidden gold, event-linked judgments, explicit missing scores |
| `bench/report.ts` | Paired statistics, cost tables, complete outcome inventory | Includes failures, censoring, raw deltas, and every charge |
| `bench/fixtures/` | Local files, source snapshots, canonical failure streams | Agents see only task-specific inputs |
| `bench/*.test.ts` | Offline acceptance checks | Paid endpoints never contacted by tests |

The first implementation step freezes resource hashes and builds the mocked, nonbillable preflight.
The second step implements and tests gateway admission, including concurrent pair reservations.
The third step implements observation and verifies prompt isolation with local probes.
The fourth step builds gold packets for the 12 selected primary tasks and three selected pilot tasks.
The fifth step runs the funded pilot only after all offline gates pass.
The last steps freeze the final manifest, run complete primary pairs, score, and report.

Proposed commands such as `bench/run.ts --preflight` are future interfaces, not installed commands.
The implementer must document actual commands when the harness exists.

## 12. Deliverables and execution gates

Each run produces prompt metadata, tool events, research receipts, output artifacts, final answer, token counts, and elapsed times.
The dataset separates raw transcripts, redacted shareable records, gold packets, and scored summaries.
Every record contains task, arm, model, pair order, version hashes, and budget identifiers.

The final report contains the primary effect, interval, claim decision, and per-stratum results.
It also contains quality, token efficiency, Parallel charges, censored time, guard failures, and an incomplete-pair inventory.
The operator can inspect every grade against an event ID and a source passage.

Live execution starts only when these gates pass:

- Both pinned treatments load correctly without home guidance.
- All ten supplied skills and the Responses helper match the source lock without content changes.
- The shared find-docs skill matches its hash and its relative reference resolves in the CLI arm.
- Both arms use the same frozen Context7 package and eligibility, with its use recorded.
- Both arms have unrestricted outbound access, verified with a public endpoint outside the named research services.
- Real Parallel credentials remain outside runs, and gateway tokens cannot retrieve another run's research IDs.
- The Responses helper reaches the gateway through a verified transport-only adapter.
- The observer confirms the actual provider prompt and tool catalog for each arm.
- The spending gateway passes pre-dispatch, concurrency, retry, timeout, and restart tests.
- Real research credentials and hidden gold remain outside agent access.
- Official prices and complete-pair reservations fit the dollar ceiling.
- All 12 selected primary gold packets and three selected pilot packets are complete and frozen.
- No deferred catalog entry or disabled optional phase enters the scheduled run list.
- Offline fixtures and report calculations pass targeted tests.

These gates were the implementation acceptance criteria. The reduced harness later ran the scheduled 30 workers, scored them, and produced the reports linked at the top of this plan.

## 13. Evidence used for this plan

### Completed sandbox smoke test

`benchmark-preflight-results.json` records the Podman probe, model authentication, forced refresh, isolation checks, and Parallel liability.
Native Search, Extract, and Responses succeeded. CLI Search, Extract, and the Responses helper also succeeded.
Context7 library discovery and documentation retrieval succeeded without Context7 credentials.
Kimi, GPT-5.5, and Grok 4.6 completed inference inside their isolated profiles.
GPT-5.5 and Grok 4.6 also completed inference after forced OAuth refresh.
The source directories remained unchanged. Disposable credential copies were removed after the refreshed records reached the host.
This test does not replace the full benchmark acceptance gates.

### Earlier local checks

Local checks established the following facts without paid research:

- `pi --version`: `0.86.1`. `parallel-cli --version`: `0.9.3`.
- `parallel-cli search --help`: basic mode default, JSON output, source filters, and output files.
- `parallel-cli research run --help`: pro-fast default, persisted outputs, continuation IDs, and no-wait mode.
- The earlier upstream probe loaded 13 skills. The supplied Pi-adapted bundle loaded ten skills with zero warnings.
- All 11 supplied Markdown files and the helper were read. SHA-256 hashes are in `benchmark-cli-baseline.lock.json`.
- `parallel-research --help` and `--dry-run` succeeded without a research request or output-file creation.
- The helper source hardcodes `https://api.parallel.ai/v1/responses`, reads `PARALLEL_API_KEY`, and performs no automatic retry.
- Pi `docs/skills.md`: explicit skill paths remain active with `--no-skills`. Unknown frontmatter fields are ignored.
- Pi `docs/environment-variables.md`: `PI_CODING_AGENT_DIR` and session directory overrides.
- `tests/guidance.test.ts`: default prompt guidance survives appended prompts, not replacement prompts.
- `src/ops.ts`: the extension reads `PIPARA_API_KEY` and constructs the installed Parallel SDK client.
- Installed `parallel-web/client.mjs`: the SDK accepts `PARALLEL_BASE_URL`.
- Pinned CLI `core/endpoints.py`: the CLI accepts `PARALLEL_API_URL`.
- Pinned CLI `core/auth.py`: research clients use that URL. Some suggestion paths use fixed upstream URLs.
- Fixed-URL billable helpers need documented gateway adapters to use the withheld Parallel credential. Their destinations are not network-blocked.

### Earlier benchmark evidence

An earlier head-to-head already exists at `/home/jangpi/research/parallel-ab/results/report.md`.
Its results concern older product revisions and a different model. They do not estimate the effect of the current guidance.
The report records omitted extension guidelines, a hook error that failed to stop requests, and a CLI attempt outside its assigned interface.
The current `control/measurement.ts` uses `ctx.abort()` and `ctx.shutdown()` instead of throwing from the hook.
These observations justify the prompt audit, external limits, route attribution, and fail-closed spending gateway in this plan.
The earlier prohibition on unrelated public research routes does not apply to this open-network revision.
The new harness can reuse reviewed observation patterns. It must not reuse contaminated prompts, old credentials, or combined model/API cost accounting.
Old successful-only time averages do not replace the new censored-time analysis.

Source snapshot: `~/.cache/pi-parallelized/parallel-docs/2026-09-20-current/`.
Reference checkouts: `/tmp/parallel-comparison.9EOsUp/`.
These paths aid implementation today. Durable manifests must use copied, hashed inputs rather than depend on temporary directories.
