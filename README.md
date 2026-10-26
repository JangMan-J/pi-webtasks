# pi-webtasks

Three web research tools for Pi:

| Tool | Work |
| --- | --- |
| `web_search` | Find sources, read known pages, or search for people and companies. |
| `interactive_search` | Get a cited answer and continue through a local conversation reference. |
| `deep_search` | Submit background research or read its saved result through a local research reference. |

An additional codemode-only tool, `webtasks_submit`, accepts advanced SDK Task options through the same tracked completion flow.
The [advanced SDK guide](docs/advanced-sdk.md) covers custom output schemas, native options, and local research references.

Implementation and integration verification are in progress.
The [mapping](docs/api-mapping.md) separates ordinary workflows, advanced Tasks, and intentional omissions.
The [release checklist](docs/release-readiness.md) records validation and remaining blockers.
This checkout does not replace the installed extension or restart any running process.

## Development

Requirements: Node.js 22.19 or later, npm, and Pi 1.1 or later.
Advanced Task submission requires codemode.
The only runtime dependency is the pinned `parallel-web` SDK.
SQLite uses Node's built-in implementation.

```sh
npm ci
npm run check
npm pack --dry-run
```

`npm run check` runs type checks and the offline regression suite.
`PI_PACKAGE_DIR` selects another installed Pi package directory for runtime tests.
The native codemode test requires Pi 1.1 and skips with the older development fixture.
Local tests use real SQLite, private temporary artifacts, and signed loopback HTTP callbacks.
Controlled external responses support failure and recovery tests.
Those tests do not establish live provider delivery or real model navigation.
No paid research runs during the offline suite.

Retired experiments, benchmarks, handoff notes and the old nine-tool tests live in `.archive/` (git-ignored).
`npm run docs:snapshot` refreshes the Parallel docs mirror into `docs/parallel/` (git-ignored).

## Credentials

Run `/login` in Pi and choose **Parallel**. Pi offers two sign-in methods:

- **Browser sign-in** (listed under *Sign in with an account*). Pi opens platform.parallel.ai in your browser. There you approve the request for `127.0.0.1` and select an existing API key or create one. Pi receives the approval on a temporary listener on `127.0.0.1`, exchanges it for the key, and stores the key. The listener accepts one callback and closes on success, error, or cancel. After 120 seconds, Pi offers a prompt for the callback address from the browser's address bar, for example over SSH without port forwarding. The listener stays open while that prompt waits, so a browser callback can still complete sign-in.
- **API key** (listed under *Sign in with an API key*). Paste a key from the API keys page on platform.parallel.ai. Pi's prompt shows the key while you type, as its other API-key prompts do, and the entry is echoed after submit. Pi 1.1.0 has no masked prompt.

An empty entry stores nothing. Parallel adds no models, so the model picker is unchanged. The extension registers no commands.

The stored login is used first. Without one, the tools use the environment variable `_PARALLEL_API_KEY` (`PARALLEL_API_KEY` is also accepted), then the key in `.env` or `parallel.env` beside the package manifest. Exported settings take precedence over the key files.

The standalone webhook receiver has no Pi session, so `/login` does not apply to it; it uses the environment and key files only. `PARALLEL_WEBHOOK_KEY` is needed only for the optional webhook receiver. It is the signing secret, not the research key.
Credential files are not packaged or committed.

Do not install `@parallel-web/pi-extension` alongside this package. It registers a `web_search` tool, the same name as this package's tool, so the two would collide.

Balance is not shown by the extension; check the provider account directly.

Do not paste credential values into tool arguments, diagnostics, or source files.
The extension does not create accounts, keys, credit purchases, or monitors.

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

In a Pi TUI, `webtasks` publishes one colored status line for web results, interactive answers, distinct source URLs in completed deep reports' Sources indexes, and estimated Parallel API cost. Cost shows `0` until it reaches half a cent, two decimals up to $9.99, whole dollars from $10, and compact notation from $1,000. The estimate uses [Parallel's published list rates](https://parallel.ai/pricing) for successful calls and completed Task runs since this extension runtime started. It resets on reload and excludes free credits, discounts, and uncertain requests; it is not the account's billed balance.

## Session and group behavior

Startup looks up the Pi session ID and hydrates any existing group.
It never registers a fresh session or creates a remote group.
The first `deep_search` or `webtasks_submit` submission initializes one group through a shared in-flight promise.
It persists the group ID before adding Task runs, then caches it for normal submissions.
Reload and resume recover the association. Session switches do not reuse another session's cache.
Routine, entity, conversation, and reference-only calls never create groups.
Session stop aborts the outbound collector, waits for it to settle, saves accepted work, and detaches local notification handling without draining remote research.
A replacement runtime resumes collection from the stored cursor.
The backend has no group-close operation.

Research state uses the `webtasks.sqlite` store, created automatically and kept private.
`WEBTASKS_DIR` selects the directory when set. Otherwise the store is `getAgentDir()/webtasks/webtasks.sqlite`.
Earlier stores are not read or migrated. The old `~/.pi/agent/parallelized/webhooks/webhooks.sqlite` has no legacy reader. Its 2 pending registrations are accepted as lost (Manager decision, kept with the rename).
Startup is lookup-only. It writes no session row, creates no remote group, and sends no request. Ownership and resume use the research records and the session's group row.
New evidence artifacts use `getAgentDir()/webtasks/results`.
Existing accepted work and artifacts remain accessible.

## Outbound completion

Status: implemented on this branch; live acceptance is pending.
Live provider SSE and real model navigation are not verified. Offline tests use fake clients only.

`deep_search` needs only a provider key (from `/login`, or `_PARALLEL_API_KEY` / `PARALLEL_API_KEY`) and the automatic private SQLite store.
It needs no callback URL, listener, tunnel, public route, or signing secret.

A collector inside the owning Pi session watches the session's Task Group.
Each pass opens the group event stream from the stored cursor, takes a runs snapshot (no outputs) that binds matching uncertain submissions, then consumes the stream.
Each completed, failed, cancelled, or action-required run state is saved before the cursor moves.
On stream or snapshot failure it backs off from 5 seconds, doubling to a 300-second cap with jitter. The largest `retry-after` hint from the pass applies, up to 15 minutes.
A pass resets the failure streak and pauses 1 second only when its events connection made durable progress: it inserted a new outbound row, or its stored cursor ended at a value different from the one it resumed from (a group status advance counts). Replays of already-recorded events are not progress and escalate the backoff. Each events connection is bounded at 10 minutes and each snapshot at 60 seconds, so a stalled body cannot block recovery. A connection that reaches its deadline without progress takes the normal backoff; one that made progress reconnects from the cursor after the 1-second pause.
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
With `WEBTASKS_WEBHOOK_URL`, a shared `WEBTASKS_DIR`, and a running receiver (`PARALLEL_WEBHOOK_KEY`), runs also carry a per-run webhook.
The same run seen through both paths is notified once per reported status. A concurrent duplicate result fetch across processes is still possible; it is an idempotent read that can add one extra artifact, and no paid request repeats.
The receiver's shared worker can then save results while Pi is closed.
Failed result fetches are retried once when the owning session next starts. There is no manual recover command.
Loading the extension starts no HTTP listener.

A receiver installed from the earlier `pi-parallelized` checkout is not verified on this machine. Its location is absent under this account and may belong to another account. Changing files in this checkout does not update any running process.
The [webhook guide](docs/webhook-integration.md) describes the optional configuration and recovery.

## Limits

- Three directly exposed tools retain simple schemas. The additional `webtasks_submit` tool exposes SDK Task options through codemode only.
- Default effort is `low`, with no automatic escalation.
- User-selected discovery tiers are fast/basic/advanced. Deep tiers are core/pro/ultra2x.
- Responses keeps low/medium/high. URL reading and entity lookup reject explicit effort.
- Saved tier evidence does not establish universal quality or latency ordering.
- Native Fast Entity Search is included. New async FindAll create, extend, and enrich workflows are excluded.
- Caller-defined Task output schemas are available through `webtasks_submit`.
- SDK processors outside the ordinary tiers mark the estimated status subtotal with `+?` for an unknown additional amount.
- Result retrieval does not generate a missing alternative format.
- Complete redacted evidence stays on disk even if previews omit content.
- Paid submissions never retry automatically after uncertain acceptance.
- Collection runs only while the owning session is open, unless the optional receiver is deployed.
- Live provider SSE and model-navigation checks remain necessary before claiming full research acceptance.

The [effort review](docs/effort-qualification.md) records saved evidence and its limits.
The [historical README](docs/legacy-interface.md) preserves the old interface for comparison.
