# Legacy pi-parallelized interface

Historical baseline documentation. This is not the current three-command contract.
See the root README and `docs/api-mapping.md` for the new package.

Native Parallel tools for Pi. The operations and result helpers have no Pi imports.
The only runtime dependency is `parallel-web@1.3.3`.

The `src/results.ts` module owns research receipts, including operation errors and artifact-write failures. The Pi adapter supplies context and presents receipts.

## Keys

Set `PARALLEL_API_KEY` (or `PIPARA_API_KEY`) in the environment.

As a convenience, the extension also loads a `.env` or `parallel.env` file placed next to it (its own directory, not the current working directory) before any tool runs. Real environment variables always take precedence over the file. The environment and the file may use either the extension's own names or the Parallel account's natural names, which are aliased automatically. A `PIPARA_*` name that is already set, even to an empty string, is never overridden:

| Natural name (environment or `parallel.env`) | Resolves to |
| --- | --- |
| `PARALLEL_API_KEY` | `PIPARA_API_KEY` |
| `PARALLEL_WEBHOOK_KEY` | `PIPARA_WEBHOOK_SECRET` |

Keep the file out of version control; `.gitignore` already excludes `.env`, `.env.*`, and `parallel.env`.

## Development

Requirements: Node.js 22.19 or later and npm. Development dependencies pin the Pi packages used for tests and type checking.

```sh
npm ci
npm run check
```

`npm run check` checks types in the runtime code and shared test host, then runs the extension's offline tests.
`npm run check:all` also checks benchmark types, runs benchmark tests, and verifies the frozen source hashes and fixtures.
Neither command makes paid API requests.
The test host uses the local Pi dependency by default. `PI_PACKAGE_DIR` selects another installed Pi package for loader tests.

```text
src/                 Extension entry point, operations, receipts, and webhook validation
tests/               Offline regression tests
bench/               Isolated comparison harness, frozen gold sources, and offline checks
tests/helpers/       Shared Pi loader and isolated HTTP fixtures
scripts/             Documentation snapshots and explicitly enabled live checks
docs/                Pinned reference comparison and acceptance ledger
package.json         Pi manifest, dependencies, and development commands
package-lock.json    Locked dependency versions
tsconfig.json        Strict type checking
```

This checkout is independent of the installed extension. Copying it does not change Pi settings or activate this version.
To register this package later, use `pi install /absolute/path/to/pi-parallelized`.
Avoid loading both this checkout and another installed copy, because they register the same tools.

## Tool selection guidance

The extension shares one knowledge-gap rule across Search, Extract, and Responses. Pi renders identical active-tool guidelines once.
An unresolved external fact triggers retrieval before another unsupported guess. A clearly external gap needs no preliminary local lookup.
Known URLs favor Extract, source discovery favors Search, and cited synthesis can start with Responses.
Task, Group, and FindAll serve distinct research jobs without a required Search stage.
Existing artifacts take precedence over repeated paid requests. Local state, offline instructions, and private data retain their boundaries.
Memory requires account access. If the API reports that Memory is unavailable for the account, use saved artifacts instead of retrying.
Task calls already use the research API key. Application memory also requires `memory_scope_key` on creation and retrieval.
The scope names a memory bank, not a credential. The [Memory guide](https://docs.parallel.ai/resources/memory) explains account rollout and scope behavior.

All nine tools start active by default, without `parallel_tools`. This keeps the tool list stable during a session.

To enable lazy exposure, set `PIPARA_LAZY_TOOLS=1` or `PIPARA_LAZY_TOOLS=true` before starting Pi.
Search, Extract, Responses, and `parallel_tools` then start active. Task, Group, FindAll, Monitor, Memory, and Account remain registered but inactive.
Activation changes the tool list and can reduce prompt-cache reuse in long sessions.
Unset, `0`, `false`, and unrecognized values keep all nine tools active. Hosts without Pi's activation API also keep all nine active.

In lazy mode, if a needed tool is missing, call `parallel_tools` with its exact name:

```json
{ "tools": ["parallel_task"] }
```

The required `tools` array accepts `parallel_task`, `parallel_group`, `parallel_findall`, `parallel_monitor`, `parallel_memory`, and `parallel_account`.
The activator adds only selected missing tools and preserves unrelated active tools.
Search, Extract, and Responses never need activation. Their use does not prevent later activation of a deferred tool.

The tool snippets state selection conditions. Guidelines preserve continuation and authorization rules, while schemas describe parameter mechanics.
No runtime stall detector or additional AGENTS.md rule is installed.

For evaluations, use the default Pi prompt with `--append-system-prompt` for extra instructions.
`--system-prompt` replaces the default prompt and omits its generated tool guidelines unless the evaluator supplies them explicitly.
The prompt-composition tests verify this distinction. They do not measure model compliance or prove improved tool selection.

## Research output

The [tool reference](docs/tool-reference.md) covers artifact navigation, advanced TaskSpec templates, and higher-tier Task prices.
Tools include a stable local reference path. The reference loads only when an agent reads it, without changing tool registration.

Every research result has a persistent JSON artifact.
The default directory is `getAgentDir()/parallelized/results/`.
Pi resolves `getAgentDir()` from its configuration, including `PI_CODING_AGENT_DIR`.

- `return_mode: "preview"` is the default. It returns selected fields, source URLs, identifiers, counts, and bounded diagnostics.
- `return_mode: "file"` returns the artifact receipt and control information. It omits report bodies and excerpts.
- The serialized response text defaults to a 24,000-character budget, including the receipt. `preview_chars` accepts 2,000–64,000.
- `output_path` selects an explicit artifact path. `overwrite: true` permits replacement.
- Automatic filenames are unique. New files use mode `0600`. New directories use mode `0700`.
- Artifacts contain complete collected responses, except credential fields, which the helper redacts.
- Responses streams continue through `response.completed` and retain the final answer and citations. They have no 200-event cutoff.
- Failed, interrupted, cancelled, or incomplete Responses streams return an error receipt with `partial: true`, the received events, and any response ID.
- Task, Group, and FindAll streams use local deadlines through connection setup and body consumption. Default `wait_seconds` is 15.
- Stream deadlines return `timeout: true` and `partial: true`. Cancellation and error events throw with saved partial events.
- Task events have no count cutoff. Reconnection replays active traces without a cursor.
- Group and FindAll streams collect up to 40 events. Group `runs` accepts a different `limit`.
- `limit_reached: true` means collection stopped at the cap, not that more events necessarily exist. Continue with `last_event_id`.
- Artifacts remain until the user removes them. No automatic deletion runs.

### Retrieval and preview sizing

API retrieval and local preview budgets are independent. Complete collected responses stay on disk even when the preview omits content.

| Control | Search default | Extract default |
| --- | ---: | ---: |
| `max_results` | 20, the API maximum | One result per requested URL, when available |
| `max_chars_total` | 50,000 excerpt characters | 100,000 excerpt characters |
| `max_chars_per_result` | 10,000 excerpt characters | 20,000 excerpt characters |
| `full_content` | Not supported | `true` |
| `preview_chars` | 24,000 returned characters | 24,000 returned characters |

Explicit arguments override these defaults. `max_chars_total` limits API excerpts, not full content or the saved JSON size.
For excerpts-only extraction, set `full_content: false`. A full-content settings object can set its own per-source character limit.
`preview_chars` changes only the local return and is never sent to the API. File mode still omits evidence bodies.
Search can return fewer than the requested number of results.

The preview uses available space instead of a fixed five-source or 900-character answer cap. Complete answers appear when they fit.
Oversized answers include shortening indicators and saved-file pointers. Identifiers, diagnostics, and evidence metadata retain priority.

Task previews include confidence, bounded reasoning, and source excerpts alongside citation URLs. Low and null confidence remain visible.
Responses previews label citation offsets as coordinates in the original artifact text, not the clipped preview.
Search-trail summaries count searches and page-read attempts. A page-read event does not prove successful retrieval.

Receipts include a bounded `field_map` for saved text of at least 200 Unicode code points.
It gives JSON paths, character counts, and exact line ranges in the raw JSON artifact.
Long string arrays and structured `content` objects each use one map entry.
A shortened map includes an omitted-field count and the next field's starting line.
Control IDs and diagnostics take priority over the map.

Use the preview first. If more detail is necessary, read the saved evidence or selected JSON fields.
Do not repeat a paid request to recover omitted output.

### Search and Extract presentation

Search and Extract return readable source headings, URLs, and evidence by default.
API-supplied publication dates appear in previews and the saved source index. Missing dates stay absent; dates are not inferred.
Each result also saves a Markdown companion beside the complete JSON artifact.
The companion preserves all returned excerpts and any returned full content, in source order.
The preview shows complete excerpts that fit the budget, rather than fragments. Requested full content can replace excerpt bodies when it fits.
It supplies exact offsets for omitted excerpts and states whether full content was requested, unavailable, or saved.
Each companion starts with a source index. The preview points to that index so omitted sources remain easy to locate.
It does not generate summaries or fetch additional content.
The [offline evaluation](docs/evidence-evaluation.md) records tested behavior and the limits of those checks.

The same `preview_chars` budget applies. File mode omits evidence bodies but supplies the saved file locations.
Automatic JSON and Markdown filenames share one short timestamp-and-nonce stem.
The readable receipt prints the directory once, in the full Markdown path.
The raw JSON basename refers to that same directory.
Existing companion files remain intact, including after an explicit JSON overwrite. A name collision adds one short nonce to the new companion.
Old artifacts remain readable.
If companion creation fails, the tool returns the original JSON receipt without another API request.
Other tools and error receipts retain their existing format.

For an A/B comparison, launch otherwise identical sessions with one presentation setting:

```sh
PIPARA_OUTPUT_FORMAT=json pi       # A: original JSON previews, no Markdown companion
PIPARA_OUTPUT_FORMAT=readable pi   # B: readable previews and Markdown companion (default)
```

The switch changes presentation only. Tool schemas, prompt guidance, API requests, and complete JSON artifacts stay unchanged.
Use fresh sessions and the same model, prompts, and limits for both arms.

## Workflow controls

Task creation accepts text or a JSON object as `input`.
Task creation and Group addition accept `output_schema` as a JSON Schema object or JSON string. The extension supplies the required TaskSpec wrapper.

```json
{
  "action": "create",
  "input": "Summarize the IETF's role with sources.",
  "processor": "base",
  "output_schema": {
    "type": "object",
    "properties": { "answer": { "type": "string" } },
    "required": ["answer"]
  }
}
```

The advanced `task_spec` parameter remains available for text, auto, and full specifications. It cannot accompany `output_schema`. FindAll enrichment accepts the same schema forms.

FindAll accepts `match_conditions` as an array of `{name, description}` objects or its JSON string. Ingest can supply conditions and entity type, but it cannot change the selected generator. Defaults remain `core` for creation and `preview` for preview calls.

FindAll `result` polls internally for up to `wait_seconds`, with a default of 45 seconds. Zero requests one snapshot. Completion, failure, inactive state, or required user action stops polling. A deadline returns the last snapshot and original ID. If the first request never returns a snapshot, the receipt preserves the ID and explains the timeout. Cancellation stops local polling, not the remote run.

Task creation saves an independent receipt before an optional result wait. Subsequent results and failures include `run_id` and `creation_artifact`. The explicit `output_path` remains the final artifact path. A failure to retrieve status does not discard the creation receipt. Cancellation preserves any answer already decoded, but the tool still returns a cancellation error.

Paid submissions and mutations disable automatic SDK retries. Read-only status requests retain retries. FindAll polling has an overall deadline that also aborts in-flight requests. Nested API validation errors expose up to five field diagnostics without their request input values.

Responses accepts `allowed_domains` or `blocked_domains`, with at most 200 entries. The extension requires one list per request.
Entries support domains, path prefixes, and bare extensions such as `.gov`. Schemes, ports, query strings, and fragments are invalid.
The request sends these restrictions through `tools: [{type: "web_search", filters: {...}}]` in both JSON and streaming modes.
Responses conversations require a user message. Metadata accepts an object or JSON string with at most 16 string values.
Keys allow 64 characters, and values allow 512 characters. Non-completed Responses answers return errors with saved content and IDs.

Search and Extract require integer result and character limits. `max_age_seconds` requires at least 600 seconds.
Search path filters require `fast`, `basic`, or `advanced`, not `turbo`.
Monitor updates reject create-only fields: `include_backfill`, `output_schema`, `task_run_id`, and `memory_scope_key`.

An adequate cited Responses answer does not need another paid research call without a concrete evidence gap. Relevant follow-up questions can continue through `previous_response_id`.

### Create-to-deliver recipes

For low latency, use Responses. For new Task workloads, use standard processors. Explicit `-fast` variants remain compatible.

1. Create one Task with the input and selected processor. For narrative output, use this `task_spec` JSON string:
   `"{\"output_schema\":{\"type\":\"text\",\"description\":\"Cited report\"}}"`.
   For structured output, use `output_schema` as in the example.
2. Preserve `run_id` and the creation artifact. Call `result` on that ID until the run completes.
3. Read the necessary `output.content` and `output.basis` fields from the result artifact. Deliver the answer with citations and uncertainty.
4. For a new follow-up Task, pass the returned `interaction_id` as `previous_interaction_id`.

For batches, create one Group and preserve `taskgroup_id`. Add the inputs once.
Call `runs` with `include_output: true`. For each bounded page, preserve `last_event_id` and read the collected outputs from `events`.
If `limit_reached` or `timeout` is true, continue from that cursor. For unfinished runs, inspect status before further collection.
Do not add the same inputs again to retrieve outputs. A receipt or progress event is not the final answer.

The [reference comparison](docs/reference-comparison.md) records source contracts, pinned implementations, acceptance checks, and remaining limits.

Tool descriptions contain only the relevant operation prices. The [Parallel price reference](https://docs.parallel.ai/getting-started/pricing) contains the complete table.

## Webhook receiver

The optional receiver accepts signed callbacks into a durable local inbox.
It uses Node's built-in SQLite support and adds no runtime dependency.
The receiver starts only through an explicit command, not when the extension loads.

Provide an existing signing secret through `PIPARA_WEBHOOK_SECRET`.
Set `PIPARA_WEBHOOK_DIR` to the same inbox directory used by the extension.
Then start one shared receiver:

```sh
npm run webhook:receiver
```

The default address is `http://127.0.0.1:8787/parallel/webhook`.
`PIPARA_WEBHOOK_PORT` changes the port. `PIPARA_WEBHOOK_PATH` changes the request path.
`PIPARA_WEBHOOK_SCHEME=legacy` explicitly selects the legacy signing scheme. The default scheme is `standard`.

Set `PIPARA_WEBHOOK_URL` to the reachable HTTPS callback URL, then start a new Pi process.
New Task, Group, FindAll, and Monitor runs use this URL by default. An explicit URL overrides it, and `webhook_url: null` disables it.
Verified callbacks save result artifacts and wake the owning session through a queued follow-up. No remote status polling is necessary.
The [integration guide](docs/webhook-integration.md) covers required subscriptions, public routing, recovery, and signed delivery checks.

## Benchmark

The [benchmark report](docs/benchmark-results.md) compares this extension with Parallel CLI and Pi-adapted skills.
The recorded experiment contains 30 worker runs on one model. It does not establish extension superiority.
The [protocol](docs/benchmark-plan.md) defines the rubric, isolation, and spending limits.
The [harness guide](bench/README.md) explains reproduction and preserves failed runs as outcomes.

Run the offline benchmark checks:

```sh
npm run check:bench
```

Paid worker execution remains separate from these checks.

## Account output

Account and authentication operations do not create automatic research artifacts.
`create_key` stores its secret in the explicit `save_key_path` with mode `0600`.
The tool returns key metadata, not the raw key.
Existing confirmation requirements remain unchanged.

## Tests

Run the offline suite:

```sh
npm test
```

The suite loads the registered tools through the installed Pi loader.
Research test suites share `tests/helpers/test-host.ts` for temporary HOME, mocked HTTP, request capture, tool execution, and cleanup.
Cleanup restores environment values in place, preserving native HOME lookups. Tests remain serial while they replace process globals.
The fixture covers research, account, and OAuth checks.
It also tests artifact limits, bounded polling, cancellation, schema conversion, retry policy, creation receipts, complete Responses streams, tool registration, and webhook signatures.
No live API request occurs during `npm test`.

The separate live matrix requires explicit consent for paid calls and temporary resources.
It caps reserved estimates at $5 and never adds credit.
It deletes only its own temporary apps and keys, cancels its monitors, and clears only its unique memory scope.

```sh
npm run test:live -- --live /absolute/path/to/test-report.json
```

Use the same report path to resume. The runner does not repeat recorded submissions.
If a step remains `started`, inspect its server state before recovery.
Live login and logout are excluded to preserve the current account session.
