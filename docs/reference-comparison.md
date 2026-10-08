# Reference comparison and acceptance ledger

Status: verified against offline fixtures. No paid API calls were used for implementation verification.

## Scope

Three bounded changes guide this work:

1. Correct request contracts: Responses filters and validation, numeric retrieval controls, structured Task input, and create-only Monitor settings.
2. Preserve usable evidence: completion checks, confidence, citation coordinates, and search-trail summaries.
3. Complete native workflows: bounded stream waits, explicit partial failures, cursor continuation, and create-to-deliver guidance.

Existing tools, redacted artifacts, the 8,000-character ceiling, continuation IDs, and paid-request retry rules remain intact.

## Acceptance ledger

Research tool tests use `tests/helpers/test-host.ts`, which records the request path, query, body, and signal.
Snapshot and webhook tests use separate offline fixtures.

| Item | Acceptance check | Result | Status |
| --- | --- | --- | --- |
| Responses filters | Exact nested `web_search` payload in JSON and SSE calls. Invalid syntax, two lists, and more than 200 entries cause zero requests. Unrestricted follow-ups send no `tools`. | `Responses filters use the supported nested web_search contract in JSON and SSE` (tests/lifecycle.test.ts). `Responses rejects invalid filters, conversations and metadata before HTTP` (tests/contracts.test.ts). | Verified |
| Responses arguments | User messages required. Metadata accepts objects and legacy JSON with 16 keys, 64-character keys, and 512-character string values. | Same two tests. Boundary objects pass schema validation and reach HTTP unchanged. | Verified |
| Retrieval controls | Integer limits, cache age at least 600, and no turbo path filters. Valid boundaries reach HTTP unchanged. | `Search and Extract validate integer controls and turbo path restrictions locally` (tests/contracts.test.ts). | Verified |
| Task and Monitor arguments | Task accepts object input. Monitor rejects create-only update settings before HTTP. | `Task accepts structured input and delivers narrative evidence without repeat creation`. `Monitor rejects create-only update fields but keeps supported settings` (tests/contracts.test.ts). | Verified |
| Completion and evidence | Failed or incomplete answers throw with saved content and IDs. Confidence, excerpts, original citation coordinates, and search-trail counts remain usable. | `Responses rejects incomplete response or message status and preserves partial content`. `Unicode citation previews label original offsets and expose the search trail` (tests/contracts.test.ts). | Verified |
| Streams | Local deadline spans connection setup and body. Cancellation and error events keep partial events. Task collects past 40 events. Cursor collection exposes its limit. | Three stream tests plus `Task replay passes 40 events and Group collection continues without duplicate submissions` (tests/contracts.test.ts). | Verified |
| Delivery recipes | Narrative Task returns content and citations. Group continuation collects every fixture output without repeat submissions. | Same Task and Group tests. Exactly one POST per creation in each fixture. | Verified |
| Regression | `npm run check` and `git diff --check` pass. Saved documents match the snapshot manifest hashes. | 42 tests pass, typecheck passes, and `git diff --check` is clean. All 166 saved resources match their SHA-256 hashes. | Verified |

## Verified source contracts

The current official snapshot at `/home/jangpi/.cache/pi-parallelized/parallel-docs/2026-09-20-current/` is the authority.
Each row names the page that settles the contract.

| Contract | Source | Verified content |
| --- | --- | --- |
| Responses filter shape | `responses-api/features/web-search-tool.md:21` | Filters travel as `tools: [{type: "web_search", filters: {...}}]`. `allowed_domains` maps to `include_domains` and `blocked_domains` to `exclude_domains`. |
| Filter entries | `responses-api/features/web-search-tool.md:76-85` | Apex domains match subdomains. `example.com/blog` scopes to a path prefix. A bare `.gov` matches that extension. Schemes, ports, queries, and fragments are invalid. At most 200 entries across both lists. One list per request. |
| Filter conflicts | `responses-api/openai-compatibility.md:28` | At most one `web_search` tool per request. Every other tool type is accepted and ignored. An entry in both lists returns 400. |
| Responses metadata | `responses-api/openai-compatibility.md:27` | String-valued tags. Max 16 keys, 64 characters per key, 512 characters per value. |
| Cache age | `api-reference/search/search.md:602`, `api-reference/extract/extract.md:557` | `max_age_seconds` minimum is 600 seconds. |
| Turbo paths | `resources/source-policy.md:48-50` | Domain path prefixes are unsupported in Search `turbo` mode. Use `fast`, `basic`, or `advanced`. |
| Task events | `task-api/task-sse.md:95,116` | Streams have no resume cursors. Reconnecting to an active run replays the recorded trace. Non-active runs return status only. |
| Group runs | `task-api/group-api.md:376` | `getRuns` is an SSE snapshot of one event per run. Resume from `last_event_id`. `output` appears only with `include_output=true` on a completed run. |
| Monitor update | `api-reference/monitor/update-monitor.md:236-338` | `UpdateMonitorRequest` accepts only `type`, `frequency`, `processor`, `webhook`, `metadata`, and `settings` with `query` and `advanced_settings`. `include_backfill`, `output_schema`, `task_run_id`, and `memory_scope_key` appear in create and response schemas only. |
| Narrative Task output | `task-api/task-quickstart.md:110` | A text schema `{"type": "text"}` with an optional description produces Markdown reports with inline citations. |
| Search trail | `responses-api/features/web-search-tool.md:110-134` | Every response returns one `web_search_call` item per action. A page that could not be fetched is still reported as read, so a page-read event does not prove retrieval. |

## Comparison with pinned references

Reference root: `/tmp/parallel-comparison.9EOsUp/`. Each row uses the pinned commit, not a moving branch.

| Repository | Pinned commit | Finding |
| --- | --- | --- |
| parallel-web-tools | 12393045b6a17b32a9a28f68c48f1526066b5c29 | No `allowed_domains` or `blocked_domains` anywhere in the CLI. `parallel_web_tools/core/research.py` polls tasks through `interaction_id`. The CLI cannot express Responses domain filters. |
| parallel-agent-skills | 26574f44949334bee46ec6bc7a1c4eba9c08c3c2 | Skills describe Search source policies. No skill covers Responses `web_search` filters. |
| parallel-n8n-nodes | 840666654594cb2ba20256c6d57455dfc52427ca | Search domain policies exist in `nodes/Parallel/contracts/requests.ts:78-80`. These are distinct from Responses filters. `nodes/Parallel/transport/waitForTaskResult.ts` provides a bounded Task wait and preserves the run ID on timeout. |
| parallel-npm-packages, `packages/ai-sdk-tools` | 138955a442c299eb2d157ab3fb69e7b68c917012 | Exposes search and extract tools with `max_results`, `source_policy`, and `fetch_policy`. No Responses, Task, Group, FindAll, or Monitor tools. |
| parallel-npm-packages, `packages/pi-extension` | 138955a442c299eb2d157ab3fb69e7b68c917012 | `web_research` exposes only `query`, `effort`, and `previous_response_id`. `web_search` exposes only `objective` and `search_queries`. No Task, Group, FindAll, or Monitor tools. |

The llms-txt repository is a stale mirror, not current authority.

## Why these changes improve prior workflows

- Domain restrictions now reach the Responses API instead of failing or being ignored. The pinned CLI, skills, n8n nodes, and Pi extension expose no such control.
- Invalid filters, metadata, and message arrays fail before HTTP. A paid request no longer discovers them.
- Stream deadlines cover connection setup and body consumption. A hung stream returns partial events with a timeout flag instead of expiring at headers.
- Task events have no count cutoff, so a 45-event trace no longer replays the same first 40 events.
- Group and FindAll collection reports `limit_reached` and preserves `last_event_id`. Agents can request the next batch without submitting inputs again.
- Non-completed answers return errors with saved content and IDs. A truncated or failed answer cannot pass as final.
- Citation previews label offsets as original-text coordinates and count page reads as attempts. These labels distinguish partial previews from the complete evidence.
- The README adds native Task and Group recipes. The CLI skills already explain creation, polling, and delivery in `parallel-deep-research/SKILL.md:22-99` and `parallel-data-enrichment/SKILL.md:32-93`.
  The new recipes adapt that useful guidance to native calls, persistent receipts, and cursor-based collection.

## Snapshot recreation

```sh
node scripts/snapshot-docs.mjs
```

The script is read-only. It crawls `docs.parallel.ai` Markdown and OpenAPI resources into `~/.cache/pi-parallelized/parallel-docs/<timestamp>/` with a manifest.
It needs no API key and makes no paid calls. `tests/snapshot-docs.test.ts` exercises it offline.

## Limits

No claim of live API verification, answer-quality superiority, or replacement of every external integration is intended.
These fixtures verify request shapes and failure handling, not live service behavior.
Warehouse deployment, CSV frameworks, hosted webhooks, schedulers, authentication changes, and new tools remain outside this work.
