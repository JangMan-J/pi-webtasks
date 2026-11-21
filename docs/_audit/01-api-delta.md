# Audit 01 — API & Feature Delta

Compares `pi-webtasks` (this repo) against `parallel-tools` (`~/Projects/parallel-tools`), which wraps the full Parallel OpenAPI surface.

## 1. API & Feature Delta Inventory

### 1.1 Spec & SDK Baseline

| Aspect | `pi-webtasks` | `parallel-tools` |
|---|---|---|
| Package | `@jangmanj/pi-webtasks` v0.1.2 (`package.json`) | Rust workspace: `crates/parallel-openapi` (generated SDK), `crates/parallel-tools` |
| API contract | `parallel-web@1.3.3` TypeScript SDK (no OpenAPI file in repo) | `spec/parallel-openapi.normalized.json` (OpenAPI 3.1, Parallel API `0.1.2`), normalized by `scripts/normalize-spec.mjs` (`OPERATION_IDS`) |
| SDK gaps | `parallel-web@1.3.3` lacks `/v1/decisions`, `/v1/images/search`, `/v1/places/search`, `/v1/responses`; `web_answer` uses raw `parallel.post("/v1/responses")` | Generated client covers all 39 operations |
| Auth scheme | `Authorization: Bearer` (SDK + raw post) | `ApiKeyAuth` header `x-api-key` (`crates/parallel-tools/src/auth.rs`) |
| Surfaces | 5 Pi tools (`src/research-tools.ts`) | CLI (`main.rs`), MCP server (`mcp.rs`), op catalog (`catalog.rs`, `ops.rs`), SSE (`sse.rs`), output (`format.rs`) |
| Local storage | Node built-in `node:sqlite` (`src/store.ts`) | None (stateless) |

Tool-to-endpoint map in `pi-webtasks`:

| Tool | Endpoint(s) | Code |
|---|---|---|
| `web_search` | `POST /v1/search` | `src/research-service.ts` |
| `web_fetch` | `POST /v1/extract` | `src/research-service.ts` |
| `web_answer` | `POST /v1/responses` (raw) | `src/answer-service.ts` |
| `web_research` | Task Group + Task Run endpoints (6) | `src/task-service.ts`, `src/task-run-lifecycle.ts` |
| `web_recall` | none — local SQLite FTS5 | `src/recall.ts`, `src/store.ts` |

### 1.2 Complete 39-Endpoint Coverage Matrix

Legend: **Used** = called by `pi-webtasks`; **—** = not used. Every row is implemented in `parallel-tools` under the listed `operationId`.

#### Search, Extract, Images, Places (4)

| Endpoint | `operationId` | `pi-webtasks` |
|---|---|---|
| `POST /v1/search` | `search_web` | **Used** — `web_search` |
| `POST /v1/extract` | `extract_urls` | **Used** — `web_fetch` |
| `POST /v1/images/search` | `search_images` | — |
| `POST /v1/places/search` | `search_places` | — |

#### Decisions, Responses, Chat (3)

| Endpoint | `operationId` | `pi-webtasks` |
|---|---|---|
| `POST /v1/decisions` | `decide_questions` | — |
| `POST /v1/responses` | `create_response` | **Used** — `web_answer` (subset) |
| `POST /v1beta/chat/completions` | `create_chat_completion` | — |

#### Tasks (5)

| Endpoint | `operationId` | `pi-webtasks` |
|---|---|---|
| `POST /v1/tasks/runs` | `create_task_run` | — (runs are created via groups) |
| `GET /v1/tasks/runs/{run_id}` | `get_task_run` | **Used** — `taskRun.retrieve` |
| `GET /v1/tasks/runs/{run_id}/input` | `get_task_run_input` | — |
| `GET /v1/tasks/runs/{run_id}/result` | `get_task_run_result` | **Used** — `taskRun.result` with `{ timeout: 0 }` |
| `GET /v1/tasks/runs/{run_id}/events` | `poll_task_run_events` | **Used** — `taskRun.events` |

#### Task Groups (6)

| Endpoint | `operationId` | `pi-webtasks` |
|---|---|---|
| `POST /v1/tasks/groups` | `create_task_group` | **Used** — `taskGroup.create` |
| `GET /v1/tasks/groups/{taskgroup_id}` | `get_task_group` | — |
| `POST /v1/tasks/groups/{taskgroup_id}/runs` | `add_task_group_runs` | **Used** — `taskGroup.addRuns`, 1 run per call (API allows 1..1000) |
| `GET /v1/tasks/groups/{taskgroup_id}/runs` | `list_task_group_runs` | **Used** — `taskGroup.getRuns` (unbound-run recovery only) |
| `GET /v1/tasks/groups/{taskgroup_id}/runs/{run_id}` | `get_task_group_run` | — |
| `GET /v1/tasks/groups/{taskgroup_id}/events` | `poll_task_group_events` | — |

#### FindAll & Entity Search (10)

| Endpoint | `operationId` | `pi-webtasks` |
|---|---|---|
| `POST /v1beta/findall/entity-search` | `search_entities` | — |
| `POST /v1beta/findall/ingest` | `ingest_findall` | — |
| `POST /v1beta/findall/runs` | `create_findall_run` | — |
| `GET /v1beta/findall/runs/{findall_id}` | `get_findall_run` | — |
| `GET /v1beta/findall/runs/{findall_id}/result` | `get_findall_result` | — |
| `GET /v1beta/findall/runs/{findall_id}/schema` | `get_findall_schema` | — |
| `POST /v1beta/findall/runs/{findall_id}/extend` | `extend_findall_run` | — |
| `POST /v1beta/findall/runs/{findall_id}/enrich` | `enrich_findall_run` | — |
| `POST /v1beta/findall/runs/{findall_id}/cancel` | `cancel_findall_run` | — |
| `GET /v1beta/findall/runs/{findall_id}/events` | `poll_findall_events` | — |

#### Monitors (8)

| Endpoint | `operationId` | `pi-webtasks` |
|---|---|---|
| `POST /v1/monitors` | `create_monitor` | — |
| `GET /v1/monitors` | `list_monitors` | — |
| `GET /v1/monitors/stats` | `get_monitor_stats` | — |
| `GET /v1/monitors/{monitor_id}` | `get_monitor` | — |
| `POST /v1/monitors/{monitor_id}/update` | `update_monitor` | — |
| `POST /v1/monitors/{monitor_id}/trigger` | `trigger_monitor` | — |
| `GET /v1/monitors/{monitor_id}/events` | `list_monitor_events` | — |
| `POST /v1/monitors/{monitor_id}/cancel` | `cancel_monitor` | — |

#### Server Memory (3)

| Endpoint | `operationId` | `pi-webtasks` |
|---|---|---|
| `POST /v1beta/memory/retrieve` | `retrieve_memory` | — |
| `POST /v1beta/memory/evict` | `evict_memory` | — |
| `POST /v1beta/memory/clear` | `clear_memory` | — |

**Totals:** 39 endpoints; `pi-webtasks` uses 9 (search, extract, responses, 3 task-run, 3 task-group). Unused families: images, places, decisions, chat completions, FindAll (10), monitors (8), server memory (3).

### 1.3 Modes, Processors & Execution Tiers Delta

| Surface | `pi-webtasks` | API / `parallel-tools` adds |
|---|---|---|
| Search `mode` | `turbo` \| `fast` \| `basic` (default) \| `advanced` | — (same set) |
| Image search `mode` | n/a | `fast` \| `advanced` |
| Place search `mode` | n/a | supported |
| Responses effort | `effort`: `low` \| `medium` (default) \| `high` | `reasoning.effort: "auto"`; `Response.effort_used` reports the chosen tier |
| Task processors | `core` (default), `core2x`, `pro`, `ultra`, `ultra2x`; bounds `TASK_FLOOR = "core"`, `TASK_CEILING = "ultra2x"` | `lite`, `base`, `ultra4x`, `ultra8x` |
| Task output spec | explicit `output_schema` or `output_description`; never `auto` | `task_spec` output `auto`, plus `task_spec.input_schema` |
| FindAll generators | n/a | `base` \| `core` \| `pro` \| `preview` |
| Entity search | n/a | sync `people` \| `companies`, 5..1000 results |
| Monitor processors | n/a | `lite` \| `base` \| `core`; type `event_stream` \| `snapshot`; cadence `1h..30d` |
| Chat model | n/a | `model` default `speed` |

### 1.4 Request Options, Beta Headers & Response Field Deltas

**`parallel-beta` headers** (`ParallelBeta` in `parallel-tools`): `mcp-server-2025-07-17`, `events-sse-2025-07-24`, `webhook-2025-08-12`, `findall-2025-09-15`, `search-extract-2025-10-10`, `field-basis-2025-11-25`. `pi-webtasks` relies on whatever `parallel-web@1.3.3` sends and sets none explicitly for the raw `/v1/responses` call.

**Search (`POST /v1/search`)**
- `pi-webtasks` sends: `objective` (required locally), `search_queries` (1-3), `mode`, `max_results` (1-20, default 10), `include_domains`/`exclude_domains`, `after_date`, `context` → `session_id`, internal `client_model`.
- Missing: `max_chars_total`; `advanced_settings.location`, `advanced_settings.fetch_policy`, `advanced_settings.excerpt_settings.max_chars_per_result`; `SourcePolicy` path prefixes (`docs.python.org/3`) and bare TLDs (`.gov`).
- Response fields ignored: `warnings`, `usage`.

**Extract (`POST /v1/extract`)**
- `pi-webtasks` sends: `urls` (1-20), `objective`, `search_queries` (1-3), `full_content` (bool), `max_age_seconds` (>=600) → `fetch_policy.max_age_seconds`, `context` → `session_id`, `client_model`.
- Missing: `max_chars_total`; `advanced_settings.links` (<=512); `full_content: { max_chars_per_result }`; `excerpt_settings`; `fetch_policy.timeout_seconds`, `fetch_policy.disable_cache_fallback`.
- Response fields ignored: `acquired_at`, `publish_date`, `links`, `warnings`, `usage`.

**Responses (`POST /v1/responses`)**
- `pi-webtasks` sends: `question`, `effort`, `instructions`, domain filters as `tools: [{ type: "web_search", filters: { allowed_domains, blocked_domains } }]`, `continue_from` → `previous_response_id`.
- Missing: `reasoning.effort: "auto"`, `text.format` (`json_schema`), `text.verbosity`, `stream` (SSE), `tools: [{ type: "mcp" }]` (<=10), `data_sources`, `metadata`.
- Response fields ignored: `effort_used`, `status`, `incomplete_details`, `web_search_call`, `moderation`.

**Tasks / Task Groups**
- `pi-webtasks` sends: processor, `output_schema`/`output_description`, `include_domains`/`exclude_domains`/`after_date`, `continue_from` → `previous_interaction_id`, `enable_events: true`, `metadata: { webtasks_ref }`.
- Missing: `task_spec.input_schema`, output `auto`, `advanced_settings.location`, `advanced_settings.data_sources`, `memory_scope_key`, `mcp_servers`, `webhook`, batch `addRuns` (1..1000).
- Response fields ignored: `TaskRun.warnings`, `FieldBasis.confidence`.

**Unused families — notable request shapes**
- Images: 1-5 queries, `objective`, `mode`, `location`, `max_results`, `session_id`; CLI/MCP adds `download_dir`/`download_limit`.
- Places: `query`, `location` or `latitude`/`longitude`, `max_distance_km` (0..200), `open_now`, `max_results`, `mode`, `session_id`; returns address, phone, rating, `price_level`, `opening_hours`, timezone, `open_now`.
- Decisions: 1-100 keyed questions of type `noul` (P(true) 0..1), `choice` (2..255 options), `score` (2..10 rubric); shared `state`, `after_date`, `location`, `include_excerpts`; shared `citations` and `usage` in the response.
- Chat completions (beta): `model`, `messages`, `stream`, `response_format`, `previous_interaction_id`.
- Monitors: `webhook`, `memory_scope_key`, trigger/update/cancel lifecycle, event listing, stats.
- Server memory: retrieve/evict/clear keyed by memory scope.

### 1.5 Async, Streaming, Storage & Auth Architecture Delta

| Concern | `pi-webtasks` | `parallel-tools` |
|---|---|---|
| Async tasks | Group-per-research; one run per `addRuns`; status via `taskRun.retrieve`, progress via `taskRun.events`, result via non-blocking `taskRun.result({ timeout: 0 })` (`src/task-run-lifecycle.ts`) | Direct `create_task_run` or group batch; group/run SSE streams |
| Streaming | No SSE consumption for `/v1/responses`; task events polled | `sse.rs` consumes the spec's SSE streams (`events-sse-2025-07-24`; group runs/events, responses `stream`) |
| Push delivery | none | `webhook` on tasks and monitors (`webhook-2025-08-12`) |
| Run recovery | `taskGroup.getRuns` recovers runs whose id was not bound locally (`metadata.webtasks_ref`) | n/a (stateless) |
| Local storage | SQLite via `node:sqlite` with FTS5 recall (`src/store.ts`, `src/recall.ts`) | none |
| Server memory | not used (local recall instead) | `memory_scope_key` + `/v1beta/memory/*` |
| Auth | OAuth PKCE browser sign-in or pasted API key stored in Pi `auth.json` under `parallel` (`src/provider.ts`, `src/parallel-oauth.ts`, `src/ops.ts`); fallback `_PARALLEL_API_KEY` → `PARALLEL_API_KEY` → `.env`/`parallel.env` (`src/env.ts`); sent as `Authorization: Bearer` | `x-api-key` header (`auth.rs`) |
| Cost accounting | hardcoded list prices in microdollars (`SEARCH_PRICE`, `ANSWER_PRICE`, `TASK_PRICE` in `src/status.ts`); ignores API `usage` SKUs and `effort_used` | no local price table; `usage` is part of the generated response types |

Main consequences for `pi-webtasks`:
1. The SDK pin (`parallel-web@1.3.3`) is behind the spec; four endpoints need raw calls or an SDK bump.
2. Cost reporting is estimated, not measured; the API's `usage` and `effort_used` fields would make it exact.
3. `warnings` are dropped on search, extract and task runs, so degraded results look the same as clean ones.
