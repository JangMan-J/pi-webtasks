# Council implementation

Date: 2026-09-23.

This change combines the accepted recommendations from the impact and wording councils.
The impact council selected lazy exposure first and artifact reach second.
The wording council selected the activator description and prompt snippet.

## Implemented scope

| Component | Change | Verification |
| --- | --- | --- |
| Initial tool exposure | Lazy by default. Only `0` and `false` disable it. | Environment, registration, lifecycle, and loader tests |
| Activator | Required nonempty `tools` enum. Only selected missing tools become active. | Selection, repetition, invalid-input, and unrelated-tool tests |
| Full-surface hosts | All nine original tools, without the activator. Unsupported activation hosts retain all tools. | Registration and fallback tests |
| Activator wording | Missing-and-needed rule, positive capability cues, and direct use of already-visible tools. | Registered descriptions and rendered prompt tests |
| Artifact names | Short timestamp-and-nonce names. JSON and Markdown share a stem. | Exclusive writes, collision handling, and legacy-path tests |
| Artifact navigation | Bounded `field_map` with JSON paths, text lengths, and exact saved line ranges. | Nested Task, Group, FindAll, Responses, and Search fixtures |
| Readable previews | Complete excerpts, omitted counts, and exact local-read offsets. | Synthetic S2 navigation replay and preview-budget tests |
| Benchmark compatibility | Explicit baseline flags, activation details, and artifact-navigation strata. | Benchmark tests and historical S2 trace classification |
| Schema inventory | Real-loader extraction of both exposure modes. | Nine all-active tools versus four initial lazy tools |

The wording proposal originally retained an empty parameter object and all-six activation.
Those mechanics conflict with the impact council's required selector.
The implementation preserves the wording rule and adapts its mechanics to targeted activation.
Task, Responses, and other speculative rewording alternatives remain outside the accepted scope.

No consent gate changed. The implementation does not deploy, publish, or create recurring monitors.
The existing change in `docs/round2-results.md` remains intact.

## Artifact contract

Automatically generated artifacts use `<UTC timestamp>-<short nonce>.json`.
Their Markdown companions normally use the same stem with `.md`.
An existing companion remains intact. A collision adds a short nonce to the new companion.
Explicit JSON paths retain their existing overwrite rules.

The readable receipt supplies the full Markdown path and the JSON basename in that same directory.
The `field_map` describes the raw JSON, not the Markdown file.
It covers strings, string arrays, and structured `content` objects with at least 200 Unicode code points.
Its entries contain exact one-based, inclusive line ranges and character counts.
A shortened map identifies omitted fields and the next field's starting line.
Identifiers and diagnostics take priority over the map.

The raw JSON retains the redacted response shape.
Unicode NEL, line-separator, and paragraph-separator characters use JSON escapes to keep line numbers stable.
Search and Extract previews contain complete excerpts that fit the budget.
Other text previews, such as citation reasoning, retain their existing clipping rules.
The full saved evidence remains available without another request.

## Offline verification

The combined implementation passed:

- `npm run check`: typecheck and 131 extension tests.
- `npm run typecheck:bench`: benchmark typecheck.
- `npm run test:bench`: 84 benchmark tests.
- `git diff --check`.

The historical S2 trace still identifies two failed reads and enters the artifact-navigation stratum.
The new S2 fixture reproduces the response shape, not the original remote response bytes.
Its copied paths resolve, complete excerpts retain source order, and advertised line ranges return the expected evidence.

Fresh schema extraction reports 16,809 provider-schema characters for all nine tools and 6,681 for the initial lazy surface.
This is a 60.3% schema-character reduction, not a token or whole-run savings estimate.
The generated inventory is in `.pi/research/council-implementation/schemas/`.

## Behavioral screening

`bench/reach.ts` uses the real Pi CLI, extension, and model with a local Parallel fixture API.
The fixture API never forwards a request. Unsupported operations fail closed.
This screen uses model capacity but makes no billable Parallel request.
It does not measure live research quality or reproduce the older benchmark conditions.

The screen covers source discovery, known-URL extraction, cited synthesis, existing Task and FindAll IDs, scoped Memory retrieval, company discovery, mixed workflows, and artifact reads.
It checks activation separately from the required operation, ID reuse, answer content, ordering, and tool errors.
It records cumulative input tokens, peak input tokens, tool turns, activation timing, wall time, and artifact navigation.

Run the screen with a new output directory:

```sh
node bench/reach.ts .pi/research/reach-screen 2
```

Run only the specified cases:

```sh
node bench/reach.ts .pi/research/reach-screen-task 2 task mixed
```

`REACH_PROVIDER`, `REACH_MODEL`, and `REACH_THINKING` select the model.
The defaults are `openai-codex`, `gpt-5.5`, and `high`.
Case order and condition order use a fixed random seed.
Each paired condition runs sequentially. Up to four independent cases run concurrently.

Results and evidence for this implementation are in `.pi/research/council-implementation/`.
The final report is `screening-final.json`. Raw model events remain in `reach-declared-fixtures/`.
Runtime source hashes match the tested extension files.

### Results

The final screen used `openai-codex/gpt-5.5` with high thinking configured.
Nine cases ran twice under each condition, for 18 pairs and 36 model runs.

| Measure | All-active baseline | Targeted lazy |
| --- | ---: | ---: |
| Required operation and expected answer | 18/18 | 18/18 |
| Error-free runs | 16/18 | 16/18 |
| Required deferred activations | Not applicable | 12/12 |
| Unnecessary activations | 0 | 0 |
| Cumulative input tokens, including cached input | 216,281 | 165,211 |
| Mean peak input tokens | 4,931 | 3,478 |
| Model turns | 47 | 56 |
| Sum of per-run elapsed seconds | 187.7 | 202.5 |
| Nominal model cost, not invoiced cost | $0.4249 | $0.4823 |

Lazy exposure reduced cumulative input tokens by 23.6% in this screen, but added nine model turns.
It did not improve elapsed time or nominal model cost.
These are descriptive fixture results from one model, not proof of a general cost or latency improvement.
The change remains uncommitted and unpublished. A broader release decision must account for this tradeoff.

All four company-discovery runs first supplied `entity_type: "company"`, then corrected it to `"companies"` after validation failed.
This existing argument-description problem affected both conditions. The council did not select that field for this change.

The artifact-navigation stratum keeps both conditions together whenever either condition reads a saved artifact.
Seven pairs entered that stratum: cumulative input was 99,113 versus 71,750 tokens.
The other eleven pairs used 117,168 versus 93,461 tokens.

### Fixture corrections

The first screen did not tell the model that the service returned synthetic records.
The model questioned the placeholder sources and future release date, then tried to verify them.
The final screen identifies the fixtures explicitly. Earlier results remain saved and are not pooled with the final screen.

The initial FindAll fixture also lacked the status envelope used during a wait.
The corrected fixture passed all four targeted reruns before the final screen.
This was a test-fixture defect, not an extension failure.

The artifact question requests the marker, not its descriptive label.
The final scoring accepts `jade-73` alone and corrects two false failures without another model call.
Original events and scores remain intact.

## Integration records

| Work | Model | Exclusive branch |
| --- | --- | --- |
| Tool exposure | `openai-codex/gpt-5.5`, high | `impl/council-exposure` |
| Artifact reach | `anthropic/claude-opus-5-5`, high | `impl/council-artifacts` |
| Benchmark review | `openai-codex/gpt-5.5`, high | Read-only review of the main checkout |

Both implementation worktrees started at `ab0c5683b969e4e9141a7479e4e497abf8216e77`.
They remain under `.pi/worktrees/` for inspection. No worker remains active.
Main integrated the patches without commits and verified the combined result.
