# Tier 1 results: lazy tool exposure

Executed per `docs/ab-search-plan.md` §4 after Tier 0 opened the gate. One extension build,
two conditions, paired by case, same image, model, prompts, gold, and gateway.

- Treatment commit: `b850010` on branch `bench/tier1-lazy-tools`, repinned from HEAD per the
  plan's pin decision. Pi 0.87.0 in both conditions (0.86.1 is no longer installed on this
  host, so round-1 parity was impossible; both Tier 1 conditions share one version).
- Conditions: `baseline` (all nine research tools active, current shipped behavior) and
  `lazy` (`PIPARA_LAZY_TOOLS=1`, six tools deferred behind a `parallel_tools` activator).
- 8 pairs, 16 runs, all completed. No audit failure, timeout, or harness error.
- Parallel spend: $0.010 baseline, $0.011 lazy, $0.021 total against a $0.50 cap.
- Artifacts: `.pi/benchmark/data/tier1-*/{baseline,lazy}/run.json`,
  `.pi/benchmark/data/tier0/tier1-report.json`. Runner: `bench/ab-run.ts`.

## The mechanism works exactly as designed

Serialized tool schema per provider request fell by 11,186 characters in every single run,
with zero variance: 19,994 characters down to 8,808, a 56% reduction in the payload's tool
block. Active Parallel tools went from 10 to 4. The system prompt also shrank, because the
deferred tools' guidance is dropped with them.

## Per-request context: a reliable 40% cut

| Case | Baseline ctx/request | Lazy ctx/request | Ratio |
| --- | ---: | ---: | ---: |
| D1 | 7,423 | 4,225 | 0.57 |
| D3 | 6,613 | 3,720 | 0.56 |
| E2 | 7,380 | 4,647 | 0.63 |
| K1 | 7,042 | 4,038 | 0.57 |
| L1 | 10,637 | 4,506 | 0.42 |
| L2 | 6,081 | 3,375 | 0.56 |
| R1 | 9,887 | 6,071 | 0.61 |
| S2 | 7,005 | 6,679 | 0.95 |

Mean log ratio −0.518, SD 0.225, 95% CI [−0.651, −0.359], sign test p = 0.0078. Every case
improved. This is the endpoint the intervention controls directly.

## Per-run context: large but noisier

| Total | Baseline | Lazy | Change |
| --- | ---: | ---: | ---: |
| Context tokens, 8 pairs | 245,229 | 156,834 | −36.0% |
| Excluding S2 | 126,583 | 60,201 | −52.4% |

Median per-run ratio 0.63. But the paired interval on the per-run log ratio is
[−0.729, 0.204] and does not exclude zero, because one case inverted: S2 used 46,753 tokens
under lazy against 14,010 under baseline.

S2's lazy run did not fail on activation. It performed one Extract, then spent three reads
and a `bash ls` navigating its own saved artifact directory — the same artifact-navigation
failure recorded for A1-E and P2-E in round 1. That behavior is independent of tool
exposure and could have landed in either condition. Turn count, not schema size, dominates
per-run variance.

## The quality guard is at ceiling and proves nothing

Claim coverage was 1.00 in all 16 runs, so the paired delta is exactly 0.000 with zero
variance. That is a property of the case set, not evidence of safety: these seven cases are
too easy to discriminate between conditions. Tier 0 already predicted the guard would be
weak here; the correct reading is that no regression was observed, not that none exists.

## The activation path was never exercised

Zero `parallel_tools` calls across all eight lazy runs. R1 was included specifically to
force a Task dispatch, and it never dispatched one in either condition — it answered with
Search and Extract. So the intervention's real risk, an agent that needs Task, Group,
FindAll, Monitor, Memory, or Account and must first discover and call the activator, remains
untested. Nothing here shows that path works in practice or what it costs.

## Verdict

The intervention delivers its designed saving deterministically at the per-request level and
cuts total context by roughly a third across this case set, at no measured cost to answer
content. It is not yet shippable evidence: the deferred tools were never actually needed, so
the activation round trip, its discovery cost, and its failure modes are unmeasured.

Next steps, in order of value:

1. Test the activation path deliberately with cases that require Task, FindAll, or Memory.
   Without that, deferral is a saving measured only where it is free.
2. Fix artifact navigation. It caused the one inverted case here and two request-limit
   failures in round 1, and it is independent of tool exposure. Tier 0 attribution shows
   tool results are not the problem, so this is about how the preview points at saved files.
3. Only then consider a quality comparison on harder cases, where coverage is not at ceiling.

The branch `bench/tier1-lazy-tools` holds the intervention, its offline tests, and the
harness changes. Nothing is merged, and the default build is unchanged: `PIPARA_LAZY_TOOLS`
is off unless explicitly set.
