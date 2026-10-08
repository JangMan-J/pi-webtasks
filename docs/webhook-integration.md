# pi-webtasks webhook integration

> Note: deep research completes through outbound Task Group SSE with polling fallback inside the owning session; see [outbound completion](api-mapping.md#outbound-completion).
> Webhooks are optional. This guide applies only when you choose to run the signed receiver.
> Live provider SSE is not yet verified.

This optional integration connects signed callbacks to the Pi session that created each resource.
It is off by default. Loading the extension starts no HTTP listener.
The implementation follows the current [Task webhook guide](https://docs.parallel.ai/task-api/webhooks) and [verification guide](https://docs.parallel.ai/resources/webhook-setup).
The older [research review](webhook-integration-review.md) records historical findings, not the current setup procedure.

## Components

- `src/webhook-receiver.ts`: one shared HTTP receiver, with signature verification and a bounded request body.
- `src/webhook-inbox.ts`: a private SQLite inbox, resource ownership records, duplicate detection, and processing claims.
- `src/webhook-consumer.ts`: event-driven result retrieval and pending notifications.
- `src/index.ts`: resource registration, session lifecycle, notification delivery, and the `/webtasks` command.

The receiver stores authenticated events before it acknowledges them.
A callback can arrive before the creation response. The consumer retains it until the local resource registration appears.
Only the owning session can retrieve and receive that resource's result.

## Configuration

The receiver and Pi must use the same `WEBTASKS_DIR`.
The default location is `<agent-dir>/webtasks`.
The directory is explicit so separate profiles do not accidentally share a store.

| Setting | Used by | Meaning |
| --- | --- | --- |
| `WEBTASKS_DIR` | Receiver and Pi | Store directory shared by the receiver and Pi. Default `<agent-dir>/webtasks`. The standalone receiver requires it. |
| `WEBTASKS_WEBHOOK_URL` | Pi | Optional public callback URL for new Tasks, Group runs, FindAll runs, and Monitors. |
| `PARALLEL_WEBHOOK_KEY` | Receiver | Existing account signing key, under the provider's name. Not a Parallel API key. |
| `WEBTASKS_WEBHOOK_SCHEME` | Receiver | `standard` by default. Use `legacy` only for the documented legacy scheme. |
| `WEBTASKS_WEBHOOK_PORT` | Receiver | Port number, default `8787`. |
| `WEBTASKS_WEBHOOK_PATH` | Receiver | Request path, default `/webtasks/webhook`. |

The default path changed with the rename. A public route that still forwards to `/parallel/webhook` must set `WEBTASKS_WEBHOOK_PATH=/parallel/webhook`, or be re-pointed to `/webtasks/webhook`.

Provide the signing secret through the receiver's environment or a secret manager.
Do not put it in tool arguments, source files, or a model conversation.
The programmatic receiver also accepts an array of secrets for rotation.
The receiver and extension read `.env` and `parallel.env` beside the package manifest.
Existing environment variables take precedence, including explicit empty values.

Start one shared receiver:

```sh
npm run webtasks:receiver
```

The standalone receiver binds `http://127.0.0.1:8787/webtasks/webhook` by default.
It does not create a public route, tunnel, or hosted endpoint.
An independently configured public HTTPS route must forward Parallel's callbacks to this receiver.

Set `WEBTASKS_WEBHOOK_URL` to the public HTTPS URL, including the receiver path.
Start a new Pi process with the same configuration.
New research calls then use this callback without a model-supplied URL.
An explicit `webhook_url` overrides the default. `webhook_url: null` disables the callback for that call.
Monitor updates do not inherit the creation default. An update with `webhook_url: null` removes the existing callback.

Task creation defaults to `wait_seconds: 0` and returns immediately.
When the preview budget permits, a creation receipt reports local webhook registration.
The callback saves the completed result and queues a session follow-up. Status polling is not necessary.

Example `.env` configuration, with an independently configured public route:

```dotenv
WEBTASKS_WEBHOOK_URL=https://research.example.com/webtasks/webhook
WEBTASKS_DIR=/absolute/private/path/webtasks
WEBTASKS_WEBHOOK_PORT=8787
WEBTASKS_WEBHOOK_PATH=/webtasks/webhook
```

The receiver requires a separate signing secret. It never accepts unsigned deliveries as successful callbacks.
A service manager can run `node src/webhook-receiver.ts` from the package directory.
One shared receiver serves all local Pi sessions that use its inbox.

## Registration and events

Task creation registers the returned run ID under the calling Pi session.
Group addition registers returned Task IDs with their applicable per-input webhook settings.
FindAll creation and preview register the returned FindAll ID.
Monitor creation registers the returned Monitor ID and still requires an explicit recurring-observation request.

Group registration reads complete saved creation responses, not the bounded preview's sampled identifiers.
A registration failure retains the paid creation result and exposes a diagnostic. It does not resubmit the request.

Every webhook request includes `event_types`.
Task defaults to `task_run.status`. FindAll defaults to run completion, cancellation, and failure events.
Monitor defaults to detection, execution completion, and execution failure events.
Explicit `webhook_events` overrides these defaults. Group inputs receive the Task default unless they supply their own subscription.
Current Task webhooks do not require `parallel-beta: webhook-2025-08-12`.

| Event | Result retrieval |
| --- | --- |
| `task_run.status`, completed | One Task result request |
| `task_run.status`, failed or cancelled | None. Record the failure. |
| `findall.run.completed` | One FindAll result snapshot |
| `findall.run.failed` or `findall.run.cancelled` | None. Record the failure. |
| `monitor.event.detected` | One request for the supplied event group |
| `monitor.execution.failed` | None. Record the failure without retiring the Monitor. |
| Candidate events, no-change execution, unknown or nonterminal events | No result request |

The payload fields follow the saved official Task, FindAll, and Monitor webhook examples.
Search, Extract, and Responses do not gain callback support through this integration.

## Recovery and notification

The consumer watches local inbox changes and performs startup recovery. It does not poll Parallel status endpoints.
Each result request is bounded and uses no automatic SDK retry.
A failed fetch remains saved until an explicit retry. Inbox writes must not cause a retry loop.

- `/webtasks status` reports store and session ownership counts.
- `/webtasks recover` retries this session's failed retrievals and processes pending completions.
- A closed session retains its pending work for a later resume.
- Each Monitor detection has its own notification state, so later events do not replace earlier notifications.

The extension saves a normal redacted result artifact before it records successful handling.
It acknowledges notification delivery only after the notification succeeds.
Notifications appear in the transcript and queue a follow-up with `triggerTurn: true`.
An idle owning session resumes automatically. An active session receives the follow-up after its current work.
When a closed session resumes, it receives its pending notification.

## Guarantees and limits

SQLite transactions enforce duplicate detection by `webhook-id` and protect resource ownership.
Handled duplicate records remain for at least 72 hours, beyond the documented 48-hour retry horizon.
Pruning removes only handled and notified entries after 72 hours; unmatched callbacks and unacknowledged notifications remain retained.
A run reported by both a callback and the outbound stream is notified once per reported status. Once a notice is acknowledged, a later entry for the same run and status is acknowledged without a second notice. A completion after `action_required` is a separate notice.
Two processes can still fetch the same result concurrently. That fetch is an idempotent read and can add at most one extra artifact; no paid request repeats.
Invalid signatures, malformed secrets, invalid UTF-8, and oversized requests cannot enter the authenticated inbox.

Result retrieval and notification are not an atomic transaction with the external service or Pi.
A crash after either side effect but before its local acknowledgement can cause repetition on recovery.
The consumer never repeats paid creation calls.
This is not an exactly-once notification guarantee.

A live Task check passed through the public HTTPS route on 2026-09-24.
The standard signature passed verification. The consumer made one result request and queued one session follow-up.
The live probe captured the Pi notification call without invoking a model. FindAll and Monitor delivery checks use offline fixtures.
Group ID-to-input association assumes that returned IDs follow input order.
The public add-runs schema describes newly created IDs but does not explicitly guarantee their order.
A live mixed-webhook batch is the deciding check for that association.
A deployment on another account or route needs its own signed delivery check.

## Verification

Run all offline checks:

```sh
npm run check:all
```

The webhook suites cover signatures, actual loopback HTTP requests, SQLite concurrency, process restart, ownership, and explicit retry.
The lifecycle suite exercises registered tools and hooks through creation, callback, result retrieval, and session notification.
All service responses in those tests are fixtures. No paid API request is necessary.
