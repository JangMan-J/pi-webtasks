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
| Resume from the stored cursor (`last_event_id` on reconnect) | Fail, as run. No stored cursor existed at the stop point. `direct.jsonl` shows `addRuns` returned `event_cursor` null (keys also included `run_cursor`), the row's cursor was still null, and the stop was 11 ms after dispatch. The first `task_group_status` arrived only after that stop, on the replacement stream. `parallel-web` documents `event_cursor` as empty for the first runs in a group. The checkout adopts only a non-empty string, so there was nothing to pass as `last_event_id`. This did not exercise resume. |
| Free resume probe, same group, no new paid call | Pass. A pre-completion `task_group_status` id from `direct.jsonl` was passed as `last_event_id`. The server replayed `task_run.state` `completed`, then `task_group_status`, then EOF (275 ms). With no `last_event_id`, an inactive group also returned those two events and EOF (99 ms); it did not EOF with an empty body. On a copy of the store, that pre-completion id was written as `event_cursor`, the direct-run row was marked pending, and its completed outbound row, notification row, and registration fetch state were cleared. The checkout collector reconnected with that `last_event_id`. The snapshot inserted `outbound:…:completed` first. One free result GET and one notice followed. Log: `~/.cache/pi-webtasks-live/runs/20261008T012130Z/logs/cursor-probe.jsonl`. |
| One result fetch, one `outbound:…:completed` row, one owning-session notice, cited artifact | Pass. Result fetches: 1. `addRuns`: 1. Notification count: 1, on the replacement runtime. Artifact `~/.cache/pi-webtasks-live/runs/20261008T012130Z/artifacts/20261008-012323-68cf8v.json` has answer text and 9 citation URLs (Rust blog, Go blog, and the Rust reference). The six-week and February/August cadence claims match those primary-announcement URLs. The pages were not re-opened here. |
| Native Pi, this checkout alone, default model, `web_search` then `deep_search` | Pass. Tool surface was the built-ins plus `web_search`, `interactive_search`, and `deep_search`. No `parallel_research` or `parallel_control`. Tools called, in order: `web_search` with a Rust-version query and domains `blog.rust-lang.org` and `rust-lang.org` (01:24:20.960Z–01:24:21.646Z); `deep_search` effort `low` with one comparison query (01:24:25.500Z–01:24:25.880Z). `deep_search` returned accepted before completion. Notify (`extension_ui_request` / `notify`) arrived in the same session at 01:25:39.570Z. The model then called `deep_search` with only the saved research reference, a local read, not a second submit, and corrected its earlier version claim from that file. The runner did not abort that read; it had stopped watching after the two planned tools. Research rows stayed at 2, both completed. Search activity rows: 1. |
| `interactive_search`, prior-model set, offline-owner receiver | Prior-model navigation and `interactive_search` were run in the follow-up below. The offline-owner receiver check remains open. |

Native artifacts: `~/.pi/agent/webtasks/results/20261008-012421-amjd2n.md` (search evidence; official Rust blog announcements, and the model hedged that the newest hit might not be the current stable), `~/.pi/agent/webtasks/results/20261008-012425-ajzq3r.json` (dispatch record), `~/.pi/agent/webtasks/results/20261008-012539-8h3nrb.json` (completion; cited later 2026 Rust and Go announcements and six-week / about-six-month intervals). Those later dates were not re-fetched.

Direct-script event order, without ids: `taskGroup.create`; `addRuns`; events open with no cursor; stop; replacement events open with no cursor; snapshot `task_run.state` `queued`; snapshot EOF; `task_group_status` events; `task_run.state` `completed`; one result fetch; one delivery; events EOF.

## Live acceptance follow-up (d4665e7, 2026-10-08)

Same isolation: private `WEBTASKS_DIR`, no `WEBTASKS_WEBHOOK_URL`, no receiver, no account-file copy. Pi `1.1.0`. Logs: `~/.cache/pi-webtasks-live/runs/20261008T-gaps/`. A first cursor-resume attempt died in the runner (`async is not defined`) before `addRuns`. That attempt is not a product failure and was not a paid call. The retry below is the check.

Paid calls this follow-up: 26 provider calls. Estimate, from https://docs.parallel.ai/resources/pricing unless noted: Search `fast` $0.001, Extract $0.001/URL, entity search $0.005, Task `core` $0.025. Interactive low is $0.01 from the tool guideline, not re-read on that page. Reads of a saved research reference are not counted. Estimate total about $0.219.

| Check | Result |
| --- | --- |
| Real cursor resume | Pass. One low `deep_search`. Cursor became non-null about 0.5 s after dispatch, while status was still `pending`. Stop, then replacement. The replacement events open used that stored cursor (`last_event_id` equal). Completion, one result fetch, and one notice followed (result at 02:49:00Z, about 35 s after the stop). One `addRuns`. After that replacement open there was no further reconnect through an 8 s post-completion window, so a healthy-EOF 1 s loop was not observed. Log: `~/.cache/pi-webtasks-live/runs/20261008T-gaps/cursor/logs/run.jsonl`. |
| `anthropic/claude-sonnet-5-5` navigation | Pass, with extra reads. Available, no substitution. One session, natural prompt. Chose query `web_search`, URL `web_search`, `interactive_search`, a follow-up with the conversation reference, `web_search` entity `people`, and low `deep_search`. Notify arrived in the same session; the follow-up turn settled. Two later `deep_search` calls were reads, not new submits. Artifact `~/.pi/agent/webtasks/results/20261008-024335-3ewh46.json`. |
| `antigravity/gemini-3.7-flash` navigation | Pass, with misuse. Available, no substitution. Covered the same five steps, low effort where set, and handled the notice. It also repeated entity lookup three times and made an extra query search. Artifact `~/.pi/agent/webtasks/results/20261008-024251-kbufda.json`. |
| `openai-codex/gpt-6.1-sol` navigation | Partial fail. Available, no substitution. Covered search, URL read, interactive plus follow-up, entity, and low `deep_search`, and the notice arrived. The follow-up turn did not settle within 180 s. It also made extra query searches. Artifact `~/.pi/agent/webtasks/results/20261008-024436-ecqnhr.json`. |
| Reload during research | Pass for session replacement; `/reload` itself was not available. `pi --help` has no reload flag. RPC has no `reload` command. `/reload` is interactive-only and refuses while streaming. After low `deep_search` returned, RPC `switch_session` on the same session file succeeded and replaced the runtime. One notice arrived in that session (02:44:06Z). Default model `anthropic/claude-haiku-5-5`. Artifact `~/.pi/agent/webtasks/results/20261008-024406-3suppx.json`. |
| Cited claims | Pass on the claims that were re-fetched. Rust reference says a new language release every six weeks. The book appendix says the same. `go.dev/doc/devel/release` says go1.22.0 was released 2024-02-06. The Go release-cycle page says Go is released every six months. The Rust blog says Rust 1.76.0 was announced Feb. 8, 2024. `rust-lang.org/governance` lists a Leadership Council and top-level teams, which supports the interactive answers. `foundation.rust-lang.org/about` returned 403, so foundation-specific sentences were not checked. Later 2026 version dates were not each re-fetched. |

## Remaining release checks

1. Run store-backed public-tool tests after the backend contract lands.
2. Adapt the end-to-end lifecycle test to the new public tools and the in-session collector. Done offline: `tests/outbound.test.ts` and `tests/webhook-lifecycle.test.ts` run registered tools with the in-session collector.
3. Verify with fake clients: cursor persistence, reconnect, backoff, snapshot binding, SSE/webhook deduplication, retention, and resume notification. Offline coverage exists in `tests/outbound.test.ts` (including cursor rollback and the connection and snapshot deadlines), and retention in `tests/webhook-inbox.test.ts`. Live verification remains item 7.
4. Run full type checks and the current offline suite.
5. Inspect package contents and verify that credentials and runtime artifacts are absent.
6. Load this checkout alone through native Pi and verify real model/tool navigation with targeted paid calls. Done for the default model and the prior set on `d4665e7`. GPT did not finish handling the notice within 180 s. Gemini repeated entity lookup.
7. Verify live provider SSE against the real API with one authorized small run: event shape, `last_event_id` resume, stream end behavior, and result fetch. Done. The first stop had no cursor. A later stop after the first stored cursor reconnected with that `last_event_id`, and completion was collected once.
8. Verify real model navigation of `deep_search` including a session close and reopen during a run. `/reload` cannot be sent over RPC. `switch_session` on the same session replaced the runtime and delivered one notice.
9. Optional: verify actual provider callback delivery against the receiver after an authorized deployment. Not run. Needs a deployment.

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
