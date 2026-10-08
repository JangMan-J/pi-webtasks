# Benchmark adjudication queue

Original record: 6 judgments remained disputed after two independent rounds. No score averaging or replacement worker run occurred.

The original 6 disagreements are preserved below. A later Grok 4.6 overlay copied disputed fields from named original raters against frozen gold and traces. That overlay is not a third independent model and is not rater consensus.

The full per-rater estimates are in `docs/benchmark-results.md`. Both preserve all twelve pairs. Original rater notes below are unchanged.

## primary-A1-C

| Field | Grok | GPT |
|---|---|---|
| quality | 3 | 2 |
| supportedClaims | 3 | 1 |

Grok: Local-first was correct. After the workspace showed a 3.12 pin and no API docs, the agent never fetched 3.12 docs and used 3.11.2 tests plus gather.__doc__. Conclusion is correct (siblings are not cancelled). TaskGroup is asserted without inspection. Version identity with 3.12 is unsupported. Rater B undercounts: c2/c3 are traceably supported by inspected 3.11 tests/docstring; the 3.12 gap is the uncertainty penalty, not a denial that those claims were evidenced in-run.

GPT: I agree with raterB on the disputed fields. The run correctly checked local notes and pyproject first and reached the right high-level conclusion, but after establishing the pin was Python 3.12 and no API reference existed locally, it resolved behavior using the installed Python 3.11.2 tests/docstring. That does not traceably support the pinned-runtime Python 3.12 claims. RaterA over-credits supportedClaims: 3.11 evidence cannot count as inspected support for the required 3.12 documentation claims.

Evidence: `.pi/benchmark/data/primary-A1/C/run.json`. Full event-linked judgments: `.pi/benchmark/data/grading/primary/adjudication.json`.

## primary-A1-E

| Field | Grok | GPT |
|---|---|---|
| supportedClaims | 0 | 1 |

Grok: Keep retrieval 1 and quality 0. Local-first was correct, then a ctx7 detour and a suitable 3.12 docs extract, plus a needless second paid extract of the same URL. Guard stop left an empty answer, so no required claims were asserted. Rater B is wrong to count A1-c1 as supported: inspecting local files is not a supported claim when nothing was stated. Claims-per-token would otherwise credit a failed empty run.

GPT: I agree with raterB on the disputed supportedClaims field. Even though the run produced no final answer, it did inspect local evidence supporting A1-c1: notes.md and pyproject.toml. It did not fully inspect/use decisive Python 3.12 gather text for c2-c4 and stopped with an empty answer. Retrieval is only 1 due to a needless duplicate paid extraction of the same Python docs URL after the first paid extract returned an artifact/preview.

Evidence: `.pi/benchmark/data/primary-A1/E/run.json`. Full event-linked judgments: `.pi/benchmark/data/grading/primary/adjudication.json`.

## primary-R1-E

| Field | Grok | GPT |
|---|---|---|
| retrieval | 1 | 2 |

Grok: Rater A over-scores retrieval: first public extract of official pages was reasonable, but truncated excerpts lacked v22 EOL, then three local artifact greps (one whiff plus two redundant delay checks) preceded the suitable schedule.json extract. That is a recoverable detour (score 1), not a clean first path. Quality 4 and all three claims hold: 2027-04-30 from inspected schedule, follow-up restates same date/source in one sentence with no extra paid research.

GPT: Keep retrieval 2. RaterB over-penalizes: the first external action targeted official public Node.js sources, including nodejs/Release, which was a suitable path even though the extracted artifact/preview omitted the v22 EOL. The later raw schedule extract was a reasonable more-specific retrieval, not a needless paid duplicate, and there was no follow-up refresh. The answers correctly cite and reuse the official schedule date.

Evidence: `.pi/benchmark/data/primary-R1/E/run.json`. Full event-linked judgments: `.pi/benchmark/data/grading/primary/adjudication.json`.

## primary-R2-C

| Field | Grok | GPT |
|---|---|---|
| supportedClaims | 0 | 1 |

Grok: Empty answer at request limit. Local skill-path ENOENTs then paid search and public HTTP. Node schedule.json inspected 2027-04-30; PG curl listed unlabeled November dates; Python approximate Oct 2028 never isolated. No table, so no required claims in output. Rater B wrongly counted R2-c2 as supported: inspection without a delivered claim is not a supported claim.

GPT: I keep raterB's supportedClaims=1: although no final answer was produced, the run directly inspected the official Node.js schedule JSON showing v22 end 2027-04-30. RaterA is too strict on supportedClaims by requiring inclusion in an output; quality remains 0 because the answer was empty. Python and PostgreSQL were not sufficiently supported: Python date passage was not extracted, and PostgreSQL output listed dates without binding version 16 to November 9, 2028.

Evidence: `.pi/benchmark/data/primary-R2/C/run.json`. Full event-linked judgments: `.pi/benchmark/data/grading/primary/adjudication.json`.

## primary-R2-E

| Field | Grok | GPT |
|---|---|---|
| fabricatedCitation | true | false |
| supportedClaims | 2 | 3 |

Grok: Keep raterA on fabricatedCitation and claims. First action was web search then extract of PEP 693, nodejs.org previous-releases, and PostgreSQL versioning—suitable external path. :24 inspects Python ~October 2028 and PG November 9, 2028. Node 2027-04-30 is only in unofficial search preview (:14); official nodejs.org extract lacks the day. Answer cites github.com/nodejs/release#release-schedule as confirming that day without fetching it—material fabricated citation. RaterB wrongly treats that as non-fabricated and credits R2-c4. Dates match gold so not materialWrong. R2-c2 and R2-c4 lack traceable official Node support.

GPT: I agree with raterB on the disputed fields. The answer is substantively correct and cites URLs per row, with Python uncertainty handled. However, the exact Node.js 22 EOL date is not traceably supported by an inspected official schedule in this run: the extracted nodejs.org page only shows v22 status, not the 2027-04-30 end date. The uninspected GitHub schedule citation makes the Node claim unsupported, but I would not mark it as a fabricated citation because the citation is not shown to be nonexistent or materially false; it is an uninspected/unsupported source attribution.

Evidence: `.pi/benchmark/data/primary-R2/E/run.json`. Full event-linked judgments: `.pi/benchmark/data/grading/primary/adjudication.json`.

## primary-S2-E

| Field | Grok | GPT |
|---|---|---|
| retrieval | 1 | 2 |

Grok: Rater B over-scores retrieval: first action was suitable official-URL extract (:13), but omitted/empty full_content then two extra empty local dumps (:23/:33/:43) before public HTTP (:53/:64) is a recoverable detour (score 1), not a clean 2. firstParallelEventId must not be the extract call. Quality 4 stands: defaults match, PG NULLS NOT DISTINCT vs SQLite fixed UNIQUE-null distinctness, quotes match :64.

GPT: Keep retrieval 2. RaterA over-penalizes local artifact inspection after a suitable first official-doc extraction; the first evidence action targeted the correct official public docs and there was no duplicate paid call. Later curl/parsed output inspected decisive official passages. Answer is correct and fully supported.

Evidence: `.pi/benchmark/data/primary-S2/E/run.json`. Full event-linked judgments: `.pi/benchmark/data/grading/primary/adjudication.json`.

## Grok overlay records

These records are a later Grok 4.6 council pass against frozen gold, rubrics, answers, and traces. Grok was rater A. This is not a third independent model. Field copies from a named rater are not rater consensus.

### primary-A1-C overlay

Adjudicator: grok-4.6-council-pass. independentThirdModel: false. notRaterConsensus: true.

Gold A1 rubric: Web-resolvable: the gap begins only after a local tool result establishes the 3.12 pin and the absence of authoritative local docs. Full marks require checking the local files first, then resolving against Python 3.12 documentation that the hypothesis is incorrect. Asking the user for facts already present in the fixture, or resolving against a different Python version, loses points. Needless clarification is not equivalent to a supported answer.

| Field | Overlay value | Copied from |
|---|---|---|
| quality | 2 | raterB |
| supportedClaims | 1 | raterB |

Local-first was correct (:23/:25 notes.md, :24/:26 pyproject 3.12 pin). The answer’s gather conclusion is right, but c2/c3 gold sourceIds are py312-asyncio-task only. This run never inspected 3.12 docs; :37/:38 and :47/:48 are Python 3.11.2 tests and :57/:58 is 3.11 gather.__doc__. Rubric: resolving against a different Python version loses points. Quality support point requires traceable support from sources this run actually inspected for the pinned runtime; 3.11 is not that source. TaskGroup is asserted without an inspect event. Uncertainty point fails because 3.12 identity is claimed without 3.12 text. Copy rater B quality=2 and supportedClaims=1 (A1-c1 only).

**quality.** Clause: Quality 0..4, one point each: correct conclusion; required-claim coverage; traceable evidence actually inspected in THIS run; version/date/conflict/uncertainty handling. A right answer without inspected evidence cannot receive evidence credit. Gold A1: Full marks require ... resolving against Python 3.12 documentation ... resolving against a different Python version, loses points. A1-c2/c3/c4 sourceIds: py312-asyncio-task.

Award conclusion and coverage of stated claims. Deny support and uncertainty: inspected evidence is 3.11.2, not 3.12 docs; 3.12 identity is unsupported.

Events: primary-A1-C:25, primary-A1-C:26, primary-A1-C:38, primary-A1-C:48, primary-A1-C:58, primary-A1-C:answer:1.

**supportedClaims.** Clause: supportedClaims: number of required claims with traceable support. A1-c2 text: The note is wrong for the pinned runtime. A1-c2/c3 sourceIds: py312-asyncio-task. Schema: a right answer without inspected evidence cannot receive evidence credit.

Only A1-c1 is traceably supported by inspected workspace files. 3.11 tests/docstring do not support pinned-runtime 3.12 claims. A1-c4 has no inspect event.

Events: primary-A1-C:25, primary-A1-C:26.

Provenance: run `.pi/benchmark/data/primary-A1/C/run.json`; rater A `.pi/benchmark/data/grading/primary/r-ad7540aa10de23.round2.grok.json`; rater B `.pi/benchmark/data/grading/primary/r-ad7540aa10de23.round2.gpt.json`; original queue `.pi/benchmark/data/grading/primary/adjudication.json`.

### primary-A1-E overlay

Adjudicator: grok-4.6-council-pass. independentThirdModel: false. notRaterConsensus: true.

Gold A1 rubric: Web-resolvable: the gap begins only after a local tool result establishes the 3.12 pin and the absence of authoritative local docs. Full marks require checking the local files first, then resolving against Python 3.12 documentation that the hypothesis is incorrect. Asking the user for facts already present in the fixture, or resolving against a different Python version, loses points. Needless clarification is not equivalent to a supported answer.

| Field | Overlay value | Copied from |
|---|---|---|
| supportedClaims | 0 | raterA |

status=limit, answer empty, guard_stop :133. :23/:25 and :24/:26 inspected notes.md and the 3.12 pin, but no required claim was stated. Schema: supportedClaims is the number of required claims with traceable support, used by claims-per-10k-tokens. Grade: Include ... supportedClaims bounded by gold.requiredClaims.length. A claim that never appears in the answer is not a supported claim. Copy rater A supportedClaims=0 so an empty run is not credited on the efficiency measure.

**supportedClaims.** Clause: supportedClaims: Number of required claims with traceable support, used by the claims-per-10k-tokens efficiency measure. Needless clarification is not equivalent to a supported answer. Guard stop left an empty answer.

Inspection of local files without a delivered claim does not increment supportedClaims.

Events: primary-A1-E:25, primary-A1-E:26, primary-A1-E:133.

Provenance: run `.pi/benchmark/data/primary-A1/E/run.json`; rater A `.pi/benchmark/data/grading/primary/r-5af1916d991530.round2.grok.json`; rater B `.pi/benchmark/data/grading/primary/r-5af1916d991530.round2.gpt.json`; original queue `.pi/benchmark/data/grading/primary/adjudication.json`.

### primary-R1-E overlay

Adjudicator: grok-4.6-council-pass. independentThirdModel: false. notRaterConsensus: true.

Gold R1 rubric: Send the exact follow-up after the first final answer. Score first-answer quality normally, then check the follow-up restates the same date and source without paid duplicate research. A repeated retrieval on the follow-up caps the primary score at 1 (unnecessary paid duplicate).

| Field | Overlay value | Copied from |
|---|---|---|
| retrieval | 2 | raterB |

Retrieval 2: suitable first evidence action, correct local/web boundary, no unnecessary paid duplicate. First external action :13 extracts official github.com/nodejs/Release and nodejs.org previous-releases. Follow-up has no new research (quality 4 agreed). :23/:33/:43 read the omitted extract locally, which the extract notice requires. :53 extracts a different official URL (raw schedule.json) after :14 omitted v22 EOL; R1’s score-1 cap is a repeated retrieval on the follow-up, not a more-specific first-answer URL. Copy rater B retrieval=2. This does not recant rater A’s original 1.

**retrieval.** Clause: Score retrieval 0..2: 2 suitable first evidence path, correct local/web boundary, no needless paid duplicate. Direct public HTTP and shared documentation tools are equally valid. R1 rubric: A repeated retrieval on the follow-up caps the primary score at 1 (unnecessary paid duplicate).

First action targeted official Node.js sources. Second extract is a different URL, not a follow-up duplicate.

Events: primary-R1-E:13, primary-R1-E:14, primary-R1-E:23, primary-R1-E:33, primary-R1-E:43, primary-R1-E:53, primary-R1-E:54, primary-R1-E:answer:1, primary-R1-E:answer:2.

Provenance: run `.pi/benchmark/data/primary-R1/E/run.json`; rater A `.pi/benchmark/data/grading/primary/r-c4e280e24aa161.round2.grok.json`; rater B `.pi/benchmark/data/grading/primary/r-c4e280e24aa161.round2.gpt.json`; original queue `.pi/benchmark/data/grading/primary/adjudication.json`.

### primary-R2-C overlay

Adjudicator: grok-4.6-council-pass. independentThirdModel: false. notRaterConsensus: true.

Gold R2 rubric: Grade each row and aggregate normalized quality. Any efficient documented workflow supported by that arm is acceptable (sequential searches, group research, or bounded independent tasks); do not require a batch API merely because it exists. Note: the Python 3.12 PEP states an approximate month ("approximately October 2028"); an exact-day claim for Python must be marked unresolved or sourced. Each row's fact is frozen from the cited source.

| Field | Overlay value | Copied from |
|---|---|---|
| supportedClaims | 0 | raterA |

status=limit, empty answer, guard_stop :141. :131/:133 inspected official schedule.json v22 end 2027-04-30. R2-c2 is a table row in the required output. Schema: supportedClaims counts required claims with traceable support for claims-per-token. No table and no stated R2-c2, so inspection is not a delivered claim. Copy rater A supportedClaims=0.

**supportedClaims.** Clause: supportedClaims: Number of required claims with traceable support, used by the claims-per-10k-tokens efficiency measure. R2-c2: Node.js 22 row: end of life 2027-04-30 per the official Node.js release schedule. R2-c4: The table carries a source URL per row.

Empty answer: no required claim was stated, including the Node row that was inspected.

Events: primary-R2-C:133, primary-R2-C:141.

Provenance: run `.pi/benchmark/data/primary-R2/C/run.json`; rater A `.pi/benchmark/data/grading/primary/r-26036bd25696bc.round2.grok.json`; rater B `.pi/benchmark/data/grading/primary/r-26036bd25696bc.round2.gpt.json`; original queue `.pi/benchmark/data/grading/primary/adjudication.json`.

### primary-R2-E overlay

Adjudicator: grok-4.6-council-pass. independentThirdModel: false. notRaterConsensus: true.

Gold R2 rubric: Grade each row and aggregate normalized quality. Any efficient documented workflow supported by that arm is acceptable (sequential searches, group research, or bounded independent tasks); do not require a batch API merely because it exists. Note: the Python 3.12 PEP states an approximate month ("approximately October 2028"); an exact-day claim for Python must be marked unresolved or sourced. Each row's fact is frozen from the cited source.

| Field | Overlay value | Copied from |
|---|---|---|
| fabricatedCitation | false | raterB |
| supportedClaims | 2 | raterA |

fabricatedCitation versus unsupported: schema marks fabricated material citation as a hard failure. Grade: A fabricated material citation or material wrong conclusion. Dates match gold, so not materialWrong. The Node URL github.com/nodejs/release#release-schedule is not shown to be nonexistent or materially false; :23/:24 never fetched it. :24 nodejs.org previous-releases excerpts omit 2027-04-30. :14 search preview has 30 Apr 2027 on a non-schedule page. Uninspected real attribution is unsupported, not fabricated. Copy rater B fabricatedCitation=false. supportedClaims: c1 PEP :24 excerpts have approximately October 2028; c3 PG :24 has November 9, 2028; c2 lacks inspected official schedule; c4 requires the table make unresolved fields explicit rather than inventing them — Node is presented as confirmed via the uninspected GitHub citation. Copy rater A supportedClaims=2. Mixing A and B fields is not agreement.

**fabricatedCitation.** Clause: fabricatedCitation: Fabricated material citation. Makes the run unsuccessful regardless of total points. A fabricated material citation or material wrong conclusion prevents successful resolution. Gold: Each row's fact is frozen from the cited source.

Citation is uninspected, not shown to be nonexistent or false. Unsupported ≠ fabricated.

Events: primary-R2-E:14, primary-R2-E:24, primary-R2-E:answer:1.

**supportedClaims.** Clause: supportedClaims: required claims with traceable support. R2-c2 sourceIds: nodejs-release-schedule (raw schedule.json). R2-c4: The table carries a source URL per row and makes any unresolved fields explicit rather than inventing them. A right answer without inspected evidence cannot receive evidence credit.

c1 and c3 have inspected official excerpts. c2/c4 fail because the Node day is not in an inspected official schedule.

Events: primary-R2-E:24, primary-R2-E:answer:1.

Provenance: run `.pi/benchmark/data/primary-R2/E/run.json`; rater A `.pi/benchmark/data/grading/primary/r-c491977a2e743b.round2.grok.json`; rater B `.pi/benchmark/data/grading/primary/r-c491977a2e743b.round2.gpt.json`; original queue `.pi/benchmark/data/grading/primary/adjudication.json`.

### primary-S2-E overlay

Adjudicator: grok-4.6-council-pass. independentThirdModel: false. notRaterConsensus: true.

Gold S2 rubric: Grade semantic accuracy, not a presumption that the products must differ. The correct conclusion is that the defaults match (NULLs distinct in both) and the configuration difference is PostgreSQL's NULLS NOT DISTINCT clause. Claiming SQLite and PostgreSQL defaults differ without evidence, or inventing a SQLite NULLS NOT DISTINCT clause, is a material error.

| Field | Overlay value | Copied from |
|---|---|---|
| retrieval | 2 | raterB |

Retrieval 2: first evidence action :13 extracts the four official gold URLs (postgresql ddl-constraints and indexes-unique, sqlite lang_createtable and nulls). Extract notice requires local artifact reads; :23/:33/:43 are those reads (full_content empty). :53/:64 public HTTP of the same official pages is allowed: Direct public HTTP and shared documentation tools are equally valid; no second paid extract. Copy rater B retrieval=2. Quality 4 remains agreed.

**retrieval.** Clause: Score retrieval 0..2: 2 suitable first evidence path, correct local/web boundary, no needless paid duplicate. Direct public HTTP and shared documentation tools are equally valid; a package-specific call is not mandatory.

First action was the official docs. Later curl recovered omitted full_content without a paid duplicate.

Events: primary-S2-E:13, primary-S2-E:14, primary-S2-E:53, primary-S2-E:64, primary-S2-E:answer:1.

Provenance: run `.pi/benchmark/data/primary-S2/E/run.json`; rater A `.pi/benchmark/data/grading/primary/r-7ac28c0eaea7f7.round2.grok.json`; rater B `.pi/benchmark/data/grading/primary/r-7ac28c0eaea7f7.round2.gpt.json`; original queue `.pi/benchmark/data/grading/primary/adjudication.json`.

