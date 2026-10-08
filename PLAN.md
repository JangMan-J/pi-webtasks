# pi-webtasks: corrected three-tool plan

Status: implementation authorized. Tool coverage remains subject to [the mapping review](docs/api-mapping.md).
Installation, publication, and changes to the running receiver remain separate.
Outbound completion and existing SQLite persistence are the design direction.
Latest user decision ("switch us over") supersedes the earlier webhook-first decision.
`deep_search` completes through outbound Task Group SSE with bounded background polling fallback, and mandatory webhooks are removed.
This is implemented on branch `feature/outbound-completion`; live acceptance is pending.
Live provider SSE and real model navigation are not verified. Only offline tests with fake clients exist.

## 1. Target and scope

Build an agent-facing web research extension with three tools:

- `web_search`: find sources or read known pages.
- `web_search` also provides native synchronous people/company search through an explicit entity selector.
- `interactive_search`: obtain a cited answer and continue that conversation.
- `deep_search`: submit substantial research, receive completion in the background, and reuse saved research.

The tools describe the user's work, not the backend's product taxonomy.
They must hide operation dispatchers, processor names, remote IDs, transport controls, and collection mechanics.

Implementation belongs in this checkout. Leave `~/Projects/JangLabs/pi-parallelized` and its unfinished work untouched.
Do not change the installed extension, Pi settings, credential stores, or host runtime as part of this plan.
Installation, publication, and broader benchmarking are separate work.

## 2. Requirements recovered from the user

The following are requirements, rather than choices made by the previous agent.
The source references appear in section 10.

| Requirement | Evidence |
| --- | --- |
| Minimize the primitives that agents must learn without adding material friction. | S1, line 6 |
| Use `web_search`, `deep_search`, and `interactive_search`. | S1, lines 355 and 362 |
| Abstract the whole research interface behind three calls with names independent of the backend. | S1, line 365 |
| Exclude monitoring unless explicitly requested later. | S1, lines 370–371 |
| Express processor selection through reasoning-like effort using the user-confirmed tier mapping. | S1, line 397, superseded tier choices in the supplied screenshot and confirmation. |
| Hydrate the existing group in the start hook. Initialize and persist it only on the first deep submission. | Latest user decision supersedes eager creation at session start. |
| Use the stop hook for local cleanup, without claiming remote closure. | Current review decision follows the live status probe. |
| Drop lower-value tiers within a latency band, unless they provide a distinct benefit. | S1, line 418 |
| Validate navigation on different real agent models and scenarios, using real research services. | S1, lines 35 and 41 |
| Use the credential names already deployed on this system. | S3, line 140 |
| Build around webhook delivery. | Superseded by the latest user decision: outbound Task Group SSE with polling fallback, webhooks optional. The earlier review's praise of webhooks and the SQLite reuse remain as history. |

Historical permission to spend does not authorize unrelated experiments.
The later user explicitly stopped unnecessary spending in S3, lines 229 and 232.
The user separately authorized the two-group status probe during review.
Do not start further paid work without implementation authorization or another explicit experiment request.

## 3. What exists, and what does not

Historical baseline context, describing the checkout before this branch (not the current state):
this checkout had no commits and still identified itself as `pi-parallelized`.
Its `src/index.ts` matched that file at the other checkout's committed baseline, `f8da751`.
It registered the original low-level tools, not either replacement interface.

The other checkout contains a different, uncommitted state:

- The rejected two-tool implementation remains in `src/index.ts`.
- `.pi-herdsman/three-search-contract.md` records a three-tool contract.
- README and reference documents describe that contract as implemented.
- `src/effort.ts` contains provisional mappings.
- `src/ledger.ts` stores JSON records but does not implement dispatch, collection, delivery, or lifecycle cleanup.
- The three-tool harness passed an offline selfcheck, not real three-tool acceptance.

Do not import the dirty tree wholesale or copy its completion claims.
Reuse individual helpers only after checking their behavior against this plan.
Leave rejected evaluations and unrelated research in the original checkout.

## 4. Proposed tool contracts

These field choices are proposals. The user chose three primitives, not these exact schemas or defaults.
All objects reject unknown fields and invalid input before a paid request.

### `web_search`

```text
query?: string
urls?: string[]
domains?: string[]
entity?: "people" | "companies"
effort?: "low" | "medium" | "high"
```

Require a nonblank query, known URLs, or both.
A query finds sources. URLs select page reading, with the query supplying optional focus.
Return readable evidence, source URLs, and the saved artifact.
An entity selector with a query uses native Fast Entity Search.
Entity search rejects URLs and domains, requires no group or callback, and uses the documented default of 100 results.
It returns people/company names, canonical URLs, and descriptions at the published $0.005 request price.
It does not expose new async FindAll creation, expansion, matching configuration, or enrichment.
Keep legacy FindAll recovery for already accepted work.

Discovery maps low/medium/high to fast/basic/advanced, with low as default.
URL reading and Fast Entity Search reject explicit effort because those branches are untiered.
Do not expose backend modes or add an extra model call to translate every query.
Map the query to the existing discovery helper's objective and search query.
Even when the tool returns a bounded preview, retain full extracted content on disk.

Proposed rule: reject `domains` with explicit URLs instead of silently ignoring the restriction.
Keep retrieval limits internal and follow verified service limits.

### `interactive_search`

```text
question: string
conversation?: string
effort?: reasoning-like level
domains?: string[]
```

Return the cited answer, an opaque local conversation reference, and the saved artifact.
A follow-up resolves that reference internally.
Use an immutable reference for each response so concurrent follow-ups do not overwrite their parent.

This is the conversational path, not an operation selector or a disguised background job.
Preserve partial answers and any known continuation ID on failure.
Never automatically repeat an uncertain paid request or switch to deep research.

### `deep_search`

```text
query?: string | string[]
research?: string
effort?: reasoning-like level
domains?: string[]
```

Require a query, a research reference, or both.

| Input | Meaning |
| --- | --- |
| Query | Submit new work to the session's group. |
| Query array | Submit independent briefs to that same group. |
| Reference only | Read saved evidence or a bounded recovery snapshot. Do not submit work. |
| Query and completed reference | Submit an explicit follow-up grounded in the saved research. |

Return after dispatch and durable tracking, without waiting for remote completion.
Complete each submitted run through the outbound collector described in [outbound completion](#outbound-completion).
Persist and deliver results through the existing inbox pipeline.
A per-run webhook is attached only when optional webhook configuration exists.
Keep transport configuration outside the model-facing fields.
A pending or incompatible reference must not silently become a new paid submission.
Reject submission settings on reference-only reads rather than implying that they alter existing work.

Reports, comparisons, and structured-list goals belong in the brief.
People/company discovery uses the explicit native entity branch in `web_search`.
Do not recreate the backend's discovery and enrichment stages as public action fields.
Qualify these goals against real outputs before claiming feature equivalence.

### Shared interface rules

- Register exactly these three model tools. No low-level aliases, activator, or control/list wrapper.
- Keep remote handles in internal records and diagnostic artifacts, not normal tool instructions or result control fields.
- Use local references and artifact paths in completion messages.
- Preserve citations, partial evidence, errors, and usable saved-file pointers.
- Keep existing human authentication, balance, and legacy recovery commands where needed.
- Do not invent new account-management commands or a monitor surface.
- Measure the rendered schemas and instructions. Do not claim token savings from shorter names alone.

## 5. User-confirmed effort policy

The user supplied a tier screenshot and confirmed this exact policy:

| Public effort | Discovery | Interactive answer | Deep research |
| --- | --- | --- | --- |
| low, default | fast | low | core |
| medium | basic | medium | pro |
| high | advanced | high | ultra2x |

Extract and Fast Entity Search remain untiered.
Explicit effort on those branches is rejected before a request.
Use one small internal policy constant and never escalate automatically.
This user decision supersedes fixed-fast, base/core/pro, and reduced-tier proposals.
No further experiment is needed to select the policy.
Keep behavior qualification separate from the user's selection.

Historical saved evidence:

| Path | Observed timings | Evidence limit |
| --- | --- | --- |
| Discovery | Turbo about 0.4–0.5 seconds, fast about 0.9–1.4 seconds, basic/advanced about 1.0–2.3 seconds. | Three questions with repeats. Ranking and coverage vary by question. |
| Conversation | Initial low/medium/high answers took about 8.7, 17.0, and 72.4 seconds. | One question. All were cited, with similar phrase coverage. |
| Deep research | Core/base/pro created-to-modified times were about 66.4/107.8/95.5 seconds. | One objective and one run per tier. |

The probe's deep `observed_ttu_ms` values are all about 108.6 seconds.
It fetched outputs after the group drained, so those values contain collector delay.
Result-fetch latency is also not research completion latency.

These measurements do not establish universal quality or latency ordering.
Do not use one easy question to override the confirmed choices.
Acceptance still records source support and separate dispatch, completion, persistence, and delivery timing.
Do not expose processor strings or add an arbitrary budget framework.

## 6. Session start and stop hooks

### Ownership

Key durable research ownership by Pi's `sessionManager.getSessionId()`.
Reuse the saved group across reload and resume.
A new or forked session gets its own group.
An assistant turn ending does not detach collection.
Do not maintain a registry of every Pi session.
Only a session that submits deep research gets a durable session/group association.

Groups organize submissions and result snapshots.
Completion is per run, observed through the group's outbound event stream with a runs-snapshot fallback.
They do not provide an execution lifecycle that the extension must close.
The old runtime-lifetime closure contract is superseded by the start/stop hook decision.

### Session start

1. Resolve the Pi session ID and look up its existing research state.
2. Hydrate the per-session runtime group ID if a saved group exists.
3. Attach the session's local inbox consumer and deliver saved, undelivered outcomes.

Startup is lookup-only for groups: it never creates a group and sends no request. It records one local metadata row per started session (ID, working directory, artifact directory) in the existing store.

### First deep submission

Validate the entire submission and provider credentials before remote work.
When the runtime group ID is missing, await one shared initialization promise for that session.
Persist the research initialization intent, create the group, save its ID, then populate the runtime cache before adding tasks.
Concurrent initial submissions must not create competing groups.
Normal submissions reuse the populated cache without repeating group setup or a DB lookup.
Routine search, conversation, and reference-only reads bypass group initialization.
Reset or rebind the cache on session switch and reload.
New calls select processors per submitted task.
The group itself has no processor setting.
A group setup failure must leave a clear research-tool error without disabling unrelated Pi work.
`deep_search` needs only provider credentials and the automatic private SQLite store.
No callback URL, listener, tunnel, public route, or signing secret is required.
Routine search and conversational research remain independent of deep-research setup.

### Session stop

1. Prevent new submissions through the outgoing runtime.
2. Save accepted run IDs, results already received, delivery state, and unresolved submission records.
3. Abort the session's outbound collector and wait for it to settle before the store closes, then stop local notification callbacks.
4. Release its runtime ownership without discarding the saved group or closing the remote group.

Handle in-flight dispatch separately from research execution.
Preserve an interrupted or unresolved dispatch as uncertain rather than creating a replacement task.
Do not wait for all remote research to finish merely to stop the session.
The outbound collector runs only inside the owning Pi session, so collection pauses while Pi is closed.
On startup it reconciles registered pending jobs, and completions that happened while closed are found by the startup snapshot.
Pending notifications are delivered when the owning session resumes.
An optional signed-webhook receiver with a shared store can still save results while Pi is closed.
Do not promise results beyond account retention.

Reload performs this local stop, then startup reattaches the same group to the replacement runtime.
A resumed session can add tasks to its existing inactive group.
Do not use a local `CLOSED` flag to imply that the remote group rejects further additions.

### Verified limits

The live probe accepted create bodies containing `status.is_active: true` or `false`, but ignored the requested value.
Adding a task changed each group's status to active.
Completion changed it back to inactive.
PATCH status attempts were rejected, and the documented group interface has no close operation.

Do not equate `is_active: false` with successful completion.
Persist failed, cancelled, uncertain, and action-required outcomes explicitly.
Processor choice belongs to individual runs, not the group.
Published pricing lists no separate group-creation fee.

Pi awaits normal shutdown hooks but catches their exceptions and continues teardown.
Report persistence failures without claiming that cleanup succeeded.
Hard kills, crashes, and emergency terminal exit can bypass the stop hook.
Persist submission intent before dispatch so recovery does not depend solely on normal shutdown.

## 7. Persistence, uncertainty, and delivery

### SQLite state and evidence files

Reuse `node:sqlite` and the transactional pattern in `src/webhook-inbox.ts`.
Extend the configured shared store for session groups, submissions, research references, conversation references, and delivery state.
Preserve existing webhook events, registrations, claims, and ownership checks.
This state layout is a design proposal that reuses the existing SQLite implementation.
Do not add a second JSON ledger or a new database dependency.
Schema changes must preserve legacy pending jobs and support the receiver and Pi consumers during migration.
Keep undelivered notification state independent of webhook deduplication retention.
Pruning must never erase a notification that its owner has not acknowledged.
Apply that rule to migration-era consumers, not only to the new shared worker.

Keep large, redacted evidence artifacts as files.
Commit their paths and result state only after successful artifact writes.
Use restrictive permissions, bounded reference validation, and owner-specific paths derived from `getAgentDir()`.
SQLite transactions cannot make remote dispatch or Pi notification exactly once.

### Dispatch

Reuse `src/results.ts`, `src/evidence.ts`, and the appropriate operation helpers.
Keep backend details behind a small research module, not another public dispatcher.
Add only the state and delivery behavior that the three tools need.

Before dispatch, persist the submission intent.
After acceptance, persist the returned resource identity before reporting acceptance.
Disable automatic retries on paid creation/addition and uncertain conversational requests.
Use safe retrieval to reconcile uncertainty. If reconciliation cannot establish acceptance, report it without creating replacement work.

When optional webhooks are configured, set the same callback and event subscription on every group input.
There is no group-level webhook or group-level processor setting.
Correlate events and callbacks through run IDs and persisted ownership, not through arrival order.
Events that arrive before registration remain pending or quarantined until the matching registration is available.
Do not finalize an unresolved submission merely because a local grace period expires.
Late registration must allow reprocessing after a crash or delayed dispatch reconciliation.
Keep unmatched events non-routable until ownership is established.

### Outbound completion

Contract basis: [Task Group API](https://docs.parallel.ai/task-api/group-api) and installed `parallel-web` 1.3.3.
`GET /v1/tasks/groups/{id}/events` streams `task_group_status`, `task_run.state`, and `error` events.
Run events carry no output, so the result is fetched separately.
Resumption uses `last_event_id`; the SDK stream does not reconnect on its own.
The documented maximum stream duration is one hour.
`GET` status, result, and events requests are documented as not counted against the create rate limit, but the collector still backs off.

```text
Submit run (per-run webhook only if optionally configured)
  -> open group events stream from the stored last_event_id (10-minute connection bound)
  -> reconcile with group runs snapshot (getRuns, no outputs; 60-second bound)
  -> bind uncertain submissions whose run metadata matches; record settled runs
  -> consume the events: record each settled run state, then advance the cursor
  -> existing inbox pipeline claims the event and fetches the result once
  -> save evidence, record outcome
  -> notify the owning session, or retain the notification for resume
```

Rules:

- The collector runs inside the owning Pi session's runtime. There is no new daemon.
- A snapshot binds an uncertain submission only when its run metadata (`webtasks_ref`, session, group) matches. It binds a dispatching submission only when that record was created before this runtime started, so a dispatch in flight in this runtime is never bound by the collector. Binding never rebinds an accepted run and never resubmits.
- Each completed, failed, cancelled, or action-required run state is recorded in the existing SQLite events table under the deterministic id `outbound:<run_id>:<status>`.
- The cursor advances in the same transaction, only after durable recording.
- `task_group_status` events only advance the cursor.
- The `event_cursor` returned by group additions seeds the cursor only when none is stored and no other run of the group is bound. It never jumps past older pending jobs. `run_cursor` is not used for events.
- Backoff is bounded: base 5 seconds, doubling, cap 300 seconds, jittered to 75–100% of each step.
- A pass is healthy when it consumed any run event, or when its connection stayed open at least 60 seconds after a successful open. A healthy end resets the failure streak and pauses 1 second.
- Any other end of stream, a stream error, an `error` event, or a snapshot failure counts as a failure with backoff, so an inactive group's immediate end of stream does not busy-loop.
- Each events connection is bounded at 10 minutes of wall-clock time, open and body. Expiry is a healthy end: after the 1-second pause the collector reconnects from the stored cursor. Each snapshot is bounded at 60 seconds, open and body; expiry is a failure with backoff. The SDK timeout bounds only the wait for response headers, so these deadlines bound a stalled body.
- `retry-after` and `retry-after-ms` are honored on 429 and 503. When both the events open and the snapshot of a pass fail, the largest hint applies. Hints are capped at 15 minutes.
- `action_required` runs stay watched after they are recorded, so a later completion of the same run is collected and announced as a separate notice.
- SDK automatic retries are disabled (`maxRetries: 0`) on collector calls.
- Each loop iteration's snapshot is the polling fallback when streaming is unavailable.
- An uncertain submission not found in the snapshot stays uncertain and stops being polled.
- Failed or cancelled runs record their outcomes without fetching a success result.
- Fetch failures remain durable for explicit recovery, without recreating the paid job.
- A run seen through both SSE and an optional signed webhook is notified once per reported status, persistently: once a notice is acknowledged, a later entry for the same run and status is acknowledged without a second notice. A completion after `action_required` is a separate notice. Two processes can still fetch the same result concurrently. That fetch is an idempotent read that can add at most one extra artifact; no paid request repeats.
- Session stop, switch, or reload aborts the collector and waits for it to settle before the store closes. A stopping runtime never sends a notification or acknowledges one; the next runtime of the same session delivers any unacknowledged notice.
  The replacement runtime rehydrates and resumes from the stored cursor. No remote group close occurs.

Optional signed webhooks:
If `PIPARA_WEBHOOK_URL` is set with a shared `PIPARA_WEBHOOK_DIR` and a running receiver (`PARALLEL_WEBHOOK_KEY` or `PIPARA_WEBHOOK_SECRET`), runs also carry the per-run webhook.
Legacy accepted work and `/parallel-webhook` recovery remain supported.
The receiver's shared worker is an optional accelerator for offline collection, not a requirement.
Only handled and notified entries are pruned after 72 hours; unmatched callbacks and unacknowledged notifications remain retained.

The [webhooks announcement](https://parallel.ai/blog/webhooks) says callbacks POST the “full result.”
The [current Task webhook guide](https://docs.parallel.ai/task-api/webhooks) specifies a complete Task Run object instead, with no answer output or citations.
Group events likewise carry no output, so the separate result fetch stays.

Limits:

- Collection happens only while the owning session is open, unless the optional receiver is deployed.
- Account retention bounds how long runs can be found.
- Live provider SSE is unverified.
- Exactly-once notification is not guaranteed because of the crash window below.

Persist evidence before notifying the owning session.
Recheck ownership immediately before sending through the current runtime.
Do not send through stale contexts after reload or session replacement.
Mark a notification acknowledged only after delivery succeeds.
Deduplicate events and notification state, but document the crash window between a Pi side effect and its SQLite acknowledgement.
Outbound collection is the primary completion path. The optional webhook is deduplicated against it by run and status.
Use status/result snapshots for explicit bounded recovery.
Completed references remain readable without another paid request.
Reading another session's reference does not silently transfer its group ownership.

## 8. Implementation order after review

| Step | Deliverable | Exit check |
| --- | --- | --- |
| 1. Baseline and identity | Establish the unchanged baseline. Propose package identity `pi-webtasks` and a `webtasks` artifact namespace. Preserve the configured SQLite inbox. | No wholesale dirty-tree import, credential copy, or installed-package change. |
| 2. Three-tool adapter | Replace registrations and public guidance with the reviewed schemas. Preserve useful result helpers and human commands. | Exactly three registrations, no operation taxonomy, invalid inputs rejected before dispatch. |
| 3. Routine and conversation paths | Query/page retrieval, readable evidence, durable immutable conversation references. | Real query, real known page, cited answer, and continued answer work. |
| 4. Deep research module | SQLite state, session hook initialization, group dispatch, in-session outbound collector (SSE with polling fallback), shared result processing, owner notification, reference reads, and local cleanup. | Outbound collection persists results while the session is open and after restart without duplicate paid work or a remote-research drain. Live provider SSE is still to be verified. | |
| 5. Effort wiring | Implement the confirmed tier policy once. | All three paths use the exact mapping, default low, and never escalate. Untiered branches reject effort. |
| 6. Model navigation | Adapt the existing three-tool harness and run the authorized real scenarios. | Agents navigate the interface and meet [the acceptance checks](#9-acceptance-and-verification). |
| 7. Documentation and packaging | Describe only verified behavior. Build and inspect the package. | Manifest, source registrations, instructions, examples, tests, and packaged contents agree. |

Do not publish documentation that claims later steps already work.

Use the existing TypeScript ecosystem and pinned backend SDK.
Reuse the existing database. Do not add a generic workflow engine, host patch, or speculative configuration layer.
Keep old accepted jobs and artifacts accessible in their original locations.

## 9. Acceptance and verification

Type checks and local validation/storage tests support correctness.
Mocked models, fake endpoints, synthetic callbacks, and offline harness selfchecks do not establish research acceptance.
Do not build another fake service evaluation in place of the requested real runs.

Use the user's actual HOME, configured model routes, authentication route, and installed native Pi runtime.
Load this checkout explicitly without the old research extension in the evaluated tool surface.
Start with the prior harness's real model set, then verify availability instead of silently substituting a model.

Required real scenarios:

1. A natural query chooses `web_search`. A known URL uses its page-reading path.
2. A cited answer and follow-up reuse the returned conversation reference.
3. Session start only loads an existing group. Concurrent first deep submissions create one group and return before research completion.
4. Independent local work continues while research runs, then outbound collection produces a useful completion notification and report.
5. Reference-only reads do not issue creation/addition requests or duplicate charges.
6. Reload during research retains the group and resumes collection from the stored cursor and routes delivery through the replacement runtime.
7. Session stop persists pending work and aborts the collector and detaches notifications without waiting for remote completion or closing the group.
8. Recovery reuses known work and preserves explicit failed, cancelled, uncertain, and action-required states.
9. Comparison and structured-list briefs produce usable answers. Native people/company search uses no group or collector.
10. Resume reuses the saved inactive group and can add new tasks without changing old run identities.
11. A run that completes while Pi is stopped is found by the startup snapshot, saved, and notified on resume.
12. Repeated stream events, reconnects, and an optional webhook for the same run do not duplicate the result fetch, paid work, or notification, and do not misroute notifications.
13. An offline owner's saved notification survives event pruning and is delivered on resume after the retention window.
14. An uncertain dispatch is reconciled by run metadata from the snapshot, never resubmitted, and stays recoverable through restart. If not found it stays uncertain and unpolled.
15. Stream error, error event, and immediate end of stream back off with bounded jitter. The larger `retry-after` hint of a pass applies. A stalled connection or snapshot ends at its deadline.

Record input, model/provider/runtime, dispatch timing, remote completion, artifact persistence, wake timing, errors, and actual outputs.
Assess answer correctness and source support, not just output-file existence or a URL.
Reuse existing qualification evidence where it applies.
Run new calls only for acceptance or a named evidence gap, not an unrestricted model/scenario matrix.

The explicitly requested group-status probe is complete.
Implementation is now authorized. Limit paid scenarios to targeted acceptance or a named evidence gap.

## 10. Evidence and review points

### Evidence sources

- S1: `~/.pi/agent/sessions/--home-jangmanj-Projects-JangLabs-pi-parallelized--/2026-10-06T21-19-53-497Z_01a11316-5698-7695-af65-c7880aef77f8.jsonl`
- S3: `~/.pi/agent/sessions/--home-jangmanj-Projects-JangLabs-pi-parallelized--/2026-10-07T10-40-03-476Z_01a115f2-e993-7660-9cfc-dbe4f958ebe2.jsonl`
- Previous contract: `~/Projects/JangLabs/pi-parallelized/.pi-herdsman/three-search-contract.md`
- Saved probe: `~/Projects/JangLabs/pi-parallelized/.pi/three-tool-tier-probe/`, including `report.md`, `calls/`, and `anchors/`.
- Current baseline helpers: `src/index.ts`, `src/ops.ts`, `src/results.ts`, `src/evidence.ts`, and the existing webhook modules.
- Optional callback flow: `src/webhook-receiver.ts` verifies and persists before HTTP acknowledgement. `src/webhook-consumer.ts` gates result retrieval by owner session.
- Existing SQLite implementation: `src/webhook-inbox.ts` uses WAL, durable commits, deduplication, and transactional processing claims.
- Existing integration documentation: [webhook integration](docs/webhook-integration.md). Historical route verification does not verify the new shared-worker behavior.
- User-supplied overview: https://parallel.ai/blog/webhooks. Use https://docs.parallel.ai/task-api/webhooks for the current payload contract.
- Native Pi lifecycle check: `result:plan-lifecycle#1`, against build `1.0.4-native-2ac9a13-ccsid`.
- Saved tier analysis: `result:plan-tiers#1`. Its recommendations are proposals, not accepted policy.
- Request recovery: `result:recover-request#1`.
- Live status probe: [report](.pi/group-status-probe/2026-10-07T18-50-05.627Z/REPORT.md), with both task outputs and raw request/response records in that directory.
- Published pricing: https://docs.parallel.ai/resources/pricing. Charges are per completed task run, with no separate group-creation fee listed.

Use the later system-name correction for credential integration: `_PARALLEL_API_KEY` and `PARALLEL_WEBHOOK_KEY`.
Do not invent replacement credential names for the new package.
The plan does not rename unrelated deployment settings.

### Remaining interface review

Are the proposed three-tool fields the intended interface, or did the old contract also overconstrain them?
The session start/stop hook decision replaces the previous closure and unbounded-drain questions.

Effort selection is settled by the user's confirmed screenshot. Behavior qualification remains separate.
