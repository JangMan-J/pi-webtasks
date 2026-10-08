# Release readiness

Status: implementation in progress. No installation or publication occurred.

## Scope

- Exactly three model tools, including native synchronous people/company search in `web_search`.
- Lookup-only startup and lazy Task Group initialization for actual deep submissions.
- Existing SQLite inbox for research references, conversation references, and durable recovery.
- Outbound completion through Task Group SSE with bounded polling fallback, run inside the owning Pi session, not a new daemon.
- Signed webhooks and the receiver's shared worker are optional.
- No new async FindAll workflows, monitoring, or account administration.
- Installed extension, settings, credential stores, and running processes remain untouched.

## Current evidence

| Check | Observation |
| --- | --- |
| Initial baseline | No local dependencies. Typecheck could not resolve Pi or Parallel packages. Tests had 63 passes and 11 dependency-load failures. |
| Dependency repair | `npm ci --ignore-scripts --no-audit --no-fund` installed the pinned local dependencies. |
| Credentials | Seven environment tests pass, including deployed names and environment precedence. |
| Public-tool slice | Five non-store-backed tests pass: exact tool set, validation, routine shapes, and native entity lookup. |
| Entity transport | One synchronous SDK request with the beta header, no callback or group, full artifact, bounded preview, and no public set ID. |
| Native runtime | Installed Pi reports `1.0.4`; Node reports `v26.10.0`. |
| Prior model set | `anthropic/claude-sonnet-5-5`, `antigravity/gemini-3.7-flash`, and `openai-codex/gpt-6.1-sol` appear in the current model catalog. |
| Earlier receiver observation | A user-systemd receiver was reported at `127.0.0.1:8787/parallel/webhook`, and GET returned 405. This was not re-verified in this checkout, and the receiver may belong to another account. |
| Current ingress | An existing Cloudflare tunnel targets the receiver. Its configured HTTPS URL fails DNS resolution from this machine. This no longer blocks `deep_search`, which needs no public callback. |
| Outbound completion | Implemented on `feature/outbound-completion`, with offline implementation and tests using fake clients (`tests/outbound.test.ts`, plus the consumer and lifecycle suites). Findings from the independent review are fixed in this branch. Contract basis is the Task Group API docs and `parallel-web` 1.3.3. |

The offline implementation and tests support only the checks they run.
Remaining before release: an independent reviewer rerun of the fixed revision, full integration and affected-flow reruns, and the live checks that failed or were out of scope below.
Local fake clients do not establish a live research result, live SSE behavior, or optional public callback delivery.
Model catalog presence is not proof that a model request succeeds.

## Live acceptance (d4665e7)

Run on 2026-10-08 against detached `d4665e7e2dbc5549394de34125f8a1f069be26c6`. Pi `1.1.0`. Native model `anthropic/claude-haiku-5-5` (settings default; `--model` was not passed). Store was a private `WEBTASKS_DIR`. `WEBTASKS_WEBHOOK_URL` was unset. The inactive receiver was not started. No login, token refresh, or account-file copy.

Paid calls: 3. No repeats. Balance was not observable (no account token at `~/.config/pi-webtasks/account.json`). No price field was present on the logged responses. Estimate from the published pricing page (https://docs.parallel.ai/resources/pricing): Search `fast` is $1 per 1,000 requests ($0.001); Task `core` is $25 per 1,000 runs ($0.025). Estimate, not a measured charge: $0.001 + $0.025 + $0.025 = $0.051.

Logs, which contain the raw ids, stay untracked: `~/.cache/pi-webtasks-live/runs/20261008T012130Z/logs/direct.jsonl` and `rpc.jsonl`.

| Check | Result |
| --- | --- |
| One low `deep_search`, one `addRuns`, dispatch returned while pending | Pass. Dispatch return 543 ms after the script start. Accepted state `pending`. Stop 11 ms after that return. |
| Replacement snapshot still non-terminal, terminal event on the events stream | Pass. Startup snapshot status `queued`. Then `task_group_status` about every 10 s, then `task_run.state` `completed` at 01:23:23Z, about 112 s after dispatch return. Stream EOF followed. |
| Resume from the stored cursor (`last_event_id` on reconnect) | Fail. The stored cursor before the stop was null. Both events opens, including the replacement, passed `last_event_id` null. `addRuns` returned keys `status`, `run_ids`, `run_cursor`, and `event_cursor`; `event_cursor` was null. The checkout adopts only a non-empty `event_cursor`, so nothing was stored to resume from. A cursor was written only after later status events on the replacement stream. |
| One result fetch, one `outbound:…:completed` row, one owning-session notice, cited artifact | Pass. Result fetches: 1. `addRuns`: 1. Notification count: 1, on the replacement runtime. Artifact `~/.cache/pi-webtasks-live/runs/20261008T012130Z/artifacts/20261008-012323-68cf8v.json` has answer text and 9 citation URLs (Rust blog, Go blog, and the Rust reference). The six-week and February/August cadence claims match those primary-announcement URLs. The pages were not re-opened here. |
| Native Pi, this checkout alone, default model, `web_search` then `deep_search` | Pass. Tool surface was the built-ins plus `web_search`, `interactive_search`, and `deep_search`. No `parallel_research` or `parallel_control`. Tools called, in order: `web_search` with a Rust-version query and domains `blog.rust-lang.org` and `rust-lang.org` (01:24:20.960Z–01:24:21.646Z); `deep_search` effort `low` with one comparison query (01:24:25.500Z–01:24:25.880Z). `deep_search` returned accepted before completion. Notify (`extension_ui_request` / `notify`) arrived in the same session at 01:25:39.570Z. The model then called `deep_search` with only the saved research reference, a local read, not a second submit, and corrected its earlier version claim from that file. The runner did not abort that read; it had stopped watching after the two planned tools. Research rows stayed at 2, both completed. Search activity rows: 1. |
| `interactive_search`, prior-model set, offline-owner receiver | Not run. Outside this acceptance. |

Native artifacts: `~/.pi/agent/webtasks/results/20261008-012421-amjd2n.md` (search evidence; official Rust blog announcements, and the model hedged that the newest hit might not be the current stable), `~/.pi/agent/webtasks/results/20261008-012425-ajzq3r.json` (dispatch record), `~/.pi/agent/webtasks/results/20261008-012539-8h3nrb.json` (completion; cited later 2026 Rust and Go announcements and six-week / about-six-month intervals). Those later dates were not re-fetched.

Direct-script event order, without ids: `taskGroup.create`; `addRuns`; events open with no cursor; stop; replacement events open with no cursor; snapshot `task_run.state` `queued`; snapshot EOF; `task_group_status` events; `task_run.state` `completed`; one result fetch; one delivery; events EOF.

## Remaining release checks

1. Run store-backed public-tool tests after the backend contract lands.
2. Adapt the end-to-end lifecycle test to the new public tools and the in-session collector. Done offline: `tests/outbound.test.ts` and `tests/webhook-lifecycle.test.ts` run registered tools with the in-session collector.
3. Verify with fake clients: cursor persistence, reconnect, backoff, snapshot binding, SSE/webhook deduplication, retention, and resume notification. Offline coverage exists in `tests/outbound.test.ts` (including cursor rollback and the connection and snapshot deadlines), and retention in `tests/webhook-inbox.test.ts`. Live verification remains item 7.
4. Run full type checks and the current offline suite.
5. Inspect package contents and verify that credentials and runtime artifacts are absent.
6. Load this checkout alone through native Pi and verify real model/tool navigation with targeted paid calls. Default-model `web_search` then `deep_search` passed on `d4665e7`. The prior model set was not run.
7. Verify live provider SSE against the real API with one authorized small run: event shape, `last_event_id` resume, stream end behavior, and result fetch. Event shape, stream end, and one result fetch passed. `last_event_id` resume failed: no cursor was stored before reconnect. Still open.
8. Verify real model navigation of `deep_search` (item 6) including a session close and reopen during a run. Stop and replace delivered through the replacement, and the startup snapshot was still `queued`. Cursor resume failed, as in item 7. Still open.
9. Optional: verify actual provider callback delivery against the receiver after an authorized deployment. Not run.

No broad paid matrix, account mutation, or monitoring experiment is required.
Effort policy is user-confirmed: discovery fast/basic/advanced, Responses low/medium/high, and Tasks core/pro/ultra2x.
The default is low. No automatic escalation or further tier-selection experiment is required.
Behavior and source support still need acceptance checks.
Caller-defined strict output schemas remain an open contract choice.

## Checkout versus installed copy

This repository is the implementation target.
The installed receiver's code location, `~/.pi/agent/git/github.com/JangMan-J/pi-parallelized/src/webhook-receiver.ts`, is unverified on this machine. The path is absent under this account, and it may belong to another account. Nothing here reads or changes it.
Its installed code does not acquire this checkout's changes through a source edit here.
`deep_search` does not depend on it. Using the optional receiver with this checkout needs a separate deployment into the existing process configuration.
That deployment and any public-route repair remain separate from local release preparation.
