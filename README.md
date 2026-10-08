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

Use the existing `_PARALLEL_API_KEY` environment variable. `PARALLEL_WEBHOOK_KEY` is needed only for the optional webhook receiver.
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
It requires no group, collector, or session/group association.
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
Session stop aborts the outbound collector, waits for it to settle, saves accepted work, and detaches local notification handling without draining remote research.
A replacement runtime resumes collection from the stored cursor.
The backend has no group-close operation.

Research state uses the existing `webhooks.sqlite` store, created automatically and kept private.
`PIPARA_WEBHOOK_DIR` selects the location when set.
Otherwise the store is `getAgentDir()/parallelized/webhooks/webhooks.sqlite`.
Startup is lookup-only. It writes no session row, creates no remote group, and sends no request. Ownership and resume use the research records and the session's group row.
Opening a store drops the `pi_sessions` table from earlier builds, which nothing reads; research, group, and event rows are kept.
New evidence artifacts use `getAgentDir()/webtasks/results`.
Existing accepted work and artifacts remain accessible.

## Outbound completion

Status: implemented on this branch; live acceptance is pending.
Live provider SSE and real model navigation are not verified. Offline tests use fake clients only.

`deep_search` needs only provider credentials (`_PARALLEL_API_KEY`, or the compatible `PIPARA_API_KEY`) and the automatic private SQLite store.
It needs no callback URL, listener, tunnel, public route, or signing secret.

A collector inside the owning Pi session watches the session's Task Group.
Each pass opens the group event stream from the stored cursor, takes a runs snapshot (no outputs) that binds matching uncertain submissions, then consumes the stream.
Each completed, failed, cancelled, or action-required run state is saved before the cursor moves.
On stream or snapshot failure it backs off from 5 seconds, doubling to a 300-second cap with jitter. The largest `retry-after` hint from the pass applies, up to 15 minutes.
Each events connection is bounded at 10 minutes and each snapshot at 60 seconds, so a stalled body cannot block recovery. A connection that reaches its deadline is treated as healthy and reconnects from the cursor.
Action-required runs stay watched, so a later completion is collected.
The snapshot on each loop iteration is the polling fallback.
The existing result pipeline then fetches the answer once, saves the artifact and citation basis, and notifies only the owning session.
Group events carry no answer, so the separate fetch stays.

Collection pauses while Pi is closed.
On startup the collector reconciles registered pending jobs, so completions that happened while closed are found.
Account retention and the documented one-hour maximum stream bound this; the collector reconnects from the cursor.
Notification is acknowledged only after delivery. Exactly-once notification is not guaranteed because of a crash window.

## Optional webhook receiver

Signed webhooks are optional.
With `PIPARA_WEBHOOK_URL`, a shared `PIPARA_WEBHOOK_DIR`, and a running receiver (`PARALLEL_WEBHOOK_KEY` or `PIPARA_WEBHOOK_SECRET`), runs also carry a per-run webhook.
The same run seen through both paths is notified once per reported status. A concurrent duplicate result fetch across processes is still possible; it is an idempotent read that can add one extra artifact, and no paid request repeats.
The receiver's shared worker can then save results while Pi is closed.
Legacy accepted work and `/parallel-webhook` recovery remain supported.
Loading the extension starts no HTTP listener.

The currently installed process still runs the installed `pi-parallelized` receiver.
Changing files in this checkout does not update that process.
The [webhook guide](docs/webhook-integration.md) describes the optional configuration and recovery.

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
- Collection runs only while the owning session is open, unless the optional receiver is deployed.
- Live provider SSE and model-navigation checks remain necessary before claiming full research acceptance.

The [effort review](docs/effort-qualification.md) records saved evidence and its limits.
The [historical README](docs/legacy-interface.md) preserves the old interface for comparison.
