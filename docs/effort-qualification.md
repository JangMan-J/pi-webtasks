# Effort qualification from saved evidence

Status: historical saved-evidence analysis. Its recommendations are superseded by the user-confirmed policy below.
Scope: reading saved probe output only. No new paid, model, or network calls were made, and no code or public schema changed.

Source: `~/Projects/JangLabs/pi-parallelized/.pi/three-tool-tier-probe/` (`report.md`, `README.md`, `anchors/rubric.md`, `calls/*.json`).

## Current user-confirmed policy

| Public effort | Discovery | Interactive answer | Deep research |
| --- | --- | --- | --- |
| low, default | fast | low | core |
| medium | basic | medium | pro |
| high | advanced | high | ultra2x |

URL extraction and Fast Entity Search have no effort tiers.
Their branches reject explicit effort.
There is no automatic escalation.
The user supplied and confirmed this mapping. No further tier-selection experiment is required.
The screenshot is not stored in this repository because it includes private account information.
Its policy selection does not establish quality or latency claims.

## Evidence limits

- Search: 3 questions, 4 modes, one repeat each. Only result titles, URLs, and excerpt sizes were saved in the summary. Ranking was compared by reading titles and URLs, not full excerpts.
- Responses: one question at low, medium, and high, plus one follow-up each.
- Deep tasks: one objective, one run per processor, in one group.
- Keyword hits and citation counts are phrase coverage. They were not used to rank quality.
- Deep timings are not clean. The probe fetched results only after the group drained, so its `observed_ttu_ms` (about 108.6 s for all three) includes collector wait. Only the created-to-modified times are usable, and they cover a single run each.

## Search modes

Observed first-call latency: turbo about 0.4–0.5 s, fast about 0.9–1.3 s, basic about 1.8–2.1 s, advanced about 1.3–2.2 s.

What the saved results show:

- Task Group question: turbo and fast returned mostly official docs pages plus a few GitHub mirrors. Basic and advanced added third-party pages (a connector site, a blog) and an official blog post. Both turbo and fast missed one documented point (that the runs endpoint is a snapshot that does not wait). Basic and advanced did not miss it.
- Pi 0.80.8 question: turbo and fast put the official release pages first. Basic led with package pages and an unrelated community page before the release notes. Advanced led with the release notes.
- xAI encrypted reasoning question: all modes returned the official reasoning page first. Turbo and advanced missed the default-effort and `xhigh` details. Fast and basic included them.

Assessment:

- No mode was consistently better. Differences track the question, not the tier.
- Turbo and fast give official pages first at about a quarter to half the latency of basic and advanced.
- Basic and advanced did not show a reliable source-quality gain, and they returned more third-party pages in two of three questions.

Recommendation (provisional): keep one internal routine tier, `fast`. It is the lowest-latency mode with no coverage gap that turbo did not share, and it did not miss anything that turbo caught. Do not expose modes.

Not supported: that `fast` beats `turbo`, that `advanced` is worth its price, or any claim about harder queries. Turbo is a defensible cheaper alternative, but the evidence cannot separate it from fast. Whether `basic` or `advanced` helps on ambiguous or multi-source questions was not tested.

## Responses effort (interactive search)

Question: official Task Group semantics, with required points and instructions to quote decisive sentences. Latency: low 8.7 s, medium 17.0 s, high 72.4 s (above the documented 30–60 s band).

Reading the answers:

- **Low**: covers every required point. Quotes decisive sentences from the guide and the schema, names the endpoints, and states that ZDR does not retain results. It also lists the documented endpoint set. It cites docs URLs. Nothing in it conflicts with the other two.
- **Medium**: covers the same points, slightly shorter, with the extra detail that output requires `include_output=true` and a completed run. Cites three official URLs with links.
- **High**: covers the same points with the most precise wording on `/runs` versus `/events` (SSE snapshot, closes after one event per run). It adds the Python SDK call. It also states that inactivity does not mean closed. It is the longest to produce and added no required fact the others lacked.

Assessment: all three were correct and complete on this question. Differences were in polish and minor extra detail. High cost about 8× the latency of low without a visible gain here. Medium's gain over low was small.

The follow-ups were not needed for this comparison and carry the same one-question limit.

Recommendation (provisional): keep `low` as the default. Keep one higher level only as an opt-in for harder questions, since this single easy, documentation-lookup question cannot show where low falls short. `medium` fits that role by latency, while `high` has no evidence of benefit.

Not supported: any claim that medium or high improves answers on multi-step, ambiguous, comparative, or non-documentation questions. That needs a harder question set. Also unsupported is a three-level public scale.

## Task processors (deep search)

Objective: the same Task Group lifecycle question, framed as a research brief. All three completed.

Reading the outputs:

- **Base**: numbered answer with six points. Correct on snapshot versus events, `is_active`, inactive-not-closed, the result endpoint, and ZDR. It adds the full run-status list. It cites docs and reference pages inline.
- **Core**: correct and equivalent, organized by endpoint with a separate list of non-completed statuses and their active or inactive classification. It adds the `include_input` and `include_output` flags and cites a glossary page.
- **Pro**: a structured report with an executive summary, a comparison table, and a status table. It states the same facts and adds the interpretation that inactivity is not permanent closure. It is longer and more formatted than the question needed.

Assessment: factual content is the same across tiers on this objective. Core and pro organized the material more usefully for a reader. Base was correct but flatter. This objective was simple and answerable from a few documentation pages, so it cannot show where base fails and pro succeeds.

Timing (created to modified): core 66 s, pro 95 s, base 108 s. Base was slowest in this single run, which contradicts the documented ordering. One sample per tier cannot rank them, and queue and run variance is unmeasured.

Recommendation (provisional): do not treat `low/base`, `medium/core`, and `high/pro` as qualified. Keep `core` as the default deep tier because it matched pro's content in less time here and has a documented range between base and pro. Keep `pro` as an opt-in tier for demanding, multi-source briefs. Keep `base` only if a cheaper band is wanted for simple briefs. This probe gives no reason to prefer it, so dropping it is a reasonable default.

Not supported: that pro is better on hard research, that base is adequate for any non-trivial brief, any ordering of the three on latency, and any claim about entity-finding, comparison, or structured-list goals.

## Proposed minimal mapping

Historical proposal only. Do not implement this table instead of the confirmed policy.

| Public effort | Search (internal) | Interactive search | Deep search |
| --- | --- | --- | --- |
| default or low | `fast` | `low` | `core` |
| higher (opt-in) | none | `medium` | `pro` |

This leaves two levels per tool. It differs from the provisional `low/base`, `medium/core`, `high/pro` mapping. If the frontend keeps three public levels, label the extra tier provisional and note that high and base have no supporting advantage in the saved evidence.

All mappings are proposals. They stay internal, with no processor or mode names in the public schema, and with no automatic escalation to a higher tier on failure or weak output.

## Evidence gaps that would settle the open points

1. Two or three harder prompts (an ambiguous question, a multi-source comparison, and a structured entity-finding brief) run at each retained tier. Judge by source support, not keywords.
2. Repeat samples per deep tier, with each run's completion observed by webhook or status at completion time, not after the drain.
3. A search question where the best answer is not on an official docs page, to test whether basic or advanced helps.
4. Clean latency for high effort. The one 72 s sample exceeded the documented band and may be an outlier.
