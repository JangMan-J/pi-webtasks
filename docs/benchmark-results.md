# Parallel extension versus CLI + Pi-adapted skills

Generated 2026-09-21T10:35:49.560Z.

The benchmark does not establish extension superiority. Both full-corpus retrieval estimates have confidence intervals that include zero.
The original 6 disagreements are preserved below. A later Grok 4.6 overlay copied disputed fields from named original raters against frozen gold and traces. That overlay is not a third independent model and is not rater consensus.
The overlay 12-pair retrieval mean is 0.17 (95% interval -0.17 to 0.50). That still does not meet the preregistered superiority gates.

## Experiment

- Three pilot pairs and twelve primary pairs: 30 worker runs, as requested.
- Both arms used `fireworks/accounts/fireworks/routers/kimi-k3-fast`, low reasoning, Pi 0.86.1, and unrestricted network access.
- Extension commit: `4c8e7d4d4ad34432dbf2ab5e9151daa155b45f2a`. CLI: 0.9.3 with the supplied Pi-adapted skills and Responses helper.
- Both arms received the same find-docs skill and frozen Context7 0.5.11.
- Fresh rootless Podman container per worker. No host instructions, shared run state, or gold packets inside workers.
- The gateway kept the real Parallel credential outside workers. No recurring service or account mutation occurred.
- Optional replication and diagnostics stayed disabled. Failed runs were not replaced.

## Original rater 12-pair estimates

Each row uses all 24 primary runs under one rater’s latest judgments. These are the original corpora. They are not a 24-run agreement set. Scores are not averaged between raters.
Positive score deltas favor the extension. Intervals use 10,000 paired bootstrap resamples with seed 42017.

| Rater | Retrieval E / C (0–2) | E − C | 95% interval | Exact sign-test p |
|---|---:|---:|---:|---:|
| Grok 4.6 | 1.42 / 1.42 | 0.00 | -0.42 to 0.42 | 1.0000 |
| GPT-5.5 | 1.58 / 1.42 | 0.17 | -0.17 to 0.50 | 0.6250 |

| Rater | Quality E / C (0–4) | E − C | 95% interval |
|---|---:|---:|---:|
| Grok 4.6 | 2.83 / 2.42 | 0.42 | -0.50 to 1.33 |
| GPT-5.5 | 2.83 / 2.33 | 0.50 | -0.25 to 1.33 |

The agreed-only subset contains 8 complete pairs, not twelve, because 18 of 24 runs matched after the comparison round. Its statistics remain in the JSON report, separate from both original rater corpora and from the overlay 12-pair set.

## Final overlay 12-pair estimate

Separate from both original rater corpora. Copies only disputed fields from a named original rater. Does not rewrite rater files, average scores, or claim the 24 runs agreed.

| Overlay | Retrieval E / C (0–2) | E − C | 95% interval | Exact sign-test p |
|---|---:|---:|---:|---:|
| Grok 4.6 council pass | 1.58 / 1.42 | 0.17 | -0.17 to 0.50 | 0.6250 |

| Overlay | Quality E / C (0–4) | E − C | 95% interval |
|---|---:|---:|---:|
| Grok 4.6 council pass | 2.83 / 2.33 | 0.50 | -0.25 to 1.33 |

Claim decision on the overlay set: inconclusive. primary superiority thresholds not met (mean delta 0.16666666666666666, interval [-0.16666666666666666, 0.5]; required mean >= 0.25 with the interval excluding zero)

## Tokens, time, and money

| Observed metric | Extension | CLI + skills |
|---|---:|---:|
| Finished within the common limits | 10 | 11 |
| Hit the 12-request limit | 2 | 1 |
| Total context tokens | 545372 | 297828 |
| Parallel request dispatches | 13 | 7 |
| Primary Parallel liability (USD) | 0.02 | 0.019 |

The CLI arm used 45.4% fewer context tokens. Cached input counts toward context consumption.
This is a descriptive total, not an isolated interface-cost estimate. In `primary-L1-E:13–14`, `cat /work/*` also read the worker’s own observer log, adding harness text to context.
Mean first-request input was 5982 for E and 2530 for C. Later retries and preparation also affect total tokens.

| Rater | Quality points per 10k tokens, E / C | Successful resolutions, E / C | Restricted mean seconds, E / C | E − C seconds (95% interval) |
|---|---:|---:|---:|---:|
| Grok 4.6 | 0.62 / 0.97 | 8 / 7 | 213.43 / 258.99 | -45.56 (-195.02 to 102.74) |
| GPT-5.5 | 0.62 / 0.94 | 9 / 6 | 165.34 / 306.59 | -141.25 (-289.74 to -1.30) |

A successful resolution requires quality ≥3 and no material error, fabricated citation, or critical violation.
Unsuccessful runs count at their common deadline for restricted time. A quick failure is not a quick justified resolution.

Total Parallel liability was $0.068: $0.024 earlier smoke, $0.005 pilot, and $0.039 primary.
All 25 new gateway requests returned HTTP 200. No budget denial occurred, and no reservation remains active.
These amounts are conservative API-price liabilities, not reconciled invoice charges. Model usage does not debit the Parallel-only ceiling.
Unknown Context7 and other-service charges remain unknown. Parallel-only evidence efficiency uses attributed claims, never all-source claims.

## What the traces show

- A1-E and P2-E reached the 12-request limit during repeated guesses about saved JSON fields and text locations.
- R2-C repeatedly guessed `/opt/pi/skills/...` despite the correct `/opt/resources/...` paths in its actual prompt. It later retrieved evidence but delivered no final table.
- The timed runs exercised Parallel Search and Extract only. Other tools received earlier smoke or offline coverage, not comparative primary performance evidence.
- Both raters scored the ambiguous Atlas case A2 at zero in both arms. Completion did not mean the agent resolved missing user intent correctly.

These observations support three follow-up candidates: clearer saved-artifact navigation, lower always-visible schema cost, and better clarification behavior.
They do not prove that a wording change alone will fix the failures. No product tuning or additional bouts followed these results.

## Per-run judgments

Scores show Grok / GPT. E means extension; C means CLI plus skills. “Completed” describes execution, not answer correctness. Overlay is shown only where a dispute existed; it is a field copy, not a new rater.

| Case | Arm | Execution | Retrieval | Quality | Overlay retrieval / quality | Raw seconds | Context tokens |
|---|---|---|---:|---:|---:|---:|---:|
| A1 | C | completed | 1 / 1 | 3 / 2 | 1 / 2 | 28.81 | 53480 |
| A1 | E | limit | 1 / 1 | 0 / 0 | 1 / 0 | 24.56 | 94207 |
| A2 | C | completed | 0 / 0 | 0 / 0 | — | 16.00 | 15830 |
| A2 | E | completed | 0 / 0 | 0 / 0 | — | 13.00 | 28103 |
| D1 | C | completed | 2 / 2 | 4 / 4 | — | 17.03 | 28190 |
| D1 | E | completed | 1 / 1 | 4 / 4 | — | 16.84 | 45182 |
| D3 | C | completed | 1 / 1 | 1 / 1 | — | 27.06 | 46348 |
| D3 | E | completed | 2 / 2 | 4 / 4 | — | 21.18 | 43298 |
| E2 | C | completed | 2 / 2 | 4 / 4 | — | 8.50 | 16558 |
| E2 | E | completed | 2 / 2 | 4 / 4 | — | 6.39 | 27269 |
| K1 | C | completed | 2 / 2 | 3 / 3 | — | 26.71 | 21577 |
| K1 | E | completed | 2 / 2 | 3 / 3 | — | 17.69 | 28272 |
| L1 | C | completed | 2 / 2 | 4 / 4 | — | 7.66 | 11870 |
| L1 | E | completed | 2 / 2 | 4 / 4 | — | 4.73 | 21479 |
| L2 | C | completed | 2 / 2 | 4 / 4 | — | 3.29 | 5351 |
| L2 | E | completed | 2 / 2 | 4 / 4 | — | 3.57 | 12241 |
| P2 | C | completed | 0 / 0 | 1 / 1 | — | 13.74 | 9025 |
| P2 | E | limit | 1 / 1 | 0 / 0 | — | 34.17 | 94393 |
| R1 | C | completed | 2 / 2 | 2 / 2 | — | 25.94 | 23160 |
| R1 | E | completed | 1 / 2 | 4 / 4 | 2 / 4 | 21.10 | 55871 |
| R2 | C | limit | 1 / 1 | 0 / 0 | 1 / 0 | 27.95 | 45582 |
| R2 | E | completed | 2 / 2 | 3 / 3 | 2 / 3 | 22.87 | 23222 |
| S2 | C | completed | 2 / 2 | 3 / 3 | — | 15.91 | 20857 |
| S2 | E | completed | 1 / 2 | 4 / 4 | 2 / 4 | 69.67 | 71835 |

## Rating and limitations

Initial agreement was 50.00%. After one independent comparison round, agreement was 75.00% (18 of 24 runs).
One Grok response needed a structured-citation repair. Its original response and validation error remain in the dataset.
The original 6 disagreements remain on record in `docs/benchmark-adjudication.md`. A Grok overlay copied disputed fields; rater JSON is unchanged. Neither rater has a missing primary score.

Direct public HTTP and shared Context7 evidence were valid in both arms. A successful non-Parallel lookup did not require another paid request.
The fixed corpus covers developer documentation and local work. It does not establish results for other domains, models, or long research jobs.
The selected model is a router. Its exact underlying deployment was not independently identified.
Capability names were neutralized for grading, but output formats can reveal treatment. Rater judgments are not fully blind.
Source facts repeat across workflows. The JSON report includes source-family sensitivity, web/no-web strata, and conservative failure analysis.
Gateway logs do not reveal all encrypted internet traffic. Absence of a private canary there does not prove absence on another route.
Workspace and HOME artifacts persist. Explicit `/tmp` outputs do not survive container removal; their inspected outputs and receipts remain in event logs.

## Reproducibility

- Protocol and active cases: `docs/benchmark-plan.md`, `docs/benchmark-cases.json`.
- Frozen manifest and gold: `bench/manifest.json`, `bench/gold.json`, `bench/gold-sources/`.
- Overlay records: `bench/final-adjudication.json`.
- Runner instructions: `bench/README.md`.
- Local dataset, ledger, ratings, and complete statistics: `.pi/benchmark/data/` (Git-ignored).
- Machine-readable report: `.pi/benchmark/data/report.json`.

Post-run reporting corrections label the agreed subset, retain both full-corpus estimates, and fix the sign-test display field.
They change no worker record, gold packet, rubric, or threshold. The previous renderer and output remain in `data/frozen-reporting/`.
