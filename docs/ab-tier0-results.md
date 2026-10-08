# Tier 0 results: where the extension's context cost goes

Executed per `docs/ab-tier0-spec.md`. No worker runs, no model calls, no API calls, no
containers. Everything below comes from the preserved round-1 corpus, the frozen gold, and
static measurement of the current working tree.

Artifacts: `.pi/benchmark/data/tier0/{metrics,scores,matchers,overhead,report}.json`.
Scripts: `bench/ab-metrics.ts`, `bench/ab-score.ts`, `bench/ab-overhead.ts`,
`bench/ab-report.ts`. `npm run check:bench` passes unchanged (70 tests, 361 checks).

## 1. The context tax is tool schemas, not previews

Every provider request resends the full serialized tool list. Attributing every byte of
every request payload in the 24-run primary corpus:

| Component | Arm E tokens | Arm C tokens | Difference |
| --- | ---: | ---: | ---: |
| Tool schemas | 319,807 | 50,152 | +269,655 |
| System prompt | 117,546 | 122,588 | −5,042 |
| Tool results | 76,984 | 79,027 | −2,043 |
| User + assistant | ~19,948 | ~34,207 | −14,259 |
| Total context | 534,285 | 285,974 | +248,311 |

The schema difference alone is 269,655 tokens, which is 108.6% of the entire observed gap.
Tool schemas are 59.9% of the E arm's total context consumption.

Two round-1 hypotheses die here. Extension previews are not the problem: tool results were
slightly *smaller* in E than in C (76,984 versus 79,027 tokens). The system prompt is not
the problem either: C's is slightly larger, because the skill bundle lists in it.

Per request: E carries 20,106 characters of tool schema, C carries 3,153. Both arms issued
exactly 68 provider requests across their 12 runs, so the tax is charged 68 times.

Per tool, at HEAD: `parallel_task` 2,617 chars, `parallel_findall` 2,310,
`parallel_responses` 2,232, `parallel_search` 2,043, `parallel_monitor` 2,033,
`parallel_group` 1,835, `parallel_memory` 1,464, `parallel_extract` 1,354,
`parallel_account` 921. Nine tools, 16,809 characters, on every request whether used or
not. Conversion factor for this corpus is 4.28 characters per context token.

## 2. The round-1 measurement transfers to HEAD

The concern that round 1 ran very different code is valid for the codebase and wrong for
this measurement. `src/index.ts` grew from 23,683 to 40,693 characters and `src/evidence.ts`
is new, but all nine tool descriptions and parameter schemas are byte-identical between pin
`4c8e7d4` and HEAD `3b285e3`: 16,944 characters then, 16,809 now, zero drifting tools.

The always-visible surface did not change. Everything that changed sits downstream of a
call, in the component that was already not the problem.

## 3. Objective scoring, applied retroactively

38 gold claims across the 12 primary cases: 32 decided by frozen regex matchers, 4 from the
event trace (artifact reuse, public-route research, canary absence, follow-up without a new
dispatch), 2 left to a judge and never silently scored as failures.

| Metric | Arm E | Arm C | Paired delta | 95% CI | Sign p |
| --- | ---: | ---: | ---: | --- | ---: |
| Claim coverage | 0.806 | 0.764 | +0.042 | −0.146 to 0.271 | 1.000 |
| Citation recall | 0.537 | 0.222 | +0.236 | 0.056 to 0.444 | 0.125 |
| Citation precision | 0.667 | 0.375 | — | — | — |
| Context tokens | — | — | +20,693 | 6,642 to 36,672 | 0.039 |
| Log token ratio | — | — | +0.650 | 0.269 to 1.076 | 0.039 |
| Seconds | — | — | +3.10 | −4.32 to 13.95 | 0.146 |

Claim coverage reproduces round 1's conclusion by an independent, model-free route: the two
arms are indistinguishable on answer content. Citation recall favors the extension and its
bootstrap interval excludes zero, but the sign test does not agree at 12 pairs, so treat it
as a lead, not a finding.

Two scorer defects were found and fixed during validation, both of which had understated
scores symmetrically: `$0.040` failed a word-boundary match for the `$0.04` claim, and gold
URLs pinned to `raw.githubusercontent.com` never matched answers citing the same file
through `github.com/.../blob/...`. Document identity now ignores mirror hosts, GitHub view
segments, fragments, and queries. Citation recall remains deliberately strict in one way:
citing a repository root instead of the pinned document counts as a miss.

## 4. What an intervention would save

Projected against the same 68-request workload, holding behavior constant:

| Scenario | Saved tokens | Share of E context | Share of the E−C gap |
| --- | ---: | ---: | ---: |
| Expose 3 core research tools, activate the other 6 on demand | 177,830 | 33.3% | 71.6% |
| Trim 30% of schema description text on all 9 tools | 35,035 | 6.6% | 14.1% |
| Both | 189,812 | 35.5% | 76.4% |

Lazy exposure alone clears the pre-registered 25% threshold. Description trimming alone does
not, and it degrades the guidance the schemas exist to provide.

Feasibility is confirmed in the installed Pi API rather than assumed: `registerTool()` calls
`runtime.refreshTools()` post-bind, and `ExtensionContext` exposes `getActiveTools()`,
`getAllTools()`, and `setActiveTools(toolNames)`. An extension can therefore register all
tools and activate a subset.

## 5. Tier 1 gate: go

The pre-registered condition was an addressable overhead component of at least 25% of the E
arm's context, measured on HEAD. Lazy exposure is 33.3%. Tier 1 proceeds.

Sizing from measured variance (log token ratio SD 0.742, coverage SD 0.375):

- Detecting a 45% token reduction needs 6 pairs; 60% needs 3 pairs.
- The coverage non-inferiority guard at a 0.10 margin needs 55 pairs, which Tier 1 will not
  have. At 6 to 7 pairs the guard detects only a coverage regression of 0.30 or larger.
  State that limit in the Tier 1 report rather than implying the guard is tight.

Arithmetic already determines the schema saving. What Tier 1 must measure is what the
arithmetic cannot: whether hiding six tools changes agent behavior — extra activation round
trips, more turns, different tool choices — and whether answer content holds. The Tier 1
primary is therefore total context tokens per run, which absorbs any extra turns the
activation costs, not the projected schema saving.

For that reason the Tier 1 case set adds `R1`, whose workflow dispatches a Task and so
exercises the activation path. Without it the design would only measure cases that never
need the hidden tools, which would rig the result in the intervention's favor.
