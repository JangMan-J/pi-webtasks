# Tier 0 spec: free re-analysis of the round-1 corpus

Companion to `docs/ab-search-plan.md` §3. Nothing here runs a worker, calls a model, calls
the Parallel API, or starts a container. Everything reads data already on disk or measures
statically constructed prompts.

## Inputs, all present

| Input | Path | Contains |
| --- | --- | --- |
| Per-run records | `.pi/benchmark/data/primary-*/{E,C}/run.json` | `answer`, `events`, `usage`, `elapsedMs`, `parallelLiabilityMicro`, `status`, `manifestHash` |
| Raw event streams | `.pi/benchmark/data/primary-*/{E,C}/stdout.jsonl` | complete sanitized agent event stream |
| Spend ledger | `.pi/benchmark/data/liability.sqlite`, `ledger.json` | per-request route, price, status |
| Gold | `bench/gold.json`, `bench/gold-sources/` | 15 packets, `requiredClaims` with ids and `sourceIds`, `sources` |
| Round-1 grading | `.pi/benchmark/data/grading/primary/` | both raters' structured scores |
| Frozen manifest | `bench/manifest.json` | image ids, hashes, pin `4c8e7d4`, seed |

Twelve primary pairs, 24 runs. Three pilot pairs exist and stay out of the primary
statistics.

## Write hygiene

New files only, under `bench/ab-*.ts` and `.pi/benchmark/data/tier0/`. Do not modify
`bench/manifest.json`, `bench/summarize.ts`, `bench/score.ts`, `bench/gold.json`, or
`.pi/benchmark/data/frozen-reporting/`. Round 1 is a frozen record; Tier 0 only reads it.

## WP0-1 Metrics extractor — `bench/ab-metrics.ts`

Emits one row per run: case, arm, status, context tokens split into input, cache read,
cache write, output, wall seconds, Parallel dispatch count by route, attributed USD,
request-limit hit, tool error count, and answer length.

Acceptance: reproduces the published round-1 aggregates. Context totals must land at
534,285 for E and 285,974 for C excluding output, and 545,372 and 297,828 including
output as published in `docs/benchmark-results.md`. Per-run seconds must match that
document's raw seconds column. Any mismatch is an extractor defect, not a data defect.

## WP0-2 Objective scorer — `bench/ab-score.ts`

Scores an answer against a gold packet without a model:

- Claim coverage: fraction of `requiredClaims` matched. Each claim carries a frozen
  matcher and a class of `regex`, `trace`, or `judge`. Classify every claim in the six
  Tier 1 cases plus the six deferred ones before scoring anything, and hash the matcher
  table into `.pi/benchmark/data/tier0/matchers.json`.
- Citation recall: gold `sources` cited in the answer, by normalized URL. Citation
  precision: cited URLs that appear in gold sources, over all cited URLs.
- `trace` claims resolve from the event stream, for example E2-c3, which asserts no
  research request was issued. `judge` claims are left unscored in Tier 0 and counted
  separately; they are not silently treated as failures.

Acceptance: gold reference answers score coverage 1.0 on their `regex` claims; deliberately
wrong variants score 0; claim classification is recorded per claim id; `node --test
bench/*.test.ts` covers both directions. Report the `regex`/`trace`/`judge` split so the
ratio of mechanically decided claims is visible.

## WP0-3 Token-tax decomposition — `bench/ab-overhead.ts`

Three components, measured separately.

1. Fixed cost. Compose each arm's effective system prompt exactly as `bench/sandbox.ts`
   launches it — E with the extension loaded, C with progressive skill discovery — and
   count tokens before any task text. Round 1's mean first-request input, 5,982 E versus
   2,530 C, is the expected order of magnitude.
2. Per-result cost. Drive `bench/mock-provider.ts` with fixed synthetic Search and Extract
   payloads and measure what each arm puts into context per result: extension preview plus
   Markdown companion versus CLI JSON read back through the skills. No model, no API.
   Run the extension side under both `PIPARA_OUTPUT_FORMAT=json` and `readable`, which
   answers part of the deferred presentation question for free.
3. Navigation cost. From the preserved event streams, attribute tokens to re-reads of
   saved artifacts, repeated tool calls with identical arguments, and file reads of the
   worker's own logs. `primary-L1-E:13–14` is a known instance where `cat /work/*` pulled
   harness text into context; P2-E at 92,877 tokens against its pair's 8,213 is the
   extreme case.

Code-version mismatch, to be labelled in the output rather than smoothed over. Components
1 and 2 measure the working tree at HEAD `3b285e3`, which includes `00615ab`'s readable
presentation and Markdown companions. Component 3 attributes navigation cost from round-1
traces produced at pin `4c8e7d4`, before that feature existed. Report the round-1 fixed
and per-result split as a prior for HEAD, not as a measurement of it, and flag any
component where the HEAD static measurement and the round-1 trace attribution disagree by
more than 25%.

Acceptance: the three components plus task text reconcile to the measured per-run context
totals within 10%. State the residual rather than forcing the sum.

## WP0-4 Variance and sizing — `bench/ab-report.ts`

For every candidate metric, report the paired mean, SD, and 95% bootstrap interval, seed
42017, 10,000 resamples, and the pairs needed to resolve a stated effect. Known reference
points to reproduce as a self-check: log token ratio mean 0.650 with SD 0.742, giving
about 5 pairs to re-establish the gap; retrieval delta SD 0.739 on the 0–2 scale, giving
about 53 pairs at a 0.10 normalized effect, 24 at 0.15, 14 at 0.20.

Acceptance: sizing output for the Tier 1 primary, tokens per covered claim, with the
sample needed for a 45% and a 60% reduction, and the non-inferiority margin's required
sample at the measured coverage SD. Label all round-1 variance as a prior for the HEAD
build, since Tier 1 repins to `3b285e3` and measures its own baseline.

## Deliverable

`docs/ab-tier0-results.md` plus `.pi/benchmark/data/tier0/report.json`, stating in order:
the token-tax decomposition with residual, retroactive objective scores for all 24 runs,
measured variance per metric, and the Tier 1 go or no-go against `docs/ab-search-plan.md`
§3 — an addressable overhead component of at least 25% of the E arm's context total, and
coverage variance small enough for the planned sample.

A no-go is a valid outcome and ends the programme with Tier 0 as the published result.
