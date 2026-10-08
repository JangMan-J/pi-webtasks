# Round 2 gold draft — for review before freeze

Status: draft. Nothing frozen, no runs scheduled. Review and correct, then I freeze into
`bench/gold-round2.json` with hashed matchers and build the fixtures.

Every factual anchor below is taken from the round-1 frozen source snapshots in
`bench/gold-sources/`, which were curator-verified and passed 361 checks. No new curation
spend was needed. Verified quotes:

- Node.js: `"v22": { "end": "2027-04-30" }`, v20 ends 2026-04-30, v24 ends 2028-04-30.
- PEP 693: 3.12 security "until approximately October 2028".
- PEP 664: 3.11 security "until approximately October 2027".
- PostgreSQL: "16 16.15 Yes September 14, 2023 November 9, 2028"; 5-year policy; minor
  upgrades need no dump/restore.
- SQLite/PostgreSQL NULL handling as used in round-1 case S2.

## Protocol deltas for this round

| Setting | Round 1 / Tier 1 | Round 2 |
| --- | --- | --- |
| Worker | kimi-k3-fast, low thinking | `openai-codex/gpt-5.6-sol`, high thinking |
| Graders | grok-4.6 + gpt-5.5 | `openrouter/meta/muse-spark-1.3` (high) + `openrouter/sakana/fugu-max` (high) |
| Cells | E vs C (r1); baseline vs lazy (t1) | E-baseline, E-lazy, C — all three per case |
| Runs | 24 / 16 | 8 cases x 3 cells = 24, plus a second rep on the 4 hardest = 32 |
| Limits | 12 requests, 20 tool calls | 20 requests, 30 tool calls, 20 min deadline |
| Token accounting | 4 columns | 5 columns, reasoning tokens separated |
| Pi | 0.86.1 / 0.87.0 | 0.87.0 everywhere |

Reasoning tokens are reported separately because at high thinking they would otherwise
contaminate the context-composition measurement that Tier 0 depends on.

Expected spend: roughly $0.01 per non-Task run and up to $0.25 per Task run (the C skill
recommends `pro-fast` at $0.10 while the extension guidance prefers `base`; that asymmetry
is part of the treatment, not a defect). Estimated total well under $2 against the $25
ceiling. Per-run gateway caps: $0.25, or $0 for the two cases that must not spend.

## Why these cases should break the ceiling

Round 1 and Tier 1 both saw claim coverage saturate at 1.00, which is why neither could
detect a quality difference. Each case below has at least one claim that cannot be answered
by recalling a single fact: a derived number, an ordering, a correction, a dispatched job, or
a refusal to answer. Recall alone should land these in the middle of the range.

---

## M1 — multi-hop with derived arithmetic

Prompt: *Our platform pins Node.js 22 and Python 3.12. Using official sources for each, give
both end-of-support dates, say which loses support first, and state the gap between them in
months. Show the arithmetic and cite each source.*

Sources: nodejs-release-schedule, pep-0693. Cap $0.25.

| Claim | Text | Matcher |
| --- | --- | --- |
| M1-c1 | Node.js 22 ends 2027-04-30 | regex |
| M1-c2 | Python 3.12 source-only security fixes until approximately October 2028 | regex |
| M1-c3 | Node.js 22 loses support first | regex |
| M1-c4 | The gap is about 18 months | regex |
| M1-c5 | Both official sources cited | citation |

## M2 — three sources plus ordering

Prompt: *A service pins Python 3.11, Node.js 22, and PostgreSQL 16. Order the three by when
each loses support, give each date with its official source, and state how long after the
first expiry the last component is still supported.*

Sources: pep-0664, nodejs-release-schedule, postgresql-versioning-policy. Cap $0.25.

| Claim | Text | Matcher |
| --- | --- | --- |
| M2-c1 | Node.js 22 ends 2027-04-30 | regex |
| M2-c2 | Python 3.11 security until approximately October 2027 | regex |
| M2-c3 | PostgreSQL 16 final supported date November 9, 2028 | regex |
| M2-c4 | Order is Node.js 22, then Python 3.11, then PostgreSQL 16 | regex |
| M2-c5 | Last outlives first by roughly 19 months | regex |

Note the trap: Python 3.11 expires *after* Node 22 despite being the older-looking pin.

## T1 — requires a dispatched research job

Prompt: *Commission a background research job — not a single search — that produces a cited
comparison of how PostgreSQL 16 and SQLite treat NULLs in unique constraints. Report the
job's run identifier, the processor you chose, and the cited findings.*

Sources: postgresql-16-ddl-constraints, sqlite-nulls. Cap $0.25.

| Claim | Text | Matcher |
| --- | --- | --- |
| T1-c1 | A Task run was actually created | trace: POST /v1/tasks/runs |
| T1-c2 | The reported run identifier matches the created run | trace + regex |
| T1-c3 | The chosen processor is named | regex |
| T1-c4 | PostgreSQL 16 defaults to NULLS DISTINCT; SQLite permits multiple NULLs | regex |

This is the case Tier 1 lacked: under lazy exposure the worker must first call
`parallel_tools`, so the activation round trip is finally measured.

## T2 — requires a continued interaction

Prompt: *After that job returns, ask one follow-up that continues the same research
interaction instead of starting unrelated work. Report both identifiers and say what the
follow-up added.*

Runs as the follow-up prompt of T1's pair. Cap $0.25.

| Claim | Text | Matcher |
| --- | --- | --- |
| T2-c1 | A second run was created carrying the prior interaction id | trace |
| T2-c2 | Both identifiers reported | regex |
| T2-c3 | No duplicate unrelated job created | trace |

## C1 — clarification is the correct answer

Prompt: *Should we upgrade to version 4 before the next release window? Give me a go or
no-go.*

No sources. Cap $0. Correct behavior is a focused question; spending here is itself an error.

| Claim | Text | Matcher |
| --- | --- | --- |
| C1-c1 | Asks a focused disambiguating question | regex |
| C1-c2 | Names no invented product and gives no confident recommendation | judge |
| C1-c3 | No paid research dispatched | trace |

## C2 — hidden ambiguity in the workspace

Fixture: `package.json` pinning Node 22, `pyproject.toml` pinning Python 3.11.

Prompt: *When does our LTS runtime go out of support? One date please.*

Sources: nodejs-release-schedule, pep-0664. Cap $0.25.

| Claim | Text | Matcher |
| --- | --- | --- |
| C2-c1 | Notices two runtimes are pinned | regex |
| C2-c2 | Asks which, or answers both with the assumption stated | judge |
| C2-c3 | Any date given is correct for its runtime | regex |

"One date please" pushes toward a confident wrong answer, which is the point.

## X1 — stale local note contradicting official sources

Fixture `notes.md`: *"Confirmed: Python 3.12 security support ends October 2027, so Node.js
22 (ends 2027-04-30) goes out of support first but only by a few weeks."*

Prompt: *Verify the claims in notes.md against official sources and correct anything wrong.*

Sources: pep-0693, nodejs-release-schedule. Cap $0.25.

| Claim | Text | Matcher |
| --- | --- | --- |
| X1-c1 | The October 2027 date is wrong; 3.12 runs to approximately October 2028 | regex |
| X1-c2 | The "only by a few weeks" conclusion is wrong; the gap is about 18 months | regex |
| X1-c3 | Node.js 22 ending 2027-04-30 is confirmed correct | regex |
| X1-c4 | Corrections are cited to official sources | citation |

Two planted errors, one planted truth. Blanket agreement and blanket rejection both fail.

## H1 — local plus web, first failure date

Fixture `deploy.json`: `{"runtime": "nodejs22", "database": "postgresql16"}`.

Prompt: *Using the deployment file and official sources, state the date this deployment first
loses vendor support for any component, name the component, and cite the source.*

Sources: nodejs-release-schedule, postgresql-versioning-policy. Cap $0.25.

| Claim | Text | Matcher |
| --- | --- | --- |
| H1-c1 | Reads the deployment file and identifies both components | regex |
| H1-c2 | Node.js 22 is first, on 2027-04-30 | regex |
| H1-c3 | PostgreSQL 16 remains supported to November 9, 2028 | regex |
| H1-c4 | The official source is cited | citation |

---

## The four hardest, for the second repetition

M2, T1, X1, C2. They carry the ordering trap, the dispatch requirement, the planted errors,
and the hidden ambiguity — the four places where a strong worker is most likely to vary run
to run.

## Open questions for you

1. Are these the right kind of "tougher"? They stress derivation, dispatch, correction, and
   restraint rather than obscure facts. If you want harder *retrieval* instead — sources
   that resist search — say so and I will curate new snapshots.
2. C1 and C2 depend on a judge for one claim each, since "did it avoid a confident wrong
   answer" is not regex-decidable. Acceptable, or should those claims be dropped so the round
   stays fully deterministic?
3. T1/T2 let arm C spend $0.10 per `pro-fast` job against the extension's cheaper default.
   Keep that as a real treatment difference, or pin both arms to the same processor?
