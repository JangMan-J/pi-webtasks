# Research interface mapping

Status: implemented interface with offline verification. Live acceptance remains separate.
Three ordinary tools provide common workflows. A codemode-only tool provides advanced SDK Task submission.
Installation, publication, and changes to the running receiver remain separate.

## Review summary

- **Chosen workflows:** source discovery, page reading, synchronous people/company search, cited conversation, and background Task research.
- **Intentional omissions:** monitoring, account administration, model-facing stream/poll controls, and arbitrary callback settings.
- **Entity coverage:** native Fast Entity Search in `web_search`. No new async FindAll discovery, expansion, or enrichment.
- **Advanced Tasks:** `webtasks_submit` accepts caller-defined schemas and native Task options. Retrieving a result does not generate a different output format.
- **Release checks:** cross-slice integration, real model navigation, and live provider SSE collection remain unverified.
- **Completion transport:** outbound Task Group SSE with bounded polling fallback, run inside the owning session. Webhooks are optional.
- **Deployment:** `deep_search` needs no public callback. The configured public callback URL still fails DNS resolution from this machine, which matters only for the optional webhook path.
- **Effort:** user-confirmed policy. Default is `low`, with no automatic escalation.
- **MCP:** an alternative, not an approved replacement. Its documented later-turn result retrieval does not establish automatic offline delivery.

## Three ordinary tools

Each object rejects unknown fields. Semantic validation runs before paid requests.
Blank strings, invalid URLs, invalid domains, and incompatible argument combinations are errors.

### `web_search`

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "minLength": 1 },
    "entity": { "enum": ["people", "companies"] },
    "effort": { "enum": ["low", "medium", "high"] },
    "urls": {
      "type": "array",
      "items": { "type": "string", "minLength": 1 },
      "minItems": 1,
      "maxItems": 20
    },
    "domains": {
      "type": "array",
      "items": { "type": "string", "minLength": 1 },
      "minItems": 1
    }
  },
  "additionalProperties": false
}
```

- Query only: Search with the query as its objective and search query.
- Discovery effort: low selects fast, medium selects basic, and high selects advanced.
- Query and entity: native Fast Entity Search for people or companies.
- URLs: Extract those pages. An optional query supplies focus.
- Domains: restrict discovery sources. Domains with explicit URLs are rejected.
- Entity search rejects URLs and domains. Its documented request has no hard source filter.
- URL reading and entity search reject explicit effort. They have no tier selection.
- Entity search uses the backend's default limit of 100 results, with no public count knob.
- Entity results return names, canonical URLs, and descriptions. They do not include native enrichment.
- Published cost is $0.005 per entity-search request, including 100 results.
- Return: readable evidence, source URLs, and saved-file pointers.
- Full extracted content stays in the artifact even if the preview omits it.

### `interactive_search`

```json
{
  "type": "object",
  "properties": {
    "question": { "type": "string", "minLength": 1 },
    "conversation": { "type": "string", "minLength": 1 },
    "effort": { "enum": ["low", "medium", "high"] },
    "domains": {
      "type": "array",
      "items": { "type": "string", "minLength": 1 },
      "minItems": 1
    }
  },
  "required": ["question"],
  "additionalProperties": false
}
```

- Question: request a cited Responses answer.
- Question and conversation: resolve the local reference to the previous response internally.
- Domains: restrict research sources through the backend's allow filter.
- Return: cited answer, immutable local conversation reference, and artifact.
- Each answer gets a new reference. Parallel follow-ups cannot replace their parent.
- Partial answers retain their artifact and any known continuation identity.
- An uncertain paid request is never silently repeated.

### `deep_search`

```json
{
  "type": "object",
  "properties": {
    "query": {
      "anyOf": [
        { "type": "string", "minLength": 1 },
        {
          "type": "array",
          "items": { "type": "string", "minLength": 1 },
          "minItems": 1
        }
      ]
    },
    "research": { "type": "string", "minLength": 1 },
    "effort": { "enum": ["low", "medium", "high"] },
    "domains": {
      "type": "array",
      "items": { "type": "string", "minLength": 1 },
      "minItems": 1
    }
  },
  "additionalProperties": false
}
```

| Branch | Behavior |
| --- | --- |
| Query | Submit new research to this session's group. Return a local reference before research finishes. |
| Query array | Submit independent briefs to the same group. Each brief gets its own reference and dispatch intent. |
| Reference only | Read saved evidence or request explicit bounded recovery. Never create a group or add work. |
| Query and completed reference | Submit an explicit follow-up grounded in the saved answer. Reuse the known interaction context internally when available. |
| Query and pending/incompatible reference | Reject. Do not turn a read or ambiguous follow-up into another paid submission. |

Reference-only calls reject effort and domains.
Domains become a per-run source policy, not just text in the brief.
The initial implementation submits one Task input per addition to avoid uncertain ordering of returned run IDs.

## What happens to the existing research methods?

“Internal” means the method still runs when needed. Its controls disappear from the model interface.
“Recovery” means an explicit, bounded read.
The internal collector's snapshot polling is separate and bounded by backoff.
“Omitted” means the new interface does not provide that capability.

| Existing surface | New mapping | Disposition |
| --- | --- | --- |
| Search | `web_search.query` and discovery `domains` | Exposed through intent fields. |
| Extract | `web_search.urls` and optional `query` | Exposed through page-reading intent. |
| Responses create | `interactive_search.question`, `effort`, `domains` | Internal request construction. |
| Responses continuation | `interactive_search.conversation` | Local reference resolves the remote response identity. |
| Task create | `deep_search.query` | Group addition creates the Task; no separate create action. |
| Task result | Outbound run-state event (or optional verified webhook) | Internal one-shot result fetch after the event. |
| Task status | `deep_search.research` recovery | Explicit bounded snapshot or dispatch reconciliation. |
| Task input | Persisted submission brief | No input-retrieval control. Retain a read only if reconciliation needs it. |
| Task progress events | None | Run-level progress events are omitted. |
| Task Group create | First deep submission with no cached group | Internal lazy initialization. |
| Task Group add | Deep submission after group initialization | Internal dispatch. |
| Task Group status/run snapshots | Recovery of known work | Internal bounded reconciliation, never paid resubmission. |
| Task Group runs/events streams | Internal completion transport | Runs snapshot (no outputs) reconciles; `GET /v1/tasks/groups/{id}/events` resumed by `last_event_id` drives completion. No model-facing controls. |
| FindAll ingest/preview/create | Not mapped in the initial Task path | Specialized entity enumeration remains a coverage gap. |
| FindAll entity search | `web_search.query` and `entity` | Native synchronous people/company search. No group or callback. |
| FindAll extend/exclusions | Not mapped | No native match-count expansion or exclusion-list continuation. |
| FindAll enrich/schema | Not mapped | No native per-entity enrichment or schema guarantee. |
| FindAll result/status | Existing registered legacy work | Preserve recovery internally; do not strand accepted runs. |
| FindAll events | None for new work | Outbound or webhook completion replaces transport, not enumeration semantics. |
| Monitor create/update/trigger/cancel/list/events | None | Explicitly excluded from the three-tool interface. Preserve accepted legacy registrations. |
| Remote Memory retrieve/evict/clear | None | Local references do not reproduce remote memory administration. No deletion control. |
| Account management | No commands and no account tool. Credentials come from the environment or the key file. | No account model tool or administration surface. |
| Failed result fetch | Retried once when the owning session next starts | No manual recover command; the retry is a read, never a submission. |

### Entity coverage is deliberately narrow

The latest user decision selects native Fast Entity Search within `web_search`.
The `entity` field chooses people or companies explicitly. No extra routing-model call selects a paid backend.
The request contains `entity_type` and `objective`; its optional `match_limit` defaults to 100.
The pinned SDK exposes no domain filter for this endpoint, so incompatible filters are rejected.

There are no FindAll create, preview, extend, or enrich workflows for new work.
Existing accepted FindAll runs still receive internal recovery.
Fast Entity Search does not create a group, require callbacks, or insert a session/group association.
Task Group additions remain Task `RunInput` objects, not FindAll memberships.
This is curated coverage, not full FindAll parity.

### JSON, prose, and result retrieval

Task result retrieval returns the output selected by the creation schema: text or JSON.
It does not generate a missing alternative format.
Published pricing charges per successfully completed Task Run, not per output field.
No separate result-read charge is listed.

One creation can request a JSON object with a prose `report` field and structured fields.
That uses the same processor/run price, not a second research submission.
The receiver preserves the raw output and its citation basis.
Readable rendering is local and must not trigger another paid request.

The ordinary `deep_search` schema omits arbitrary output schemas.
`webtasks_submit.task.task_spec` accepts a native schema at creation time, including JSON fields for both prose and structured data.
The provider determines schema support. The local result reader preserves the returned format.

## Advanced SDK Task submission

`webtasks_submit` is callable through codemode, not directly declared as a fourth ordinary tool.
It accepts `{ label, task, betas? }`, with one native SDK `RunInput` per call.
The [advanced SDK guide](advanced-sdk.md) defines the fields and includes an example.
Both `web_search` and `deep_search` point agents to that guide when ordinary tools cannot express the required Task options.

Both submission tools share `submitTrackedTask` in `src/research.ts`.
That helper owns intent-first persistence, group selection, reserved metadata, acceptance binding, and collector wake-up.
It disables automatic submission retries and preserves uncertain outcomes.
The existing stream, snapshot, inbox, artifact, and notification flow handles both tools.
Search/Extract, FindAll, and Monitor workflows do not enter this helper.

## Meaningful option mapping

The table describes the ordinary tools unless it explicitly names `webtasks_submit`.

| Old option family | New treatment |
| --- | --- |
| `action` and operation selectors | Removed. The tool and its argument combination select the branch. |
| Search `objective`, `search_queries`; Extract focus | Derived from `web_search.query`. No keyword-query expansion model call. |
| Entity type/objective/count | `web_search.entity` selects people/companies; query supplies objective; backend default is 100. No count knob. |
| Search `mode` | Derived from discovery `effort`: low/fast, medium/basic, high/advanced. No processor names in arguments. |
| Retrieval counts and excerpt/full-content limits | Internal existing limits. Extract requests full content. No new completeness claim beyond returned evidence. |
| Cache age, cache fallback, fetch timeout | Internal existing defaults. No model-facing cache/transport knobs. |
| Include/allow domains | Exposed as `domains`; translated to the appropriate source filter. |
| Exclude/block domains, raw source policy, date/location filters | Ordinary tools omit hard controls. `webtasks_submit.task` accepts native source policy and location settings. |
| Responses message roles and separate instructions | One `question` plus saved conversation context. No model-supplied system/developer message array. |
| Responses format/stream/metadata | Internal answer format and non-streamed call initially. No arbitrary format or metadata control. |
| `previous_response_id` | Derived from the local conversation reference. |
| `previous_interaction_id` | Ordinary follow-ups derive this from the completed parent. `webtasks_submit.task` accepts an explicit provider identity. |
| Task processor and FindAll generator | Ordinary Task processor derives from effort. Advanced Tasks require an explicit processor. Async FindAll generation remains excluded. |
| Task input/task specification/output schema | Ordinary briefs request a cited report. `webtasks_submit.task` accepts structured input and native input/output schemas. |
| Query batches | Exposed by `deep_search.query` array. Group membership and transport are internal. |
| `run_id`, `taskgroup_id`, `findall_id`, response/interaction IDs | Internal SQLite state and diagnostic artifacts. Normal results use local references. |
| `wait_seconds`, polling and stream cursors | Removed from model calls. Deep submission returns without awaiting completion. The collector keeps its own stored cursor. |
| `webhook_url`, webhook events and signing scheme | Optional deployment configuration. When set, runs carry the per-run subscription. No agent override. |
| `enable_events` | Advanced Tasks can enable provider progress recording. The extension still exposes only completion notifications. |
| MCP configuration and tool allowlists | `webtasks_submit.task.mcp_servers` accepts native definitions. |
| Metadata/client-model/session identifiers | Ownership fields stay internal. Advanced Tasks accept user metadata outside the reserved `webtasks_` prefix. |
| Memory-scope keys | Advanced Tasks accept `memory_scope_key`. A session group does not imply backend memory isolation. |
| FindAll conditions/match limits/exclude list | Async enumeration capabilities omitted by the narrower entity-search decision. |
| FindAll preview/extend/enrich/cancel controls | Unmapped. No automatic expensive expansion or destructive cancellation. |
| Monitor frequency/backfill/snapshot controls | Omitted because monitoring is excluded. |
| `return_mode`, preview budget | Internal readable preview with complete saved evidence. No public transport/output selector. |
| `output_path`, overwrite | Automatic private artifacts that never overwrite existing evidence. Caller can read or copy the returned file. |
| Authentication, balance, keys and credit | No commands. No account operations or automatic credit. |

## Effort policy and evidence

The user confirmed these exact mappings from the supplied tier screenshot:

| Path | Public effort | Internal choice |
| --- | --- | --- |
| `web_search` discovery | `low` / `medium` / `high` | Search `fast` / `basic` / `advanced`. Default `low`. |
| `web_search` URL/entity branch | None | Extract or native Fast Entity Search. Explicit effort is rejected. |
| `interactive_search` | `low` / `medium` / `high` | Responses `low` / `medium` / `high`. Default `low`. |
| `deep_search` | `low` / `medium` / `high` | Task `core` / `pro` / `ultra2x`. Default `low`. |

The saved probe supports latency observations, not a universal quality ranking.
It covers three Search questions and one Responses/Task objective.
Deep collected-result timings contain collector delay.
Policy selection is settled. It does not establish measured quality or latency gains.
The [saved-answer review](effort-qualification.md) preserves historical limits, not an alternative current policy.
No further tier-selection experiment is needed.
The screenshot lists Task prices of $0.025, $0.10, and $0.60 per run for the selected tiers.
Price observations are not invoice verification or automatic spending gates.
No silent escalation or automatic paid retry is allowed.

## Group cache and SQLite lifecycle

```text
session_start
  -> resolve Pi session ID
  -> lookup its existing research association
  -> hydrate runtime groupId and attach recovery
  -> no session row written
  -> no group row inserted and no remote group creation

deep submission
  -> validate all inputs and provider credentials
  -> if runtime groupId is missing: await shared ensureGroup promise
  -> persist initialization intent for this research session
  -> create group once, persist its ID, then cache it
  -> persist each submission intent before adding its Task

session switch/reload
  -> detach old notification context
  -> clear/rebind runtime cache
  -> reload known group from SQLite
```

Only sessions that submit through `deep_search` or `webtasks_submit` get durable group associations.
Normal submissions reuse the runtime cache instead of repeatedly querying or creating groups.
Reference-only reads bypass group initialization.
SQLite is the store (`webtasks.sqlite`), not a second database. Startup adds no session row; a group association exists only for a session that submits deep research.
Uncertain acceptance retains the intent and known identities. Recovery never assumes that another paid submission is safe.
Session stop aborts and settles the collector. It does not close the remote group or drain research.

## Outbound completion

```text
collector loop (inside the owning session)
  -> open GET /v1/tasks/groups/{id}/events from the stored last_event_id (10-minute connection bound)
  -> getRuns snapshot (no outputs, 60-second bound): bind matching uncertain submissions, record settled runs
  -> consume events: record `outbound:<run_id>:<status>` in the events table; advance the cursor in the same transaction
  -> existing pipeline fetches the result once and saves the evidence artifact
  -> owning session receives a local-reference notification
  -> inactive owner retains the notification for resume
```

Group events carry no output, so the Task result fetch remains internal and one-shot.
`task_group_status` events only advance the cursor.
The cursor from group additions seeds the stored cursor only when none exists and no other run of the group is bound.
Backoff is 5 seconds doubling to 300 seconds with jitter; `retry-after(-ms)` on 429 and 503 is honored up to 15 minutes, and the largest hint applies when both requests of a pass fail; SDK retries are off for collector calls.
A pass resets the failure streak and pauses 1 second only when its events connection made durable progress: it inserted a new outbound row, or its stored cursor ended at a value different from the one it resumed from (a group status advance counts). Replays of already-recorded events are not progress and escalate the backoff.
Each events connection is bounded at 10 minutes wall-clock. Expiry without progress takes the normal backoff; expiry after progress reconnects from the cursor after the 1-second pause. Each snapshot is bounded at 60 seconds, open and body (expiry is a failure). The SDK timeout bounds only the time to response headers.
`action_required` runs stay watched, so a later completion is collected as a separate notice.
An uncertain submission missing from the snapshot stays uncertain and stops being polled.
Status, result, and events requests are documented as not counted against the create rate limit; the collector still backs off.
The documented maximum stream duration is one hour, and the SDK stream does not reconnect, so the collector reconnects from the cursor.
Retrieval and session notification remain separate.
No new listener, daemon, or installed-package change is part of this checkout.

An optional signed webhook (`WEBTASKS_WEBHOOK_URL`, shared `WEBTASKS_DIR`, running receiver) adds a per-run callback.
The callback contains a Task Run status object, not the answer and citations.
A run seen through both paths is notified once per reported status, persistently across batches. Two processes can still fetch the same result concurrently; that fetch is idempotent and no paid request repeats.

## MCP alternative

| Question | Current three-tool design | Official MCP tools |
| --- | --- | --- |
| Routine retrieval | One query/URL tool call plus native entity intent | Search MCP exposes `web_search` and `web_fetch`. |
| Long research | Local references, lazy Task group, outbound SSE collector | Task MCP exposes create, group, status, and Markdown-result tools. |
| Completion | In-session collector persists outcomes and routes owner notifications | Current docs require an additional turn to request ready results. |
| Offline owner | Collection pauses while Pi is closed and resumes by snapshot on startup. An optional receiver can save results offline. | Automatic offline artifact storage and session routing are not established. |
| Maintenance | Curated request mapping plus local persistence and delivery | Hosted tools reduce custom request mapping, but do not remove local delivery requirements. |

No MCP replacement or extra adapter is authorized.
If later-turn retrieval replaces automatic notification as the desired outcome, reconsider MCP rather than rebuilding every backend option.

## Source basis and deciding checks

- `.archive/PLAN.md` (git-ignored): recovered intent, exclusions, evidence limits, and the outbound completion decision.
- Latest user decisions: lazy initialization, lookup-only startup, per-session runtime cache, and no extra database.
- User-confirmed tier screenshot: discovery fast/basic/advanced, Responses low/medium/high, Tasks core/pro/ultra2x. No private screenshot data is stored here.
- `src/ops.ts`: current research request construction and one-shot retrieval helpers.
- `docs/tool-reference.md`: existing retrieval, artifact, callback, schema, and processor controls.
- `parallel-web@1.3.3`, `resources/task-group.d.ts`: Task inputs accepted by group additions.
- `parallel-web@1.3.3`, `resources/task-run.d.ts`: per-input source policy, context, metadata, and webhook fields.
- `parallel-web@1.3.3`, `resources/beta/findall.d.ts`: native entity-search fields, default 100, and people/company scope.
- [Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) and [Task MCP](https://docs.parallel.ai/integrations/mcp/task-mcp): hosted tools and later-turn completion limit.
- [Current callback guide](https://docs.parallel.ai/task-api/webhooks): status payload contract for the optional webhook.
- [Task Group API](https://docs.parallel.ai/task-api/group-api) and `parallel-web@1.3.3`, `resources/task-group.d.ts`: `events` (`last_event_id`, `timeout`), `getRuns`, event types, and no output in group events.
- [Task result contract](https://docs.parallel.ai/api-reference/tasks/retrieve-task-run-result.md): one schema-selected output.
- [Published pricing](https://docs.parallel.ai/resources/pricing): successful Task Run pricing, not output-field pricing.
- Saved qualification: `~/Projects/JangLabs/pi-parallelized/.pi/three-tool-tier-probe/`.
- Live group probe: `.pi/group-status-probe/2026-10-07T18-50-05.627Z/REPORT.md`.

Before claiming release readiness, verify the registered schemas, paid-request behavior, durable recovery, and live provider SSE collection.
Offline tests with fake clients establish local correctness, not live provider streaming or model navigation.
