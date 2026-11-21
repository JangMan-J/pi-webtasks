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
| F18 | `text.verbosity` / `text.format: json_schema` not exposed on `web_answer` | `src/research-tools.ts:194-201`; `src/answer-service.ts:168-177` | High-Leverage Surface Addition (`format`); Keep Friction (`verbosity`) |
| F19 | `Response.status` `incomplete`/`cancelled` + `incomplete_details` handling must be confirmed in receipt | `src/answer-service.ts:180-240` | Bug/Drift (verify) |
| F20 | No `parallel-beta: field-basis-2025-11-25` / `events-sse-2025-07-24` header sent explicitly; relies on SDK defaults | `src/task-service.ts:224,288,374` | Bug/Drift (verify) |
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
- `after_date` validated against `CALENDAR_DATE` (L28) only; no real-date check (`2025-02-31` passes). Minor drift.

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
| `urls` | 1-20, minLength 1 (L139) | 1..20 | OK; no `http(s)` scheme check client-side (description claims "absolute http(s)") — minor |
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
| `text.format` | absent | `json_schema` | F18: structured quick answers without a 5-15 min Task; high leverage |
| `text.verbosity` | absent | `low/medium/high` | F18 Keep: `instructions` covers length |
| `model` | fixed `"parallel"` (L169) | — | Keep |

Response handling (L180-240): confirm `status` ∈ `failed/incomplete/cancelled` maps to an error receipt quoting `error`/`incomplete_details`, not a partial answer presented as complete → **F19**. Citations: `url_citation` annotations on the `message` output are the evidence source; `web_search_call` items carry queries — storing them would aid recall but is optional.

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

Wire: group create `taskGroup.create({}, {maxRetries:0})` (L149); `addRuns` (L224); `taskRun.retrieve` (L255,414); `taskRun.result(runId, {timeout:0}, {timeout:60_000})` (L288); `taskRun.events` (L374); `taskGroup.getRuns(..., {include_input:true})` (L433). None pass `betas`/headers explicitly. `parallel-tools` sends `parallel-beta: field-basis-2025-11-25` on create/result and `events-sse-2025-07-24` on SSE → **F20**: verify the SDK version in `package.json` sends them; otherwise `basis` and SSE progress may be absent or shaped differently.

Result mapping `buildTaskEvidence` (`task-run-lifecycle.ts:297-375`): reads `basis[].field` and `basis[].citations[]` (L305-318, L366-375) only. `FieldBasis.confidence` and `FieldBasis.reasoning` are never stored, while the tool description (`research-tools.ts:156,171`) promises "per-field citations, reasoning, and confidence" → **F21**. Fix: append `confidence`/`reasoning` to each `structured` field body or a sibling column. `TaskRun.warnings` unread → **F22**.

Progress interval: `intervals` from processor latency guidance (L43-66, floor 5 000 ms, overridable via JSON) — Keep.

### 3.6 web_recall (Local SQLite Evidence Store)

Schema `src/research-tools.ts:213-226`; service `src/recall.ts`; store `src/store.ts`.

| Param | Constraint | Verdict |
|---|---|---|
| `handle` / `query` / `reference` | minLength 1; one mode per call | OK |
| `kinds` | `EVIDENCE_KIND_NAMES` = report, structured, finding, source, excerpt (`store.ts:84`) | OK; no `answer` kind although descriptions say "answers" (L211) — check which kind answers are stored under |
| `within` / `since` / `until` | shorthand or ISO | OK |
| `limit` | 1-20, default 8 | OK |
| `cursor` | "pass alone" | OK |
| `offset` / `max_chars` | ≥0; 500-8000 default 4000, `clamp()` (`recall.ts:48-50,136`) | F27 Keep (schema already rejects out-of-range; clamp is a backstop) |

- `store.citations(sessionId, evidenceHandle)` (`store.ts:1140`) has no callers; citation rows written by `buildTaskEvidence` are unreachable from `web_recall` → **F25**. Either surface "cited sources" when reading a `structured`/`report` handle, or delete the method.
- Confidence/reasoning (F21) never reach the store, so recall cannot show them.
- Cross-session drift → **F26**: `research-tools.ts` describes `handle`, `reference` (L214,216) and `continue_from` (L176,199) as valid "from this or an earlier session"; `README.md:84-85` says "Evidence belongs to one Pi session. A handle from another session behaves exactly like a missing one", and `README.md:193` lists cross-session visibility as an open decision. Align one way: either update README to the shipped behaviour or narrow the descriptions; verify against `store.ts` session filtering before choosing.
- Store path `WEBTASKS_DIR` else `<agent-dir>/webtasks`, dir mode `0o700` (`store.ts:512`), WAL (L398). OK.

### Priority order

1. Bugs that change provider behaviour: F4, F1, F3, F21, F20.
2. Drift visible to users: F26, F12/F22, F25, F5.
3. Leverage additions: F17, F18 (`json_schema`), F13, F11.
4. Internal defaults: F6, F10, F14, F16.
