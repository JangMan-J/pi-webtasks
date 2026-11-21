# Parallel API Comparative Advisory Report: parallel-tools vs. pi-webtasks

## Executive Summary

`pi-webtasks` uses 9 of the 39 Parallel API operations that `parallel-tools` wraps (search, extract, responses, 3 task-run and 3 task-group calls). That narrow surface is deliberate and correct for a Pi agent extension: five tools, a local SQLite evidence store, and cited receipts. The gaps that matter are not missing endpoints but dropped signals and drift:

- Provenance and quality signals are discarded: `warnings`, `usage`, `effort_used`, `Response.status`/`incomplete_details`, `field.confidence`, and the stored `citations.claim` reasoning that `web_recall` never reads.
- Input validation drifts from the API: `src/source-policy.ts` rejects Parallel's domain/path prefixes and lets `Date.parse` roll `2025-02-31` over; `web_answer` lacks `effort: "auto"`.
- Credential precedence differs between the two tools (see §1.5).
- Steering lacks an anti-stale-prior trigger and HTTP-status-mapped recovery hints.

Monitors, async FindAll, server memory, chat completions, webhooks, Responses SSE, batch task groups and extra processors stay in `parallel-tools` (CLI / deferred MCP). Section 5 gives the prioritized plan.

## 1. API & Feature Delta Inventory

### 1.1 Spec & SDK Baseline

| Aspect | `pi-webtasks` | `parallel-tools` |
|---|---|---|
| Package | `@jangmanj/pi-webtasks` v0.1.2 (`package.json`) | Rust workspace: `crates/parallel-openapi` (generated SDK), `crates/parallel-tools` |
| API contract | `parallel-web@1.3.3` TypeScript SDK (no OpenAPI file in repo) | `spec/parallel-openapi.normalized.json` (OpenAPI 3.1, Parallel API `0.1.2`), normalized by `scripts/normalize-spec.mjs` (`OPERATION_IDS`) |
| SDK gaps | `parallel-web@1.3.3` lacks `/v1/decisions`, `/v1/images/search`, `/v1/places/search`, `/v1/responses`; `web_answer` uses raw `parallel.post("/v1/responses")` | Generated client covers all 39 operations |
| Auth scheme | `parallel-web@1.3.3` SDK calls (`search`, `extract`, `taskGroup`, `taskRun`) send `x-api-key`; only the raw `parallel.post("/v1/responses")` call sends `Authorization: Bearer` (`src/answer-service.ts:178`) | `ApiKeyAuth` header `x-api-key` (`crates/parallel-tools/src/auth.rs`) |
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
| Async tasks | One Task Group per Pi session (`ensureGroup` in `src/task-service.ts`); one run per `addRuns`; status via `taskRun.retrieve`, progress via `taskRun.events`, result via non-blocking `taskRun.result({ timeout: 0 })` (`src/task-run-lifecycle.ts`) | Direct `create_task_run` or group batch; group/run SSE streams |
| Streaming | No SSE for `/v1/responses`; `src/task-service.ts` consumes `taskRun.events` as a continuous live SSE stream (`for await`, 3s–5m backoff) | `crates/parallel-tools/src/sse.rs` collects bounded SSE slices (`timeout_seconds`/`max_events`, `last_event_id`) for stateless CLI/MCP calls (`events-sse-2025-07-24`; group runs/events, responses `stream`) |
| Push delivery | none | `webhook` on tasks and monitors (`webhook-2025-08-12`) |
| Run recovery | `taskGroup.getRuns` recovers runs whose id was not bound locally (`metadata.webtasks_ref`) | n/a (stateless) |
| Local storage | SQLite via `node:sqlite` with FTS5 recall (`src/store.ts`, `src/recall.ts`) | none |
| Server memory | not used (local recall instead) | `memory_scope_key` + `/v1beta/memory/*` |
| Auth | OAuth PKCE browser sign-in or pasted API key stored in Pi `auth.json` under `parallel` (`src/provider.ts`, `src/parallel-oauth.ts`, `src/ops.ts`); fallback `_PARALLEL_API_KEY` → `PARALLEL_API_KEY` → `.env`/`parallel.env` (`src/env.ts`); SDK sends `x-api-key`, raw `/v1/responses` sends `Authorization: Bearer` | `x-api-key` header (`auth.rs`) |
| Cost accounting | hardcoded list prices in microdollars (`SEARCH_PRICE`, `ANSWER_PRICE`, `TASK_PRICE` in `src/status.ts`); ignores API `usage` SKUs and `effort_used` | no local price table; `usage` is part of the generated response types |

Main consequences for `pi-webtasks`:
1. The SDK pin (`parallel-web@1.3.3`) is behind the spec; four endpoints need raw calls or an SDK bump.
2. Cost reporting is estimated, not measured; the API's `usage` and `effort_used` fields would make it exact.
3. `warnings` are dropped on search, extract and task runs, so degraded results look the same as clean ones.

**Credential precedence divergence (live).** `pi-webtasks` (`src/ops.ts:resolveResearchKey`) resolves stored Pi `auth.json` → `_PARALLEL_API_KEY` → `PARALLEL_API_KEY` → `.env`/`parallel.env`. `parallel-tools` (`crates/parallel-tools/src/auth.rs:resolve_api_key`) resolves `--api-key` → `PARALLEL_API_KEY` → `_PARALLEL_API_KEY` → `~/.pi/agent/auth.json` → `~/.config/parallel-web-tools/auth.json`. The same machine can bill two different keys. Recommendation: unify precedence (§5.1).

## 2. Surface Recommendations (Add / Defer / Explicitly Keep Out)

This section classifies every Parallel capability that `parallel-tools` exposes
and `pi-webtasks` does not. The default answer is **no new tool**. `pi-webtasks`
is the always-on research floor; `parallel-tools` already serves the long tail as
a deferred MCP (`exposure: "deferred"`) and a CLI. A capability earns a place in
`pi-webtasks` only if it makes agents reach for fresh external evidence more
often or more reliably, without widening the tool-selection decision.

Verdict vocabulary:

- **Add (Internal)**: use it inside the extension; no new parameter or wording the agent must reason about.
- **Add (Existing Tool)**: one new optional parameter on an existing tool, added to its `closed(...)` allow list.
- **Add (Candidate Tool)**: a sixth tool, justified only by a gap the five tools cannot cover.
- **Defer**: plausible later; reachable today through `parallel-tools mcp` / CLI.
- **Keep Out**: conflicts with an invariant below; do not add even on request without revisiting that invariant.

### 2.1 Core pi-webtasks Design Constraints

| # | Constraint | Where it lives | Consequence for new surface |
| --- | --- | --- | --- |
| C1 | Five tools split by who writes the answer: agent (`web_search`, `web_fetch`), Parallel agent (`web_answer`, `web_research`), local store (`web_recall`). | `src/research-tools.ts`, `README.md` | A new tool must fit one side of that split, or it adds a selection question the split was built to remove. |
| C2 | Closed parameter sets per tool (`closed(name, allowed, params)`). | `src/research-tools.ts` | Every parameter is a reviewed decision; sub-features are opt-in, one at a time. |
| C3 | Recorded paid calls: intent recorded before the network call, `maxRetries: 0`, replay returns the stored run, 4xx -> `failed`, 5xx/408/timeout -> `uncertain`. | `src/paid-call.ts` | Any new endpoint needs a record/replay shape. Streams and batches complicate this. |
| C4 | Session-owned SQLite store; agents see handles (`ev_...`) and references (`run_...`), never SQL, provider ids, or file paths. | `src/store.ts`, `GLOSSARY.md` | Outputs that are files (images, downloads) or provider-side state (memory scopes, monitor ids) do not fit. |
| C5 | Bounded receipts (`RECEIPT_LIMIT = 4200`). | `src/receipt.ts` | Large outputs must land in the store and be read through `web_recall`. |
| C6 | Collection inside Pi only: no webhooks, no callback receiver, no artifact files. | `src/index.ts`, `src/task-service.ts`, `src/alert-delivery.ts` | Anything that delivers by webhook or runs while Pi is closed is out of shape. |
| C7 | Task processors bounded `core..ultra2x` (`TASK_FLOOR`, `TASK_CEILING`). | `src/task-service.ts` | `lite`/`base`/`ultra4x`/`ultra8x` stay out of the agent surface. |
| C8 | Wording describes Parallel's capability and the next step, not extension plumbing. | `tests/tool-wording.test.ts` | New knobs that require explaining internal policy to the agent cost more than they return. |

Goal under all of these: low cognitive overhead per call, and a strong pull
toward fresh, cited evidence instead of stale priors.

### 2.2 Surface Decision Matrix

| Feature / Endpoint | Verdict | Primary Rationale | Owner |
| --- | --- | --- | --- |
| Search `warnings` / `usage` | Add (Internal) | Store with the run; surface warnings in the receipt only when non-empty. No agent decision. | pi-webtasks |
| Search `max_chars_total` | Add (Internal) | Set by the extension to keep stored excerpts proportional to C5; not an agent knob. | pi-webtasks |
| Search `excerpt_settings` | Add (Internal) | Fixed sensible default; `mode` already expresses the agent's intent. | pi-webtasks |
| Search `fetch_policy` | Defer | `web_fetch.max_age_seconds` covers freshness for known URLs; search freshness has no reported failure. | parallel-tools |
| Search `location` | Add (Existing Tool) | One optional ISO-3166 alpha-2 country code on `web_search`. | pi-webtasks |
| `SourcePolicy` path prefixes + TLDs | Add (Internal / Bug Fix) | Fix on existing `include_domains`/`exclude_domains`: relax `BARE_DOMAIN` for path prefixes, document bare TLDs, drop `*`, explicit include+exclude conflict, fix `Date.parse` rollover. | pi-webtasks |
| Extract `warnings` / `usage` | Add (Internal) | Same as search. | pi-webtasks |
| Extract `acquired_at`, `publish_date` | Add (Internal) | Store as evidence metadata and show dates in `web_recall`; directly helps agents judge staleness. | pi-webtasks |
| Extract `links` (<=512 URLs) | Add (Existing Tool) | Optional `links: true` on `web_fetch`; links stored as evidence, not dumped into the receipt (C5). | pi-webtasks |
| Extract `max_chars_total`, `full_content.max_chars_per_result` | Add (Internal) | Bound by the extension; `full_content` stays a boolean for the agent. | pi-webtasks |
| Extract `fetch_policy.timeout_seconds`, `disable_cache_fallback` | Add (Internal) | Fixed policy that pairs with `max_age_seconds`; no agent knob. | pi-webtasks |
| Responses `reasoning.effort: "auto"` + `effort_used` | Add (Internal) | Record `effort_used`; consider `auto` as the default when `effort` is omitted. Keeps the `effort` parameter as is. | pi-webtasks |
| Responses `Response.status` / `incomplete_details` / `web_search_call` | Add (Internal) | Needed to tell a partial answer from a full one, and to store the searches behind it as evidence. | pi-webtasks |
| Responses `text.format` (`json_schema`) | Defer | Structured output already lives in `web_research.output_schema`; adding it to `web_answer` blurs the two tools. | parallel-tools |
| Responses `text.verbosity` | Defer | `instructions` covers it in prose. | parallel-tools |
| Responses `stream` (SSE) | Keep Out | Seconds-scale answer; streaming adds partial-record states to C3 for no agent benefit. | none |
| Responses `tools: [{type:"mcp"}]`, `data_sources`, `metadata` | Keep Out | Provider-side MCP and paid data sources move credentials and cost outside the recorded-call shape. `metadata` is internal-only if used. | none |
| Tasks `location` | Add (Existing Tool) | Same optional ISO code on `web_research`. | pi-webtasks |
| Tasks `input_schema` | Defer | `input` as text is enough; structured input matters for batches, which are out. | parallel-tools |
| Tasks `output_schema: auto` | Keep Out | README contract: the extension never relies on the provider's `auto` default. | none |
| Tasks `lite` / `base` / `ultra4x` / `ultra8x` | Keep Out | C7. `lite`/`base` produce thin research; `ultra4x/8x` cost beyond what an agent should choose alone. | parallel-tools |
| Tasks `add_task_group_runs` batch (1..1000) | Keep Out | Bulk enrichment is a pipeline job, not a session research step; breaks per-run alerts and C5. | parallel-tools |
| Tasks `webhook` | Keep Out | C6. | none |
| Tasks `mcp_servers`, `data_sources` | Keep Out | Same as Responses. | none |
| Tasks `memory_scope_key` | Keep Out | Provider-side memory competes with the local store (C4). | none |
| Grounded Decisions `POST /v1/decisions` | Defer | See 2.3; strongest candidate, but overlaps `web_answer` today. | parallel-tools |
| Image Search `POST /v1/images/search` | Defer | Text agents rarely need it; `download_dir` is an artifact file (C4/C6). | parallel-tools |
| Place Search `POST /v1/places/search` | Defer | Narrow domain; no session need observed. | parallel-tools |
| Fast Entity Search `POST /v1beta/findall/entity-search` | Defer | Beta; list-of-entities fits `web_research` with an `output_schema` for now. | parallel-tools |
| FindAll async (9 endpoints) | Keep Out | Dataset-building lifecycle (ingest/extend/enrich/cancel) is a product of its own; far past the five-tool shape. | parallel-tools |
| Scheduled Web Monitors (8 endpoints) | Keep Out | Recurring billing and delivery while Pi is closed (C6). | parallel-tools |
| Server Memory (3 endpoints) | Keep Out | C4: the session store is the memory. | parallel-tools |
| Chat Completions Beta `POST /v1beta/chat/completions` | Keep Out | Duplicates `web_answer` with a weaker, beta contract. | parallel-tools |
| Webhooks (any family) | Keep Out | C6. | none |
| Provider-side Remote MCP (`mcp_servers`) | Keep Out | Credentials and tool calls outside the recorded path. | none |
| Pay-per-use `data_sources` | Keep Out | Unbounded cost surface not covered by processor bounds. | none |

### 2.3 Detailed Judgements: Add vs. Defer vs. Explicitly Keep Out

**Add (Internal), do first.** `acquired_at`/`publish_date`, `warnings`, `usage`,
`effort_used`, `Response.status`/`incomplete_details`, and `web_search_call`
cost no agent attention and make stored evidence more honest about its age and
completeness. That serves the core goal directly: an agent that sees
"published 2021, fetched today" is less likely to treat a stale page as current.
Each is a store column or a receipt line, recorded through the existing paid-call
path. `max_chars_total` and fetch timeouts are extension policy; they keep
receipts within C5 and must not appear in tool wording (C8).

**Add (Existing Tool): `location` and `links`.** An optional ISO-3166 alpha-2
`location` on `web_search`/`web_research`, and optional `links: true` on
`web_fetch` with links stored as evidence rather than in the receipt. Each is
one optional field in the `closed(...)` list, not a policy object.

**Add (Candidate Tool): none now.** No capability below fills a gap the five
tools leave open in normal research work.

**`POST /v1/decisions` (Grounded Decisions): Defer, keep in `parallel-tools mcp`.**
The case for adding it:

- It is the most direct tool against stale priors: hand over 1-100 claims, get
  back a cited P(true) per claim (`noul`), a `choice`, or a `score` against a
  shared rubric (`state`). `after_date` pins freshness, `mode: fast` is
  synchronous, and the output is small and structured, which fits C3 and C5
  better than any other unwrapped family.
- Batch checking of an agent's own assumptions ("is X still true as of date D")
  is something `web_answer` does one question at a time, at higher cost per claim.

The case against, which wins for now:

- It sits on the "Parallel agent writes the answer" side of C1 next to
  `web_answer`. A sixth tool there forces a choice on every factual question:
  "ask" or "decide". `web_answer` already returns a cited answer, and a list of
  yes/no claims fits in one `question`. The added selection step is a permanent
  cost; the gain is per-claim calibration that agents rarely use.
- Agents that do not doubt a prior will not call a verification tool either.
  Defeating stale priors comes from guidelines that push the first move to
  `web_search`/`web_answer`, not from another tool name.
- A batch of 100 judgements needs a stored shape (one run, many verdicts, each
  with citations) that does not exist yet in the store or in `web_recall`.

Revisit trigger: if session logs show agents issuing several `web_answer` calls
in a row that are each a true/false check, add Decisions as **an internal path or
a mode of `web_answer`** (e.g. a `claims: string[]` parameter that returns
per-claim verdicts), not as a sixth tool. Until then, `parallel-tools mcp`
exposes it on demand.

**Defer group (Image, Place, Entity Search, search/extract fine controls,
`text.format`, `verbosity`, `input_schema`).** Each is valid Parallel surface
with no observed session demand. All are reachable through the deferred MCP, so
deferring costs nothing in capability.

**Keep Out group.** These break an invariant rather than merely lacking demand:

- Webhooks, Monitors, and anything that runs or delivers while Pi is closed (C6).
- Server Memory and `memory_scope_key` (C4: one store, owned by the session).
- Remote MCP, `data_sources`, `ultra4x`/`ultra8x`, batch task groups, FindAll:
  cost or credentials outside the bounded, recorded path (C3, C7).
- `output_schema: auto` (explicit output contract), Responses `stream` (no agent
  benefit, harder records), Chat Completions Beta (duplicate of `web_answer`).

### 2.4 Coexistence Boundary: pi-webtasks vs. parallel-tools

| | pi-webtasks | parallel-tools |
| --- | --- | --- |
| Role | Always-on curated research floor | Specialist surface for everything else |
| Exposure | Five Pi tools, loaded in every session | CLI plus Codemode MCP, `exposure: "deferred"` in `~/.pi/agent/mcp.json` |
| Coverage | Search, Extract, Responses, Tasks (bounded) | 39 operations across all families (`crates/parallel-tools/src/catalog.rs`) |
| State | Session SQLite store, handles, alerts | Stateless per call; files where the CLI writes them (e.g. `download_dir`) |
| Delivery | In Pi only | Whatever the caller wires up, including webhooks |

Rules for the boundary:

1. `pi-webtasks` never wraps a family just because `parallel-tools` has it. The
   deferred MCP costs no context until an agent asks for it; a direct tool costs
   context in every session.
2. When an agent needs a Keep Out or Defer feature, the answer is
   `parallel-tools`, not a new parameter here.
3. Promotion path: Defer -> observed repeated use through `parallel-tools` ->
   Add (Internal) or Add (Existing Tool) first -> Candidate Tool only if C1 has
   room.
4. Credential precedence currently diverges (see §1.5) and must be unified:
   `src/ops.ts` and `crates/parallel-tools/src/auth.rs` should resolve the
   Parallel key in the same order, so one `/login` serves both and an agent never sees one tool
   authenticated and the other not. Any change to the order in one is a change
   to both.

## 3. Parameter, Default & Mapping Review

Scope: every `pi-webtasks` tool schema (`src/research-tools.ts`) and its wire mapping, cross-checked against Parallel OpenAPI `0.1.2` as modelled in `parallel-tools` (`crates/parallel-openapi/src/models/*`). Line numbers refer to this worktree.

### Summary classification

| # | Finding | Location | Class |
|---|---|---|---|
| F1 | `BARE_DOMAIN` regex rejects path prefixes (`docs.python.org/3`) that `SourcePolicy` accepts; schema text says "bare domains" only | `src/source-policy.ts:27,30-35`; `src/research-tools.ts:61-69` | Bug/Drift |
| F2 | Bare extensions (`.gov`, `.co.uk`) pass the regex but are undocumented in tool descriptions | `src/research-tools.ts:65,67` | High-Leverage Surface Addition (doc only) |
| F3 | include+exclude both sent; API ignores `exclude_domains` when `include_domains` is non-empty; no warning | `src/source-policy.ts:53-59`; `src/research-service.ts:212` | Wire Internally as Smart Default |
| F4 | `web_answer` sends `allowed_domains` AND `blocked_domains` together, against `ResponseWebSearchToolFilters` "one or the other" | `src/answer-service.ts:174-176` | Bug/Drift |
| F5 | Auth precedence order differs from `parallel-tools` (`_PARALLEL_API_KEY` before `PARALLEL_API_KEY` here; reverse there; no shared `auth.json` lookup) | `src/ops.ts:23-36` | Bug/Drift (cross-tool) |
| F6 | Spend estimate from hard-coded list prices; API `usage: UsageItem[]` ignored | `src/status.ts:28-33,45-72` | Wire Internally as Smart Default |
| F7 | `mode` default `basic` vs API default `advanced`, always sent explicitly | `src/research-service.ts:13-14,185,197` | Keep Friction (Intentional Guardrail) |
| F8 | `objective` required in `web_search` though optional on API | `src/research-tools.ts:112` | Keep Friction |
| F9 | `search_queries` capped at 3 (API: 1+) | `src/research-tools.ts:116-117` | Keep Friction |
| F10 | `max_chars_total` / `excerpt_settings.max_chars_per_result` not exposed on search or fetch | `src/research-service.ts:204-214,262-281` | Wire Internally as Smart Default |
| F11 | `advanced_settings.location` (search, task) not exposed | `src/research-tools.ts:111-126,161-178` | High-Leverage Surface Addition |
| F12 | Search/extract `warnings` dropped from receipts | `src/research-service.ts:230-245,290-330` | Bug/Drift |
| F13 | Extract `links` (≤512 outgoing URLs) not exposed | `src/research-tools.ts:138-146` | High-Leverage Surface Addition |
| F14 | Extract `publish_date`/`acquired_at` not surfaced in fetch receipt | `src/research-service.ts:375-` (`formatFetchReceipt`) | Wire Internally as Smart Default |
| F15 | `fetch_policy.timeout_seconds` / `disable_cache_fallback` not exposed; only `max_age_seconds` | `src/research-service.ts:272` | Keep Friction |
| F16 | `full_content` bool only; `{max_chars_per_result}` form unused | `src/research-service.ts:273` | Wire Internally as Smart Default |
| F17 | `reasoning.effort` enum lacks `auto`; `effort_used` never read | `src/answer-service.ts:30,39,154-155` | High-Leverage Surface Addition |
| F18 | `text.verbosity` / `text.format: json_schema` not exposed on `web_answer` | `src/research-tools.ts:194-201`; `src/answer-service.ts:168-177` | Defer (`format`, revisit per §5.3); Keep Friction (`verbosity`) |
| F19 | `src/answer-service.ts:183-201` never checks `response.status` (`failed`/`incomplete`/`cancelled`), `response.error`, or `response.incomplete_details`; partial answers look complete | `src/answer-service.ts:183-201` | Bug/Drift |
| F20 | `parallel-web@1.3.3` `task-run.ts`/`task-group.ts` send `parallel-beta` only when `betas` is passed; `src/task-service.ts` never passes `betas`, so `field-basis-2025-11-25` / `events-sse-2025-07-24` are never sent | `src/task-service.ts:224,288,374` | Bug/Drift |
| F21 | `FieldBasis.confidence` and `reasoning` dropped when building evidence; tool description promises them | `src/task-run-lifecycle.ts:297-375`; `src/research-tools.ts:156,171` | Bug/Drift |
| F22 | `TaskRun.warnings` not surfaced | `src/task-run-lifecycle.ts` | Bug/Drift |
| F23 | `advanced_settings.data_sources` not exposed | `src/research-tools.ts:161-178` | Keep Friction |
| F24 | `processor` default `core`; `auto` deliberately avoided | `src/task-service.ts:11,163,191` | Keep Friction |
| F25 | `store.citations()` defined, no callers | `src/store.ts:1140` | Bug/Drift (dead code or missing recall surface) |
| F26 | Tool descriptions say handles/references work "from this or an earlier session"; README says evidence is per-session and foreign handles behave as missing | `src/research-tools.ts:176,199,214,216`; `README.md:84-85,193` | Bug/Drift |
| F27 | Recall `max_chars` silently clamped rather than rejected | `src/recall.ts:48-50,136` | Keep Friction |

### 3.1 Shared Source Policy & Credential/Pricing Mappings

`src/source-policy.ts`
- `MAX_DOMAINS = 200` (L26) and combined check (L42-44) match `SourcePolicy` max 200 combined. OK.
- `BARE_DOMAIN = /^[a-z0-9.*-]+$/i` (L27) used by `domains()` (L30-35): rejects `/`, so the API's domain/path prefix form (`docs.python.org/3`, `youtube.com/shorts`) is unreachable → **F1**. Fix: allow `[a-z0-9.*-]+(/[^\s?#]*)?`, keep the "not a URL" error for `http(s)://`.
- Regex allows `*`; API matches subdomains automatically without `*`. Wildcards are harmless-to-misleading; strip or reject `*` with a hint. (part of F1)
- `.gov` passes the regex; no description mentions extensions → **F2**.
- `providerSourcePolicy()` (L53-59) emits both lists when both are set. API silently ignores `exclude_domains` when `include_domains` is non-empty → **F3**: drop `exclude` (or reject the combination) when `include` is non-empty, and say so in the receipt.
- `after_date` validated against `CALENDAR_DATE` (L28) then `Date.parse(afterDate)` (`src/source-policy.ts:47`), which rolls `2025-02-31` over to March 3 instead of rejecting it, unlike `parseCalendarDate` in `src/recall.ts:70-80`. Minor drift.

`src/research-tools.ts` `domainFilters()` (L60-69): `minItems:1, maxItems:200` per list, but the 200 limit is combined; schema allows 400 that the service then rejects. Acceptable (service rejects), noted.

`src/ops.ts`
- `researchKey()` (L23-36): `stored login → _PARALLEL_API_KEY → PARALLEL_API_KEY → .env/parallel.env`.
- `parallel-tools/crates/parallel-tools/src/auth.rs`: `--api-key → PARALLEL_API_KEY → _PARALLEL_API_KEY → ~/.pi/agent/auth.json → ~/.config/parallel-web-tools/auth.json`.
- With both env vars set to different keys the two tools bill different accounts → **F5**. Pick one order (recommend: explicit/stored → `PARALLEL_API_KEY` → `_PARALLEL_API_KEY` → files) and document it in both repos.
- Client: `timeout: 120_000, maxRetries: 0` (L50). Intentional (no blind replays of paid calls). Keep.

`src/status.ts`
- `SEARCH_PRICE`, `EXTRA_RESULT_PRICE`, `EXTRACT_PRICE_PER_URL`, `ANSWER_PRICE`, `TASK_PRICE` (L28-33) hard-code list prices; `totals()` (L45-72) computes spend from intent (`mode ?? "basic"`, `effort ?? "medium"`, `processor ?? "core"`).
- Search and extract responses return `usage: UsageItem[]`; storing it on the run and preferring it over list prices removes price drift → **F6**. Keep list prices as fallback; keep `unpriced` (`+?`) marker.
- `ANSWER_PRICE` has no `auto` key; if F17 lands, `auto` must price from `effort_used`, else it shows `+?`.

### 3.2 web_search (POST /v1/search)

Schema `src/research-tools.ts:111-126`; service `src/research-service.ts:180-250`.

| Param | pi-webtasks | API `V1SearchRequest` | Verdict |
|---|---|---|---|
| `objective` | required (L112) | optional | F8 Keep: forces focused excerpts |
| `search_queries` | 1-3, minLength 1 (L116-117) | 1+ | F9 Keep: bounds cost/noise |
| `mode` | `SEARCH_MODES`, default `basic`, always sent (L120; svc L185,197; `parseSearchMode` L76-80) | `turbo/fast/basic/advanced`, default `advanced` | F7 Keep |
| `max_results` | 1-20, default 10 (L121; svc L188-189) → `advanced_settings.max_results` (L211) | `advanced_settings.max_results` | OK; `status.ts` charges extra results >10 consistently |
| `include/exclude_domains`, `after_date` | → `advanced_settings.source_policy` (L212) | `source_policy` | F1/F3 apply |
| `context` | local only, stored in intent (L203) | — | OK |
| `client_model`, `session_id` | sent when known (L208-209) | supported | OK |
| `max_chars_total`, `excerpt_settings.max_chars_per_result` | not sent | supported | F10: set internally by `mode` (e.g. basic ≈ default, advanced larger) rather than exposing |
| `location` | absent | `advanced_settings.location` | F11: high-leverage for local/regional queries; one optional ISO country string |
| `fetch_policy` | absent on search | supported | Keep absent (fetch handles freshness) |

Response: `warnings` not read anywhere in `research-service.ts` (no matches) → **F12**; append a one-line `Provider warnings:` to `formatSearchReceipt` (L340-370). `usage` → F6.

### 3.3 web_fetch (POST /v1/extract)

Schema `src/research-tools.ts:138-146`; service `src/research-service.ts:252-335`.

| Param | pi-webtasks | API `V1ExtractRequest` | Verdict |
|---|---|---|---|
| `urls` | 1-20, minLength 1 (L139) | 1..20 | OK; `httpUrl()` (`src/research-service.ts:90-96`) validates `http:`/`https:` client-side |
| `objective`, `search_queries` | optional, 1-3 (L140-141) | `objective`, `search_queries` | OK |
| `full_content` | bool, sent only when true (svc L260,273) | `bool \| {max_chars_per_result}` | F16: when true, set `{max_chars_per_result}` internally to bound store growth |
| `max_age_seconds` | int ≥600 (L143; svc L257-258) → `fetch_policy.max_age_seconds` (L272) | ≥600 | OK |
| `timeout_seconds`, `disable_cache_fallback` | absent | `fetch_policy.*` | F15 Keep: rare need; defaults are sane |
| `excerpt_settings`, `max_chars_total` | absent | supported | F10 internal default |
| `links` | absent | bool, ≤512 URLs | F13: high leverage for crawl-style follow-ups ("fetch then follow docs links"); store as a separate evidence item, not in the receipt |
| `client_model`, `session_id` | sent (L279) | supported | OK |

Result: `sourceBody()` (L105-110) prefers `full_content` then excerpts. `publish_date` and `acquired_at` exist on `V1ExtractResult` but the fetch receipt type (L375) carries neither → **F14** (cheap provenance; `publish_date` already shown for search). `warnings` dropped → F12. Evidence kind switches `source`/`excerpt` on `full_content` (L144) — OK.

### 3.4 web_answer (POST /v1/responses)

Schema `src/research-tools.ts:194-201`; service `src/answer-service.ts:150-240`.

| Param | pi-webtasks | API `ResponseCreateRequest` | Verdict |
|---|---|---|---|
| `question` | required → `input` (L170) | `input` | OK |
| `effort` | `low/medium/high`, default `DEFAULT_ANSWER_EFFORT` (L30,39,154-155) → `reasoning.effort` (L171) | adds `auto` (picks low/medium; reported in `effort_used`) | F17: add `auto` as an option (or default) and record `effort_used` for pricing/receipt |
| `instructions` | optional (L173) | `instructions` | OK |
| `include/exclude_domains` | → `tools[0].filters.{allowed_domains, blocked_domains}` both set (L174-176) | set one, not both | **F4**: send only `allowed_domains` when include is non-empty, else only `blocked_domains` |
| `after_date` | not on `web_answer` schema | no response-side date filter | OK (consistent) |
| `continue_from` | → `previous_response_id` (L172) | supported | OK; see F26 for cross-session wording |
| `text.format` | absent | `json_schema` | F18 Defer: `web_research.output_schema` covers structure; revisit per §5.3 |
| `text.verbosity` | absent | `low/medium/high` | F18 Keep: `instructions` covers length |
| `model` | fixed `"parallel"` (L169) | — | Keep |

Response handling (`src/answer-service.ts:183-201`) never checks `status` ∈ `failed/incomplete/cancelled`, `error`, or `incomplete_details`, so a partial answer is presented as complete → **F19**. Citations: `url_citation` annotations on the `message` output are the evidence source; `web_search_call` items carry queries — storing them would aid recall but is optional.

### 3.5 web_research (POST /v1/tasks/groups/{id}/runs & /v1/tasks/runs/*)

Schema `src/research-tools.ts:161-178`; submit `src/task-service.ts:185-263`; lifecycle `src/task-run-lifecycle.ts`.

| Param | pi-webtasks | API `TaskRunInput` | Verdict |
|---|---|---|---|
| `input` | non-empty string or flat object (L162-165; svc L187-189) | `input` | OK |
| `processor` | `TASK_PROCESSORS`, default `core`, `validateProcessor` (svc L41-45,191) | includes `auto`/`lite`/`base` etc. | F24 Keep: explicit cost floor, no `auto` |
| `output_schema` / `output_description` | one required → `task_spec` via `taskSpec()` (L163) | `task_spec.output_schema` | OK; sent as both run `task_spec` and group `default_task_spec` (L224) — redundant but harmless |
| domains, `after_date` | → `source_policy` (L194,222) | `source_policy` | F1/F3 apply |
| `continue_from` | → `previous_interaction_id` (L192,223) | supported | OK; F26 |
| `enable_events: true`, `metadata.webtasks_ref` | always (L219-221) | supported | OK — reference reconciliation relies on it |
| `location`, `data_sources` | absent | `advanced_settings.*` | F11 (location) add; F23 Keep (data_sources) |

Wire: group create `taskGroup.create({}, {maxRetries:0})` (L149); `addRuns` (L224); `taskRun.retrieve` (L255,414); `taskRun.result(runId, {timeout:0}, {timeout:60_000})` (L288); `taskRun.events` (L374); `taskGroup.getRuns(..., {include_input:true})` (L433). None pass `betas`/headers explicitly. `parallel-tools` sends `parallel-beta: field-basis-2025-11-25` on create/result and `events-sse-2025-07-24` on SSE → **F20**: verify the SDK version in `package.json` sends them; otherwise `basis` and SSE progress may be absent or shaped differently. None of these calls pass `betas`, so no `parallel-beta` header is sent (→ **F20**).

Result mapping `outputEvidence` (`src/task-run-lifecycle.ts:298-383`): reads `basis[].field` and `basis[].citations[]` (L305-318, L366-375) only. `field.reasoning` IS stored into `citations.claim` (L336, L376) but goes unread because `src/recall.ts` never calls `store.citations()` (`src/store.ts:1140`); `field.confidence` is dropped entirely, while the tool description (`research-tools.ts:156,171`) promises "per-field citations, reasoning, and confidence" → **F21**. Fix: append `confidence`/`reasoning` to each `structured` field body or a sibling column. `TaskRun.warnings` unread → **F22**.

Progress interval: `intervals` from processor latency guidance (L43-66, floor 5 000 ms, overridable via JSON) — Keep.

### 3.6 web_recall (Local SQLite Evidence Store)

Schema `src/research-tools.ts:213-226`; service `src/recall.ts`; store `src/store.ts`.

| Param | Constraint | Verdict |
|---|---|---|
| `handle` / `query` / `reference` | minLength 1; one mode per call | OK |
| `kinds` | `EVIDENCE_KIND_NAMES` = report, structured, finding, source, excerpt (`store.ts:84`) | OK; `web_answer` stores its body under `kind: "report"` (`src/answer-service.ts:99`); descriptions saying "answers" (L211) should say so |
| `within` / `since` / `until` | shorthand or ISO | OK |
| `limit` | 1-20, default 8 | OK |
| `cursor` | "pass alone" | OK |
| `offset` / `max_chars` | ≥0; 500-8000 default 4000, `clamp()` (`recall.ts:48-50,136`) | F27 Keep (schema already rejects out-of-range; clamp is a backstop) |

- `store.citations(sessionId, evidenceHandle)` (`src/store.ts:1140`) is never called by `src/recall.ts`; `field.reasoning` IS stored in `citations.claim` by `outputEvidence` (`src/task-run-lifecycle.ts:336,376`) but is unreachable from `web_recall` → **F25**. Surface "cited sources" when reading a `structured`/`report` handle.
- `field.confidence` (F21) is dropped entirely, so recall cannot show it.
- Cross-session drift → **F26**: `research-tools.ts` describes `handle`, `reference` (L214,216) and `continue_from` (L176,199) as valid "from this or an earlier session"; `README.md:84-85` says "Evidence belongs to one Pi session. A handle from another session behaves exactly like a missing one", and `README.md:193` lists cross-session visibility as an open decision. Align one way: either update README to the shipped behaviour or narrow the descriptions; verify against `store.ts` session filtering before choosing.
- Store path `WEBTASKS_DIR` else `<agent-dir>/webtasks`, dir mode `0o700` (`store.ts:512`), WAL (L398). OK.

### Priority order

1. Bugs that change provider behaviour: F4, F1, F3, F21, F20.
2. Drift visible to users: F26, F12/F22, F25, F5.
3. Leverage additions: F17, F13, F11.
4. Internal defaults: F6, F10, F14, F16. Deferred: F18 (`json_schema`, see §5.3).


## 4. Agent-Facing Design & Steering Critique

Scope: how well `pi-webtasks` keeps an agent from (a) answering from stale training priors and (b) picking the wrong web tool or looping on retries. Line numbers refer to this worktree.

Verdict: routing *between* the five tools is well engineered and tested. Nothing tells the agent *when to start* using them. Evidence plumbing also promises more than it delivers to the model: per-field confidence, citation URLs, and fetch dates are stored or available but never shown.

### 4.1 Prompt & Guidance Hooks: Missing Anti-Stale-Prior Trigger

- The only steering text in `<rules>` is two guidelines:
  - `src/research-tools.ts:108-110` (web_search): *"Choose the web tool by who writes the answer—check web_recall first before repeating a lookup. When you or the user will read pages… web_answer for a cited answer in seconds (effort high for comparisons); web_research for a cited report…"*
  - `src/research-tools.ts:158-160` (web_research): *"Submit web_research once early and keep working…"*
- `tests/tool-wording.test.ts:46-51` holds this at exactly 2 guidelines and `<= 800` chars (*"only cross-tool routing and background scheduling belong in <rules>"*). The budget is sound. Its content is the problem: both rules assume the agent has already decided to go to the web.
- No trigger exists anywhere for "your knowledge may be stale". `src/index.ts` registers only `session_start` (l.94) and `session_shutdown` (l.168); there is no `before_agent_start` system-prompt addition, and no guideline mentions versions, release dates, current APIs, prices, or "today".
- Failure mode: the agent writes `npm i foo@3` or quotes a deprecated API signature from memory with full confidence. The tools are never called, so their routing quality is irrelevant. This is the largest steering gap in the package.
- `promptSnippet`s (`:107`, `:137`, `:157`, `:193`, `:212`) describe what each tool returns, never when to use it ("Search the web for pages to read yourself: ranked URLs with excerpts"). Snippets are the one per-tool line Pi always lists, so they are a cheap place to add the "when".
- Smaller point: the routing rule begins with "check web_recall first". That is correct for repeats, but it uses up the opening words of the only rule on the rarer case.

### 4.2 Tool Descriptions & Selection Boundaries

| Boundary | Wording | Assessment |
|---|---|---|
| search vs fetch | search: "read them before calling web_fetch" (`:106`); fetch: "Read URLs you already have" (`:137`) | Clear. Good. |
| search vs answer | rule: "delegate instead of chaining searches (no failed search needed first)" | Good: it explicitly blocks the search→search→search loop. |
| answer vs research | answer "in seconds" (`:192`); research "typically 5-15 min" (`:156`) | Latency anchor is wrong for the default (below). |
| research vs recall | "interim findings are readable via web_recall { reference }" (`:156`) | Good. |

- **Latency anchor.** `web_research` says *"typically 5-15 min"* (`:156`), but the default processor is `core` (`:167`, *"core (the default) for focused cross-checking up to ~10 fields"*), which usually finishes in about 1-5 min. Overstating the wait pushes the agent toward `web_answer` effort `high` for jobs that need structured fields. It also makes `core` look slow next to `effort` `high`.
- **Effort vs processor overlap.** `web_answer.effort` (`low|medium|high` currently in `src/answer-service.ts:39`; `auto` is in OpenAPI `0.1.2` and not yet wired; the test pins *"medium (~15-20 s)… (the default)"*, `tool-wording.test.ts:37`) and `web_research.processor` (`core|core2x|pro|ultra…`) are two depth dials with no shared vocabulary. The routing rule's only hint is "effort high for comparisons", so "compare 4 libraries" fits both tools. A sharper cut: *more than ~3 entities, or wanting fields/table → web_research core*.
- **output_schema vs output_description** (`:171`, `:173`). "Give this or output_schema" is stated on both, but the either/or is not enforced in the schema. The `output_schema` description is long (≈330 chars), and an agent wanting "a table" has to pick between hand-writing JSON Schema and prose. Add one decision line: *"a table/fields you will consume programmatically → output_schema; a narrative → output_description"*.
- **Recall scope drift.** The tool description (`:211`) says: *"within this session by default, by handle/reference across sessions, or across sessions over a time range via within/since/until"*. `continue_from` (`:176`, `:199`) also says "from this or an earlier session". But `README.md:84-85` says: *"Evidence belongs to one Pi session. A handle from another session behaves exactly like a missing one, so nothing leaks across sessions."*, and `README.md:193` lists cross-session visibility as "still open". One of the two is wrong. An agent (or a human reading the README) cannot tell whether a handle remembered from yesterday is worth trying, and either answer leads to wasted calls.

### 4.3 Evidence, Citations & Recall Flow

- **Broken promise on web_research.** `:156` promises *"structured fields with per-field citations, reasoning, and confidence"*, and `:171` says *"Citations, reasoning, and confidence are returned per field automatically—do not add fields for them."* Actual behaviour:
  - `src/task-run-lifecycle.ts:336,376` keeps only `field.reasoning` (as the citation `claim`). `field.confidence` is never read (grep for `confidence` in that file: no hits).
  - `src/store.ts:1140` defines `citations(sessionId, evidenceHandle)`, but `src/recall.ts` never calls it (no `citations(` hit). The citation rows are written (`store.ts:1102-1106`) and cannot be read back.
  - Net effect: the agent was told not to request confidence, and it then never receives it. That is worse than not promising it. The agent cannot say "low confidence on release_date" and either over-trusts the result or re-asks.
- **web_answer receipt hides sources.** `src/answer-service.ts:222`: *"Citations: ${citations.length} source link(s). Full answer: ${reference}."* There are no URLs inline, so getting them costs a second call (`:223`, "list cited sources with web_recall { reference }"). The count comes from `citations.length`, i.e. annotation occurrences (`evidenceFromAnswer`, `:97-131`, pushes one per annotation), not unique URLs. "12 source link(s)" may be 3 sites. The URLs are already in memory at that point, and listing the top 3-5 unique hosts costs about 200 chars of the 4200 budget.
- **web_fetch drops freshness.** The search receipt prints `, published ${source.publish_date}` (`research-service.ts:360`). The fetch receipt (`formatFetchReceipt`, `:372-393`) types `fetched` without `publish_date` and shows title, URL, and char count only. There is no `acquired_at` either, so with `max_age_seconds` (`:143`) the agent cannot see whether it read a cached copy. For "is this doc current?" the date is the deciding fact, and fetch is the tool used to answer exactly that.
- **Recall discovery.** `web_recall` has only optional params (`:214-224`). An empty `web_recall {}` throws `"Pass handle to read one item, query/reference/within/since/until to search stored evidence, or cursor to continue a search"` (`src/recall.ts:126`). The footer hints (`recall.ts:247`, `research-service.ts:394`) are good breadcrumbs, but nothing in the snippet says "call with no args to list what you have", which is the natural first move after a context compaction.

### 4.4 Error, Validation & Recovery Hints

What pi-webtasks does better than a generic API wrapper:
- **No auto-retry on paid calls:** `paid-call.ts:164` sends `maxRetries: 0`, and the record is settled before the throw.
- **Explicit uncertain vs failed:** `outcomeUnknown` (`paid-call.ts:111-114`) classes 4xx as a definite rejection and 5xx/408/no-status as unknown. The error text then branches (`:173`). `web_answer` overrides it with *"Its outcome is unknown (record ${reference}); ask again only if you still need the answer."* (`answer-service.ts:184`). This blocks the classic double-charge loop; `parallel-tools` is stateless and has no equivalent.
- **Closed parameters:** `closed()` (`research-tools.ts:89-92`) rejects typos instead of silently ignoring them, and its comment states why.
- **validateQueries** (`research-service.ts:83-88`) errors are actionable: *"search_queries takes at most 3 focused queries; merge the rest"*.

Where it is weaker:
- **No status-specific hints.** A definite failure ends with only *"Record ${reference}."* (`paid-call.ts:173`) after `failureMessage` (up to 500 chars of provider body). `crates/parallel-tools/src/auth.rs:format_api_error` maps 401→re-auth, 402→credits, 404→bad id, 408→timeout, 409→conflict, 422→fix params, 429→back off, 5xx→provider issue. Here a 401 or 402 reads like any other failure, so the agent's natural move is to rephrase and retry, which is a loop that cannot succeed. A 429 gives no wait guidance.
- **`closed()` message is terse:** *"web_answer does not accept foo"* does not list the accepted names, although `allowed` is right there.
- **action_required alert** (`task-run-lifecycle.ts:149`): *"Run ${reference} is halted at Parallel with status action_required…"* It gives no next step (who acts? the user? can the agent cancel or continue?). The agent can only keep polling recall.
- **Fetch per-URL failures** (`research-service.ts:391`) print `error_type (HTTP n)` with no hint (403/paywall → try another source; 404 → search again).

### 4.5 Output Formatting, Context Economy & Untrusted-Text Framing

- `RECEIPT_LIMIT = 4200` (`receipt.ts:9`) with `bounded()` (`:30`) keeping the footer and adding an omission line ("read them with web_recall", `:75`). This is good: truncation is always visible and comes with a recovery action. web_answer reads `RECEIPT_LIMIT - 800` of the stored answer (`answer-service.ts:208`), which leaves room for footers.
- `EXCERPT_PREVIEW = 220` (`research-service.ts:61`), cut on sentence boundaries with a 40-char floor (`:335-337`). That is fine for triage, and the full excerpt is one handle read away.
- `UNTRUSTED` (`receipt.ts:12`) is always placed **last** in the receipt. After 4 KB of retrieved text, the framing arrives after the content it frames. Its tool-description copies (`:106`, `:136`, `:211`) partly compensate. Putting a short prefix line before the first excerpt would be stronger against injection.
- Progress alerts (`tick`, `task-run-lifecycle.ts:232-259`): headline *"Research still running (core): N source(s) considered"* plus a 220-char latest finding plus a recall pointer. They are dense and useful, and dedup per interval prevents spam. `completionBody` (`:287-295`) reports counts only: no field names, no top sources. The agent must call recall to learn whether the run answered anything at all.
- web_recall snippets use the same `bounded()` / `OMITTED` mechanics (`recall.ts:252`), with the paging hint in the footer. These are consistent.

### 4.6 Concrete Before/After Wording & Design Changes

**promptGuidelines** (keeps 2 rules, both name their tool, ≈700 chars total, satisfies `tool-wording.test.ts`):

```ts
// web_search, rule 1 (routing, names all five tools)
"Verify before asserting anything that may have changed since training (versions, APIs, flags, prices, dates, current docs): use a web tool, web_recall first if already looked up. Pick by who writes the answer: web_search (ranked pages) then web_fetch (known URLs) when you will read sources; web_answer for a cited answer in seconds; web_research for fields/tables, 3+ entities, or a report.",
// web_research, rule 2
"Submit web_research once early and keep working; progress and completion arrive as messages even after you end your turn.",
```

**Descriptions:**

```ts
// web_answer
"Ask Parallel's research agent for a synthesized, cited answer in seconds—use for current versions, API details, or facts that may postdate your training. Returns the answer plus its top source URLs; stored as evidence."
// web_research
"Hand a research job to Parallel's background agent (core ~1-5 min; pro/ultra longer) for a cited report or structured fields with per-field citations and reasoning. Returns a reference immediately; progress and completion arrive as messages; interim findings via web_recall { reference }."
// (drop "confidence" until task-run-lifecycle stores field.confidence and recall prints it)
// web_recall snippet
"Search, list, or read evidence the web tools already stored; call with no arguments to list recent records"
```
Also make `README.md:84-85` match the cross-session behaviour that actually ships.

**Receipt / citation lines:**

```ts
// answer-service.ts:222
`Sources (${unique.length}): ${unique.slice(0, 5).map(u => new URL(u).host).join(", ")}${unique.length > 5 ? ", …" : ""}. Full answer: ${reference}.`
// formatFetchReceipt item line
`- ${title} — ${url}${item.publish_date ? `, published ${item.publish_date}` : ""}${item.acquired_at ? `, fetched ${item.acquired_at}` : ""} (${n} chars stored)`
// completionBody: append field names
`Fields: ${fieldNames.slice(0, 8).join(", ")}.`
// recall structured item: "release_date = 2024-05-01 (confidence: high; 3 sources)"
```
Wire `store.citations()` into the recall handle read for `report` and `structured` evidence.

**Error hints:**

```ts
// paid-call.ts: definite-failure tail, keyed on err.status
const HINT: Record<number, string> = {
  401: "Not signed in or token expired; ask the user to sign in again—do not retry.",
  402: "Parallel credits exhausted; tell the user—do not retry.",
  404: "Unknown reference/id; check it with web_recall.",
  409: "Conflicts with an existing run; check web_recall { reference } before resubmitting.",
  422: "Invalid parameters; fix the named field and retry once.",
  429: "Rate limited; wait ~30 s before one retry, or continue without.",
};
// closed()
`${name} does not accept ${extra.join(", ")}; accepted: ${allowed.join(", ")}`
// action_required alert body
`… Parallel needs a user action on this run; tell the user, and do not resubmit—completion will still arrive here.`
```

## 5. Prioritized Recommendations

### 5.1 Quick Wins (P0 — Correctness, Drift & Steering Fixes)

1. **Check Responses status** in `src/answer-service.ts:183-201`: surface `response.status` (`failed`/`incomplete`/`cancelled`), `response.error`, `response.incomplete_details`.
2. **Fix `src/source-policy.ts`**: allow domain/path prefixes (`docs.python.org/3`), document bare TLDs (`.gov`, `.edu`, `.co.uk`), drop `*` wildcards, handle include+exclude conflict explicitly, replace `Date.parse` (accepts `2025-02-31` at L47) with `parseCalendarDate` (`src/recall.ts:70-80`).
3. **`web_answer`**: add `effort: "auto"` to `ANSWER_EFFORTS` (`src/answer-service.ts:39`), record `effort_used`, price from it; make domain filters mutually exclusive.
4. **Unify credential precedence** between `src/ops.ts:resolveResearchKey` and `crates/parallel-tools/src/auth.rs:resolve_api_key`; document it in `README.md`.
5. **Steering**: add an anti-stale-prior trigger to `promptGuidelines`; map HTTP statuses (401/402/403/422/429/5xx) to recovery hints in `paid-call.ts`; align `README.md` with cross-session handle/`continue_from` behaviour.
6. **Empty `web_recall {}`**: list recent evidence instead of throwing the error at `src/recall.ts:126`.

### 5.2 Targeted API & Evidence Upgrades (P1)

1. Internal provenance: `acquired_at`/`publish_date` on `web_fetch`, `warnings` and `usage` on search/extract/tasks.
2. `outputEvidence` (`src/task-run-lifecycle.ts:298-383`): store `field.confidence`; wire `store.citations()` (`src/store.ts:1140`) into `web_recall` so stored `citations.claim` reasoning is readable.
3. Pass `betas` (`field-basis-2025-11-25`, `events-sse-2025-07-24`) from `src/task-service.ts`, matching `parallel-tools`.
4. Show top unique source hosts inline in the `web_answer` receipt.
5. Optional `location` (ISO-3166 alpha-2) on `web_search`/`web_research`.
6. Optional `links: true` on `web_fetch`, stored as evidence, not dumped into the receipt.

### 5.3 Conditional / Deeper Redesigns (P2 — With Explicit Revisit Triggers)

Keep these in the deferred `parallel-tools mcp` until a trigger fires:

| Item | Revisit trigger |
|---|---|
| `POST /v1/decisions` | Logs show repeated single-claim verification loops via `web_answer`; then add a `claims` mode on `web_answer`, not a 6th tool |
| `web_answer` `json_schema` | Agents repeatedly post-parse `web_answer` prose into structure that `web_research` is too slow for |
| `POST /v1/images/search` | Users ask for image results in Pi sessions |
| `POST /v1/places/search` | Users ask for local/place lookups |
| `POST /v1beta/findall/entity-search` | Entity-list queries recur and `web_search` misses them |
| `text.verbosity` | Answer length complaints that `instructions` cannot fix |
| `task_spec.input_schema` | Structured inputs needed beyond the text prompt |

### 5.4 Explicit Non-Goals (Keep Out of pi-webtasks)

These belong only in the `parallel-tools` CLI / deferred MCP:

- Monitors (8 endpoints)
- Async FindAll (9 endpoints)
- Server Memory (3 endpoints + `memory_scope_key`); local SQLite recall covers this
- Chat Completions Beta
- Webhooks
- Responses SSE `stream`
- Batch Task Groups (`1..1000` runs per call)
- `lite`/`base`/`ultra4x`/`ultra8x` Task processors
- `output_schema: auto`
- Provider-side remote `mcp_servers`
- `pay_per_use` `data_sources`
