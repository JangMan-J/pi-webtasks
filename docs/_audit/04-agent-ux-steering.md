# Audit 04 — Agent UX & Steering

## 4. Agent-Facing Design & Steering Critique

Scope: how well `pi-webtasks` keeps an agent from (a) answering from stale training priors and (b) picking the wrong web tool or looping on retries. Line numbers refer to this worktree. `parallel-tools` (`crates/parallel-tools/src/{auth.rs,format.rs,mcp.rs,catalog.rs}`) is not checked out here; comparisons to it rely on the behaviour named in the Card brief (`format_api_error` with per-status hints) and are marked as such.

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
- **Effort vs processor overlap.** `web_answer.effort` (`low|medium|high|auto`; the test pins *"medium (~15-20 s)… (the default)"*, `tool-wording.test.ts:37`) and `web_research.processor` (`core|core2x|pro|ultra…`) are two depth dials with no shared vocabulary. The routing rule's only hint is "effort high for comparisons", so "compare 4 libraries" fits both tools. A sharper cut: *more than ~3 entities, or wanting fields/table → web_research core*.
- **output_schema vs output_description** (`:171`, `:173`). "Give this or output_schema" is stated on both, but the either/or is not enforced in the schema. The `output_schema` description is long (≈330 chars), and an agent wanting "a table" has to pick between hand-writing JSON Schema and prose. Add one decision line: *"a table/fields you will consume programmatically → output_schema; a narrative → output_description"*.
- **Recall scope drift.** The tool description (`:211`) says: *"within this session by default, by handle/reference across sessions, or across sessions over a time range via within/since/until"*. `continue_from` (`:176`, `:199`) also says "from this or an earlier session". But `README.md:84-85` says: *"Evidence belongs to one Pi session. A handle from another session behaves exactly like a missing one, so nothing leaks across sessions."*, and `README.md:193` lists cross-session visibility as "still open". One of the two is wrong. An agent (or a human reading the README) cannot tell whether a handle remembered from yesterday is worth trying, and either answer leads to wasted calls.

### 4.3 Evidence, Citations & Recall Flow

- **Broken promise on web_research.** `:156` promises *"structured fields with per-field citations, reasoning, and confidence"*, and `:171` says *"Citations, reasoning, and confidence are returned per field automatically—do not add fields for them."* Actual behaviour:
  - `src/task-run-lifecycle.ts:336,376` keeps only `field.reasoning` (as the citation `claim`). `field.confidence` is never read (grep for `confidence` in that file: no hits).
  - `src/store.ts:1140` defines `citations(sessionId, evidenceHandle)`, but `src/recall.ts` never calls it (no `citations(` hit). The citation rows are written (`store.ts:1102-1106`) and cannot be read back.
  - Net effect: the agent was told not to request confidence, and it then never receives it. That is worse than not promising it. The agent cannot say "low confidence on release_date" and either over-trusts the result or re-asks.
- **web_answer receipt hides sources.** `src/answer-service.ts:222`: *"Citations: ${citations.length} source link(s). Full answer: ${reference}."* There are no URLs inline, so getting them costs a second call (`:223`, "list cited sources with web_recall { reference }"). The count comes from `citations.length`, i.e. annotation occurrences (`evidenceFromAnswer`, `:97-131`, pushes one per annotation), not unique URLs. "12 source link(s)" may be 3 sites. The URLs are already in memory at that point, and listing the top 3-5 unique hosts costs about 200 chars of the 4200 budget.
- **web_fetch drops freshness.** The search receipt prints `, published ${source.publish_date}` (`research-service.ts:360`). The fetch receipt (`formatFetchReceipt`, `:372-393`) types `fetched` without `publish_date` and shows title, URL, and char count only. There is no `acquired_at` either, so with `max_age_seconds` (`:143`) the agent cannot see whether it read a cached copy. For "is this doc current?" the date is the deciding fact, and fetch is the tool used to answer exactly that.
- **Recall discovery.** `web_recall` has only optional params (`:214-224`). An empty call has no documented meaning ("list recent"? error?). The footer hints (`recall.ts:247`, `research-service.ts:394`) are good breadcrumbs, but nothing in the snippet says "call with no args to list what you have", which is the natural first move after a context compaction.

### 4.4 Error, Validation & Recovery Hints

What pi-webtasks does better than a generic API wrapper:
- **No auto-retry on paid calls:** `paid-call.ts:164` sends `maxRetries: 0`, and the record is settled before the throw.
- **Explicit uncertain vs failed:** `outcomeUnknown` (`paid-call.ts:111-114`) classes 4xx as a definite rejection and 5xx/408/no-status as unknown. The error text then branches (`:173`). `web_answer` overrides it with *"Its outcome is unknown (record ${reference}); ask again only if you still need the answer."* (`answer-service.ts:184`). This blocks the classic double-charge loop, and per the brief parallel-tools has no equivalent state.
- **Closed parameters:** `closed()` (`research-tools.ts:89-92`) rejects typos instead of silently ignoring them, and its comment states why.
- **validateQueries** (`research-service.ts:83-88`) errors are actionable: *"search_queries takes at most 3 focused queries; merge the rest"*.

Where it is weaker:
- **No status-specific hints.** A definite failure ends with only *"Record ${reference}."* (`paid-call.ts:173`) after `failureMessage` (up to 500 chars of provider body). By the brief's account, `parallel-tools` `auth.rs::format_api_error` maps 401→re-auth, 402→credits, 404→bad id, 408→timeout, 409→conflict, 422→fix params, 429→back off, 5xx→provider issue. Here a 401 or 402 reads like any other failure, so the agent's natural move is to rephrase and retry, which is a loop that cannot succeed. A 429 gives no wait guidance.
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
