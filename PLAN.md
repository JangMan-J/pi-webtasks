# pi-webtasks: corrected three-tool plan

Status: implementation authorized. Tool coverage remains subject to [the mapping review](docs/api-mapping.md).
Installation, publication, and changes to the running receiver remain separate.
Webhook-first completion and existing SQLite persistence are now the design direction.

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
| Build around webhook delivery. | Current review identifies webhooks as the service's strongest part. SQLite reuse follows the existing implementation. |

Historical permission to spend does not authorize unrelated experiments.
The later user explicitly stopped unnecessary spending in S3, lines 229 and 232.
The user separately authorized the two-group status probe during review.
Do not start further paid work without implementation authorization or another explicit experiment request.

## 3. What exists, and what does not

This checkout has no commits and still identifies itself as `pi-parallelized`.
Its `src/index.ts` matches that file at the other checkout's committed baseline, `f8da751`.
It registers the original low-level tools, not either replacement interface.

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
Configure a completion webhook on each submitted run.
Persist and deliver results through the webhook path.
Keep callback configuration outside the model-facing fields.
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
Completion is per run through webhooks, not through a required group event stream.
They do not provide an execution lifecycle that the extension must close.
The old runtime-lifetime closure contract is superseded by the start/stop hook decision.

### Session start

1. Resolve the Pi session ID and look up its existing research state.
2. Hydrate the per-session runtime group ID if a saved group exists.
3. Attach the session's local inbox consumer and deliver saved, undelivered outcomes.

Startup is lookup-only. Do not create a group or insert a session row for a fresh session.

### First deep submission

Validate the entire submission and callback configuration before remote work.
When the runtime group ID is missing, await one shared initialization promise for that session.
Persist the research initialization intent, create the group, save its ID, then populate the runtime cache before adding tasks.
Concurrent initial submissions must not create competing groups.
Normal submissions reuse the populated cache without repeating group setup or a DB lookup.
Routine search, conversation, and reference-only reads bypass group initialization.
Reset or rebind the cache on session switch and reload.
New calls select processors per submitted task.
The group itself has no processor setting.
A group setup failure must leave a clear research-tool error without disabling unrelated Pi work.
Missing callback configuration must prevent paid deep submissions rather than silently switching to polling or SSE.
Routine search and conversational research remain independent of callback setup.
Do not maintain a competing group event stream for normal completion.

### Session stop

1. Prevent new submissions through the outgoing runtime.
2. Save accepted run IDs, results already received, delivery state, and unresolved submission records.
3. Stop the session's local watcher and notification callbacks.
4. Release its runtime ownership without discarding the saved group or stopping the shared receiver.

Handle in-flight dispatch separately from research execution.
Preserve an interrupted or unresolved dispatch as uncertain rather than creating a replacement task.
Do not wait for all remote research to finish merely to stop the session.
The shared receiver can continue accepting authenticated callbacks while Pi is closed.
The proposed shared result worker saves completed outputs without waiting for that session to resume.
Pending notifications are delivered when the owning session resumes.
Until that worker is implemented and verified, result collection remains dependent on the active Pi consumer.
Do not promise results beyond account retention or callback delivery guarantees.

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

Set the same configured callback and required event subscription on every group input.
There is no group-level webhook or group-level processor setting.
Correlate callbacks through their run IDs and persisted ownership, not through arrival order.
Callbacks that arrive before registration remain pending or quarantined until the matching registration is available.
Do not finalize an unresolved submission's callback merely because a local grace period expires.
Late registration must allow reprocessing after a crash or delayed dispatch reconciliation.
Keep unmatched callbacks non-routable until ownership is established.

### Webhook-first completion

```text
Submit run with callback
  -> verify incoming signature
  -> persist and deduplicate callback in SQLite
  -> acknowledge HTTP delivery
  -> claim event and fetch successful result once
  -> save evidence and record outcome
  -> notify active owner, or retain notification for resume
```

Keep one shared receiver independent of individual Pi sessions.
Reuse the existing verifier, durable inbox, claim logic, one-shot retrieval, and notification acknowledgement.
Do not expose signing secrets or callback transport to the agent.
Invalid or unsigned callbacks must not trigger result requests or model turns.
Failed or cancelled runs record their outcomes without fetching a success result.
Fetch failures remain durable for explicit recovery, without recreating the paid job or starting a polling loop.

Proposed extension to the existing implementation: separate shared result processing from session-specific notification.
The current consumer performs both inside Pi, so a closed owner delays result fetching.
A shared worker can retrieve and save results for registered runs while their owner is offline.
That worker does not claim another session's notifications or send through stale contexts.
Keep result retrieval outside the receiver's HTTP acknowledgement path.
Verify this offline-owner behavior against the real callback route before claiming it works.
The existing implementation prunes handled events after 72 hours, including unacknowledged notifications.
It also retires unmatched callbacks after a 30-minute registration grace period.
Those policies need correction before the stronger offline and delayed-registration guarantees apply.

The supplied [webhooks announcement](https://parallel.ai/blog/webhooks) says callbacks POST the “full result.”
The [current Task webhook guide](https://docs.parallel.ai/task-api/webhooks) specifies a complete Task Run object instead.
Its success example contains status and metadata, without answer output or citations.
Retain the separate result fetch rather than interpreting the announcement as a result-payload guarantee.

Persist evidence before notifying the owning session.
Recheck ownership immediately before sending through the current runtime.
Do not send through stale contexts after reload or session replacement.
Mark a notification acknowledged only after delivery succeeds.
Deduplicate events and notification state, but document the crash window between a Pi side effect and its SQLite acknowledgement.
Use callbacks as the primary completion path, not parallel webhook and SSE collectors.
Use status/result snapshots only for explicit bounded recovery.
Completed references remain readable without another paid request.
Reading another session's reference does not silently transfer its group ownership.

## 8. Implementation order after review

| Step | Deliverable | Exit check |
| --- | --- | --- |
| 1. Baseline and identity | Establish the unchanged baseline. Propose package identity `pi-webtasks` and a `webtasks` artifact namespace. Preserve the configured SQLite inbox. | No wholesale dirty-tree import, credential copy, or installed-package change. |
| 2. Three-tool adapter | Replace registrations and public guidance with the reviewed schemas. Preserve useful result helpers and human commands. | Exactly three registrations, no operation taxonomy, invalid inputs rejected before dispatch. |
| 3. Routine and conversation paths | Query/page retrieval, readable evidence, durable immutable conversation references. | Real query, real known page, cited answer, and continued answer work. |
| 4. Deep research module | SQLite state, session hook initialization, group dispatch with per-run callbacks, shared result processing, owner notification, reference reads, and local cleanup. | Real callbacks persist results during active and stopped sessions without duplicate paid work or a remote-research drain. |
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
4. Independent local work continues while research runs, then a verified webhook produces a useful completion notification and report.
5. Reference-only reads do not issue creation/addition requests or duplicate charges.
6. Reload during research retains the group and routes webhook-driven delivery through the replacement runtime.
7. Session stop persists pending work and detaches notifications without stopping the shared receiver or waiting for remote completion.
8. Recovery reuses known work and preserves explicit failed, cancelled, uncertain, and action-required states.
9. Comparison and structured-list briefs produce usable answers. Native people/company search uses no group or callback.
10. Resume reuses the saved inactive group and can add new tasks without changing old run identities.
11. A real callback received while Pi is stopped leads to a saved result and a notification on resume.
12. Callback retries and callback-before-registration races do not duplicate paid work or misroute notifications.
13. An offline owner's saved notification survives event pruning and is delivered on resume after the retention window.
14. A callback received before an uncertain dispatch is reconciled remains recoverable through delayed registration and restart.

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
- Existing callback flow: `src/webhook-receiver.ts` verifies and persists before HTTP acknowledgement. `src/webhook-consumer.ts` gates result retrieval by owner session.
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
