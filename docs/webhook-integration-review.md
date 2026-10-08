# Parallel webhook integration review

Date: 2026-09-21 UTC. Status: research complete, **implementation complete** (opt-in, off by default).
Runtime code, operational steps, delivery-guarantee wording, and test evidence for the design proposed
in this document now live in [docs/webhook-integration.md](webhook-integration.md); this file remains
the unmodified research record. Unresolved items in "Evidence and remaining unknowns" below are still
unresolved \u2014 they require a live account signing secret and a real delivery, which this integration
work did not attempt (no secret was created, retrieved, or rotated).

## Scope and panel

The user requested first-party Grok 4.6, Opus 5, and Gemini 3.8 Flash to review callbacks, signing secrets, and beta features.
All three completed independent reviews. Grok completed the final comparison after an interrupted judge attempt. Successful research was not repeated.

- Grok: `xai/grok-4.6`, run `e6742b9c7b124ff18d11e984ef3372ec`.
- Opus: `anthropic/claude-opus-5`, run `6429ef79d72148548833bc4f6d6d3e57`.
- Gemini: `antigravity/gemini-3.8-flash`, run `80a5f6557ee64a4cba290b9d2059811e`.
- Final judge: `7f1f1c005fe14fc5a5514ced7f3089e6`.

Sources included current official documentation, public OpenAPI specifications, parallel-web 1.3.3, CLI 0.9.3, and local extension code.
The panel reused the documentation snapshot under `~/.cache/pi-parallelized/parallel-docs/2026-09-20-current` and checked decisive pages against live sources.
Main independently extracted seven official pages and inspected the supplied receiver and notes.

No task, FindAll run, monitor, signing key, or public receiver was created or changed. No browser was used.
Public documentation extraction and two read-only Memory requests were made. The output-format work remains unchanged.

## 1. Which APIs can replace polling with callbacks?

Search is synchronous. It has no documented webhook field. A blocked or slow Search HTTP request cannot become a Parallel webhook subscription.
Extract is also synchronous. Responses supports direct responses or SSE, not webhook delivery.
Long-running research belongs on Task when that API fits the requested work. Moving a Search request to Task changes service semantics and cost.

| API | Callback support | Notification and next action |
|---|---|---|
| Search: `POST /v1/search` | None documented | Consume the HTTP response. |
| Extract: `POST /v1/extract` | None documented | Consume the HTTP response. |
| Responses: `POST /v1/responses` | None documented | Consume the response or SSE stream. Background mode is unsupported. |
| Task: `POST /v1/tasks/runs` | Per run | `task_run.status`, then fetch the successful run's result once. |
| Task Group | Per run, not per group | Set each input's webhook during add-runs. Correlate the resulting Task notifications locally. |
| FindAll: `POST /v1beta/findall/runs` | Per run | Terminal run events and candidate events. Fetch the result snapshot after completion. |
| Entity Search: `POST /v1beta/findall/entity-search` | None documented | Fast synchronous people/company results. |
| Monitor: `POST /v1/monitors` | Per monitor | Detected event supplies `event_group_id`. Retrieve that event group. |
| Memory: `POST /v1beta/memory/*` | None documented | Direct retrieval or explicit management requests. |

The [Task guide][task] says `task_run.status` is emitted when a run completes, with success or failure.
Its payload is the Task Run object, not the answer. Successful completion needs `GET /v1/tasks/runs/{run_id}/result`.
The proposed handler reports failure notifications without a success-result request.

[FindAll][findall] currently emits these webhook types:

- `findall.candidate.generated`, `findall.candidate.matched`, `findall.candidate.enriched`.
- `findall.run.completed`, `findall.run.cancelled`, `findall.run.failed`.

The schema also accepts candidate `unmatched` and `cancelled`, but the guide says V1 does not emit them.
Some candidate events contain output and basis. Terminal run events contain status and metrics rather than the complete result.
For completion-only integration, subscribe to terminal events instead of every candidate event.

[Monitor][monitor] supports `monitor.event.detected`, `monitor.execution.completed`, and `monitor.execution.failed`.
Use the detected event's `event_group_id` in `GET /v1/monitors/{id}/events?event_group_id=...`.
A no-change completion needs no result lookup. Monitor creation still requires the user's explicit recurring-observation request.

## 2. Signing secrets without a browser

No supported signing-secret creation, retrieval, or rotation endpoint was found in the inspected public documentation, SDK, CLI, or Account API specification.
This is not proof that no private dashboard endpoint exists. Private endpoint discovery was not attempted.

The documented interface is **Settings → Webhooks**. The [setup guide][setup] says:

> Go to Settings → Webhooks to view your account webhook secret.

The [roles table][roles] explicitly grants members permission to:

> Reveal and copy active webhook signing secrets.

Admins can create and rotate them. Therefore, the supplied local note's claim that secrets are unavailable after creation conflicts with current documentation.
Dashboard re-viewing and programmatic API retrieval are different capabilities.

The [Account API specification][account] covers balances, applications, and application API keys. Those keys are not webhook signing secrets.
Generating a random local `whsec_` value does not register it with Parallel or authenticate their deliveries.

The supported headless integration accepts an existing secret through an environment variable or secret store.
A missing secret must disable trusted automation. It must not silently enable unverified completion handling.
No real secret was obtained or rotated during this review.

## 3. Verification, retries, and the supplied receiver

The [setup guide][setup] defines:

- HMAC-SHA256 over `webhook-id.webhook-timestamp.raw-body`.
- Standard key decoding: remove `whsec_`, then Base64-decode the remainder.
- Space-separated `v1,<signature>` values during rotation. Accept a valid matching signature, regardless of its position.
- Initial retry delay of five seconds, exponential backoff, and attempts over 48 hours.
- Duplicate detection through `webhook-id`.

A five-minute timestamp window is the current receiver's policy, not a Parallel-specific documented mandate.
Timestamp freshness and duplicate retention are separate controls. Keep duplicate records for at least the delivery retry horizon, with a margin.

The guide also documents a legacy scheme that uses the entire secret, including `whsec_`, as the raw HMAC key.
The documented recommendation for new integrations is the standard scheme. Explicit legacy compatibility can support older accounts without guessing from a Base64 decode failure.

### Supplied files

- `/home/jangpi/JangLabs/transcript-dist/tools/webhooks.md`
- `/home/jangpi/JangLabs/transcript-dist/tools/webhook-receiver.py`

The receiver logs deliveries and returns HTTP 200 after writing a record. It does not fetch results or notify a Pi session.
It records missing-secret and invalid-signature deliveries rather than rejecting them. This is useful diagnostic behavior, not a trusted automation boundary.

Its fallback strips `whsec_` before encoding raw bytes. It therefore does not implement Parallel's documented legacy whole-secret scheme.
The TypeScript verifier in `src/webhook.ts` also implements the standard scheme only.

The Python log does not retain the exact raw request body, timestamp header, and signature header together.
Previously unverified log records therefore cannot be authenticated later merely by adding a secret.
The receiver flushes the log but does not call `fsync`. HTTP 200 is not a demonstrated crash-durable acknowledgement.

The local note reports approximately 13–30 seconds from creation to delivery. It does not establish delivery latency after completion.
It also recommends polling in some cases. The present user's no-polling instruction supersedes that recommendation.
Current listener, Funnel, secret configuration, and reboot persistence were not re-probed or changed.

## 4. Concrete extension gaps

| Location | Observation | Integration consequence |
|---|---|---|
| `src/ops.ts:138–143` | `webhook()` can send a URL without event types. | Default Task to `task_run.status` or validate before dispatch. Prior live evidence records HTTP 422 when omitted. |
| `src/index.ts:243`, `src/ops.ts:470–493` | Group exposes `webhook_url`, but does not apply it to run inputs. | Apply it as an explicit per-input default on add-runs, or reject unsupported use. Do not imply group-level callbacks. |
| `src/ops.ts:574–592` | FindAll result waits poll unless `wait_seconds: 0`. | The callback path must use a single snapshot request. |
| `src/ops.ts:401–423` | Task result errors trigger a status lookup. | A strict callback path needs one-shot retrieval without this fallback status request. |
| `src/webhook.ts` | Standard verification exists, but no receiver, duplicate store, or session notification path exists here. | Verification alone does not integrate asynchronous completion. |

The public OpenAPI and SDK reuse a Task webhook enum for FindAll despite the separate FindAll event guide.
They also allow omitted `event_types` where the guides require it. Do not derive all runtime validation from those stale types.
The previous measured Task 422 supports explicit event selection, but this review did not create a new run to reproduce it.

## 5. Minimal event-driven integration

Proposed flow:

```text
Create async run with callback and no wait
  → save run ID and owning Pi session locally
  → receive callback
  → verify signature and validate event/resource ownership
  → persist and deduplicate event
  → acknowledge receipt
  → fetch successful result once, outside the HTTP handler
  → save normal result artifact
  → notify the owning Pi session
```

1. Reuse one receiver rather than start competing listeners in every agent session.
2. Use a durable inbox with a unique `webhook-id`, event state, and a local run-to-session mapping.
3. Acknowledge only after verified events enter that inbox. Unverified diagnostic records must not trigger API calls or model turns.
4. Consume inbox changes through an event-driven subscription or file watcher, with startup recovery. Do not poll research status or tail files repeatedly.
5. Task success fetches the result once. FindAll completion fetches one snapshot. Monitor detection fetches one event group.
6. Failed or cancelled notifications record their terminal state instead of starting a result-wait loop.
7. Store the result before marking the event handled. Preserve failed fetches for explicit retry without recreating the research run.
8. Deliver a compact artifact notification to the owning session. If that session is closed, keep the completion available for recovery.

Only a known locally registered resource can authorize an automatic result fetch. A signed callback alone does not establish session ownership.
Do not replace valid Search/Extract calls with Task merely to obtain callbacks.
Keep signature work and inbox handling in code rather than exposing a model-driven verification step.

Recommended defaults are the minimum needed events: Task completion, FindAll terminal events, and Monitor detection/failure as appropriate.
Candidate streams and no-change execution notifications remain explicit choices in this design to avoid unnecessary agent wakeups.

### Acceptance checks

- Omitted Task event types become `task_run.status` before any network request.
- Group callback configuration reaches each intended input without overwriting an explicit per-run setting.
- Rotation signatures work in any position. Invalid, stale, malformed, and missing-secret requests never trigger automation.
- Synthetic standard and explicit legacy signatures use distinct, correct key derivations.
- Duplicate deliveries, including delayed retries, cause no duplicate result fetch or notification.
- Unregistered resources and wrong-session mappings cause no fetch.
- Successful Task, FindAll, and Monitor fixtures each produce one expected retrieval and zero status polls.
- Failure/cancellation fixtures produce no success-result request.
- Restart recovery preserves pending completions and result artifacts without repeating paid creation requests.
- Secrets never appear in receipts, logs, tool arguments, or model context.

A real signed delivery remains the final live integration check. Synthetic tests alone cannot establish account-specific signing compatibility.

## 6. Beta features and account access

### Memory

[Memory documentation][memory] says rollout is gradual and enabled by default for some newly created organizations.
Public documentation and a registered tool do not guarantee account entitlement.

Main made two read-only probes using the active extension credential:

| Probe | Response |
|---|---|
| Retrieve without a scope | HTTP 403: `Requests with an app API key must include a memory_scope_key.` |
| Retrieve with `memory_scope_key: pi_parallelized_webhook_review` | HTTP 403: `Memory is not available for this account yet.` |

This establishes that the active app credential/account cannot use Memory now. It does not establish the state of other accounts or credentials.
An empty successful result does not establish missing entitlement. These probes returned explicit errors instead.

### Fast Entity Search and FindAll

[Entity Search][entity] is the documented fast, synchronous people/company interface. It uses `/v1beta/findall/entity-search`.
It returns one result set without pagination. The documented maximum is 1,000 matches.
The extension already exposes it through `parallel_findall` with `action: entity_search`.

No separate product named `rapid-find-all` was found in the inspected documentation, specifications, SDK, or CLI.
A UI alias or account-specific feature remains possible. Neither interpretation was established.
FindAll's `preview` generator is still an asynchronous run, not Entity Search.

The [FindAll migration guide][migration] says `findall-2025-09-15` remains accepted but no longer changes behavior.
The `/v1beta/findall` path remains correct despite V1 processing becoming the default.

### Other surfaces

- [Per-element research basis][basis] graduated on August 24, 2026. The documented recommendation is to omit `field-basis-2025-11-25`.
- [Chat Completions][chat] remains documented at `/v1beta/chat/completions`. It is not a callback API.
- SDK beta enums include `mcp-server-2025-07-17`, `events-sse-2025-07-24`, `webhook-2025-08-12`, and `search-extract-2025-10-10`.
- An enum member alone does not establish a new entitlement or active experiment.
- Current webhook examples omit the webhook beta header, but that omission does not prove the server no longer requires it.

The panel found evidence of staged Memory availability and feature graduation, not evidence sufficient to identify specific A/B experiments.
Live doc equality also cannot rule out account-specific behavior elsewhere.

## Evidence and remaining unknowns

Saved local evidence: `.pi/research/webhooks/2026-09-21/`.
It contains the official-page extraction and both Memory error artifacts. The run IDs in [Scope and panel](#scope-and-panel) retain the independent reviews.

Unresolved items:

- A supported browser-free signing-secret API, if Parallel offers one outside the inspected public surfaces.
- This account's real signing scheme and a verified live delivery.
- Server behavior for FindAll webhook event names despite the stale shared schema.
- Whether the webhook beta header is still required.
- The exact feature behind the user's `rapid-find-all` label.

These do not justify guessing endpoints, creating recurring monitors, rotating secrets, or automatically retrying paid research.

[setup]: https://docs.parallel.ai/resources/webhook-setup.md
[roles]: https://docs.parallel.ai/resources/organization-roles-and-permissions.md
[task]: https://docs.parallel.ai/task-api/webhooks.md
[findall]: https://docs.parallel.ai/findall-api/features/findall-webhook.md
[monitor]: https://docs.parallel.ai/monitor-api/monitor-webhooks.md
[memory]: https://docs.parallel.ai/resources/memory.md
[entity]: https://docs.parallel.ai/findall-api/entity-search.md
[migration]: https://docs.parallel.ai/findall-api/findall-migration-guide.md
[basis]: https://docs.parallel.ai/task-api/guides/access-research-basis.md
[chat]: https://docs.parallel.ai/api-reference/chat-api-beta/chat-completions.md
[account]: https://api.parallel.ai/account/service/openapi.json
