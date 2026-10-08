# pi-webtasks

Three web research tools for Pi:

| Tool | Work |
| --- | --- |
| `web_search` | Find sources, read known pages, or search for people and companies. |
| `interactive_search` | Get a cited answer and continue through a local conversation reference. |
| `deep_search` | Submit background research or read its saved result through a local research reference. |

Implementation and integration verification are in progress.
The [mapping](docs/api-mapping.md) separates chosen workflows, intentional omissions, and open output-schema decisions.
The [release checklist](docs/release-readiness.md) records validation and remaining blockers.
This checkout does not replace the installed extension or restart any running process.

## Development

Requirements: Node.js 22.19 or later and npm.
The only runtime dependency is the pinned `parallel-web` SDK.
SQLite uses Node's built-in implementation.

```sh
npm ci
npm run check
npm pack --dry-run
```

`npm run check` runs type checks and the offline regression suite.
Local tests use real SQLite, private temporary artifacts, and signed loopback HTTP callbacks.
Controlled external responses support failure and recovery tests.
Those tests do not establish live provider delivery or real model navigation.
No paid research runs during the offline suite.

The old nine-tool test files remain under `tests/legacy/`.
Historical experiments remain under `bench/` and `docs/`.
They do not establish acceptance of the three-command interface.

## Credentials

Use the existing `_PARALLEL_API_KEY` and `PARALLEL_WEBHOOK_KEY` environment variables.
The latter is the signing secret, not the research key.
Explicit `PIPARA_API_KEY` and `PIPARA_WEBHOOK_SECRET` remain supported for compatibility.
Exported settings take precedence over adjacent `.env` or `parallel.env` defaults.
Credential files are not packaged or committed.

Do not paste credential values into tool arguments, diagnostics, or source files.
The extension does not create accounts, keys, credit purchases, or monitors.
Existing human login, logout, balance, and callback recovery commands remain.

## Examples

Find sources:

```json
{ "query": "Current SQLite WAL checkpoint documentation" }
```

Read a known page through `web_search`:

```json
{ "urls": ["https://sqlite.org/wal.html"] }
```

Use native Fast Entity Search:

```json
{ "query": "Companies that develop embedded databases", "entity": "companies" }
```

The entity branch supports only people and companies.
It requests one synchronous lookup, with a documented default of 100 results.
It requires no group, callback, or session/group association.
URLs and domain filters are incompatible with this branch.
Published price is $0.005 per request, including 100 results.
Ranked entity results are not native FindAll verification or enrichment.

Ask `interactive_search`:

```json
{ "question": "When does SQLite WAL need a checkpoint?" }
```

Continue with the returned conversation reference:

```json
{
  "question": "How does that affect long-lived readers?",
  "conversation": "conversation_<returned UUID>"
}
```

Submit `deep_search`:

```json
{ "query": "Compare SQLite WAL checkpoint strategies. Cite the official constraints." }
```

Read completed research without another submission:

```json
{ "research": "research_<returned UUID>" }
```

An explicit follow-up combines a new query with a completed research reference.
A query array submits independent briefs to the same session's group.
Reference-only calls reject effort and domains.

## Session and group behavior

Startup looks up the Pi session ID and hydrates any existing group.
It never registers a fresh session or creates a remote group.
The first deep submission initializes one group through a shared in-flight promise.
It persists the group ID before adding Task runs, then caches it for normal submissions.
Reload and resume recover the association. Session switches do not reuse another session's cache.
Routine, entity, conversation, and reference-only calls never create groups.
Session stop saves accepted work and detaches local notification handling without draining remote research.
The backend has no group-close operation.

Research state uses the existing `webhooks.sqlite` inbox.
`PIPARA_WEBHOOK_DIR` selects the shared location.
The conventional location remains `getAgentDir()/parallelized/webhooks` for compatibility.
There is no second database or registry of every Pi session.
New evidence artifacts use `getAgentDir()/webtasks/results`.
Existing accepted work and artifacts remain accessible.

## Existing webhook receiver

Deep submission requires `PIPARA_WEBHOOK_URL` and an explicit shared `PIPARA_WEBHOOK_DIR`.
Do not launch a second listener when the existing receiver already runs.
Loading the extension starts no HTTP listener.

The receiver verifies callbacks and commits them to SQLite before HTTP acknowledgement.
Result processing belongs inside that same receiver process.
The callback contains status; the worker fetches the completed answer separately.
It saves the answer and citation basis before recording completion.
Only the owning Pi session delivers and acknowledges its notification.
An inactive owner retains its pending notification for resume.
Delayed registration and unacknowledged notifications must survive local cleanup.

The current installed process still runs the installed `pi-parallelized` receiver.
Changing files in this checkout does not update that process.
Production use of the new worker requires a separate deployment of this checkout's receiver code.
Installation and public-route changes are outside the implementation scope.
The [webhook guide](docs/webhook-integration.md) describes configuration and recovery.

## Limits

- Exactly three model tools. No vendor actions, remote IDs, processor names, or transport controls in their schemas.
- Default effort is `low`, with no automatic escalation.
- User-selected discovery tiers are fast/basic/advanced. Deep tiers are core/pro/ultra2x.
- Responses keeps low/medium/high. URL reading and entity lookup reject explicit effort.
- Saved tier evidence does not establish universal quality or latency ordering.
- Native Fast Entity Search is included. New async FindAll create, extend, and enrich workflows are excluded.
- Caller-defined output schemas remain an explicit contract decision.
- Result retrieval does not generate a missing alternative format.
- Complete redacted evidence stays on disk even if previews omit content.
- Paid submissions never retry automatically after uncertain acceptance.
- A real public callback and model-navigation check remain necessary before claiming full research acceptance.

The [effort review](docs/effort-qualification.md) records saved evidence and its limits.
The [historical README](docs/legacy-interface.md) preserves the old interface for comparison.
