# Audit 02: Surface Recommendations

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
| Search `location` | Defer | Real for local/regional queries, but no observed demand; add later as one optional ISO code. | parallel-tools |
| `SourcePolicy` path prefixes + TLDs | Defer | `include_domains`/`exclude_domains`/`after_date` already cover the common case. | parallel-tools |
| Extract `warnings` / `usage` | Add (Internal) | Same as search. | pi-webtasks |
| Extract `acquired_at`, `publish_date` | Add (Internal) | Store as evidence metadata and show dates in `web_recall`; directly helps agents judge staleness. | pi-webtasks |
| Extract `links` (<=512 URLs) | Defer | Useful for crawling, but a 512-URL list fights C5; revisit as stored-only metadata if agents ask to follow links. | parallel-tools |
| Extract `max_chars_total`, `full_content.max_chars_per_result` | Add (Internal) | Bound by the extension; `full_content` stays a boolean for the agent. | pi-webtasks |
| Extract `fetch_policy.timeout_seconds`, `disable_cache_fallback` | Add (Internal) | Fixed policy that pairs with `max_age_seconds`; no agent knob. | pi-webtasks |
| Responses `reasoning.effort: "auto"` + `effort_used` | Add (Internal) | Record `effort_used`; consider `auto` as the default when `effort` is omitted. Keeps the `effort` parameter as is. | pi-webtasks |
| Responses `Response.status` / `incomplete_details` / `web_search_call` | Add (Internal) | Needed to tell a partial answer from a full one, and to store the searches behind it as evidence. | pi-webtasks |
| Responses `text.format` (`json_schema`) | Defer | Structured output already lives in `web_research.output_schema`; adding it to `web_answer` blurs the two tools. | parallel-tools |
| Responses `text.verbosity` | Defer | `instructions` covers it in prose. | parallel-tools |
| Responses `stream` (SSE) | Keep Out | Seconds-scale answer; streaming adds partial-record states to C3 for no agent benefit. | none |
| Responses `tools: [{type:"mcp"}]`, `data_sources`, `metadata` | Keep Out | Provider-side MCP and paid data sources move credentials and cost outside the recorded-call shape. `metadata` is internal-only if used. | none |
| Tasks `location` | Defer | Same as search `location`. | parallel-tools |
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

**Add (Existing Tool): none now.** The best candidate is a `location` parameter
on `web_search`/`web_research`. It stays Deferred until a session shows a
region-dependent answer going wrong. When it lands, it is one optional field in
the `closed(...)` list, not a policy object.

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
4. Credential precedence must stay identical in both: `src/ops.ts` and
   `crates/parallel-tools/src/auth.rs` resolve the Parallel key in the same
   order, so one `/login` serves both and an agent never sees one tool
   authenticated and the other not. Any change to the order in one is a change
   to both.
