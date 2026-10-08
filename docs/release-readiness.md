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

Paid calls: 3, no repeats (`logs/direct.jsonl` line 4; `logs/rpc.jsonl` paid-call n=2 and n=3). Balance was not observable (no account token at `~/.config/pi-webtasks/account.json`). No price field was present on the logged responses. Estimate from the published pricing page (https://docs.parallel.ai/resources/pricing): Search `fast` is $1 per 1,000 requests ($0.001); Task `core` is $25 per 1,000 runs ($0.025). Estimate, not a measured charge: $0.001 + $0.025 + $0.025 = $0.051.

Logs, which contain the raw ids, stay untracked: `~/.cache/pi-webtasks-live/runs/20261008T012130Z/logs/direct.jsonl` and `rpc.jsonl`.

| Check | Result |
| --- | --- |
| One low `deep_search`, one `addRuns`, dispatch returned while pending | Pass. Dispatch return 543 ms after the script start (`direct.jsonl` line 6). Accepted state `pending`. Stop 11 ms after that return (line 9, 554 ms). |
| Replacement snapshot still non-terminal, terminal event on the events stream | Pass. Startup snapshot status `queued` (line 12). Then `task_group_status` about every 10 s (lines 14–25), then `task_run.state` `completed` at 01:23:23Z, about 112 s after dispatch return (line 26). Stream EOF followed (line 29). |
| Stop/restart: not exercised live | Not a cursor-resume test, and not a cursor-resume failure. The stored cursor was null at the stop: `addRuns` returned `event_cursor` null (line 5) and `before-stop` shows `cursor: null` (line 8). The replacement opened with no `last_event_id` (line 10), so it relied on the snapshot (line 12) and the first `task_group_status` (line 14). Resume evidence is in the free probe and the mid-run run below. |
| Free resume probe, same group, no new paid call | Pass. Recorded in docs commit `34507523`. The probe used a copy of the store with the pre-completion status id written as the stored cursor. The server replayed `task_run.state` `completed`, then `task_group_status`, then EOF (275 ms, `cursor-probe.jsonl` lines 2–4). With no cursor, the group replayed the same two events and EOF (99 ms, lines 5–7). The checkout collector reconnected with that cursor (`collector-events-open`, `hasLast: true`, `lastMatchesChosen: true`, line 10). The snapshot inserted `outbound:…:completed` (line 11), then one result GET (line 12) and one notice (line 13). Summary `ok: true` (line 14). Log: `~/.cache/pi-webtasks-live/runs/20261008T012130Z/logs/cursor-probe.jsonl`. |
| One result fetch, one `outbound:…:completed` row, one owning-session notice, cited artifact | Pass. Result fetches: 1 (`direct.jsonl` line 27). `addRuns`: 1 (line 4). Notice: 1, on the replacement runtime (line 30). Summary `resultCalls: 1`, `notices: 1` (line 31). Artifact `~/.cache/pi-webtasks-live/runs/20261008T012130Z/artifacts/20261008-012323-68cf8v.json` has answer text and 9 citation URLs (Rust blog, Go blog, and the Rust reference). The six-week and February/August cadence claims match those primary-announcement URLs. The pages were not re-opened here. |
| Native Pi, this checkout alone, default model, `web_search` then `deep_search` | Pass. Tool surface was the built-ins plus `web_search`, `interactive_search`, and `deep_search`. No `parallel_research` or `parallel_control`. Tools called, in order: `web_search` with a Rust-version query and domains `blog.rust-lang.org` and `rust-lang.org` (01:24:20.960Z–01:24:21.646Z); `deep_search` effort `low` with one comparison query (01:24:25.500Z–01:24:25.880Z). `deep_search` returned accepted before completion. Notify (`extension_ui_request` / `notify`) arrived in the same session at 01:25:39.570Z. The model then called `deep_search` with only the saved research reference, a local read, not a second submit, and corrected its earlier version claim from that file. The runner did not abort that read; it had stopped watching after the two planned tools. Research rows stayed at 2, both completed. Search activity rows: 1. |
| `interactive_search`, prior-model set, offline-owner receiver | Prior-model navigation and `interactive_search` were run in the follow-up below. The offline-owner receiver check remains open. |

Native artifacts: `~/.pi/agent/webtasks/results/20261008-012421-amjd2n.md` (search evidence; official Rust blog announcements, and the model hedged that the newest hit might not be the current stable), `~/.pi/agent/webtasks/results/20261008-012425-ajzq3r.json` (dispatch record), `~/.pi/agent/webtasks/results/20261008-012539-8h3nrb.json` (completion; cited later 2026 Rust and Go announcements and six-week / about-six-month intervals). Those later dates were not re-fetched.

Direct-script event order, without ids: `taskGroup.create`; `addRuns`; events open with no cursor; stop; replacement events open with no cursor; snapshot `task_run.state` `queued`; snapshot EOF; `task_group_status` events; `task_run.state` `completed`; one result fetch; one delivery; events EOF.

Note on the backoff rule: these runs used the build in which a pass reset its failure streak on any run event or on a connection open for at least 60 seconds. The rule is now progress-only (see the outbound section of the API mapping). Neither run's result depends on backoff timing.

## Live acceptance follow-up (d4665e7, 2026-10-08)

Same isolation: private `WEBTASKS_DIR`, no `WEBTASKS_WEBHOOK_URL`, no receiver, no account-file copy. Pi `1.1.0`. Logs: `~/.cache/pi-webtasks-live/runs/20261008T-gaps/`. A first cursor-resume attempt died in the runner (`async is not defined`) before `addRuns`. That attempt is not a product failure and was not a paid call. The retry below is the check.

Paid calls this follow-up: **25 provider calls** (an earlier record said 26). Derivation, from the session transcripts and cross-checked against each run's `logs/run.jsonl` `paid-call` lines:

| Category | Calls | Unit price (published pricing, or the tool guidance at the time) | Estimate |
| --- | ---: | --- | ---: |
| Search query (`web_search` with `query`) | 6 | $0.001 (Search `fast`) | $0.006 |
| Extract (`web_search` with `urls`, one URL each) | 3 | $0.001 per URL | $0.003 |
| Entity lookup (`web_search` with `entity`) | 5 | $0.005 | $0.025 |
| Interactive answer (`interactive_search`) | 6 | $0.01 (low) | $0.060 |
| Task submission (`deep_search` with `query`, plus the cursor run's `addRuns`) | 5 | $0.025 (`core`) | $0.125 |
| **Total** | **25** | | **$0.219** |

Reads of a saved research reference (`deep_search` with `research`) are free and are not counted. The session transcripts show 10 such reads across these runs. The runner logs recorded 5 of them. The earlier 26 counted one read (`gpt` `paid-call` n=9, `logs/run.jsonl` line 27). Removing it does not change the spend, because reads cost nothing. Estimate, not a measured charge.

Cumulative for this acceptance: 3 + 25 = 28 provider calls; estimate $0.051 + $0.219 = $0.270.

| Check | Result |
| --- | --- |
| Mid-run stop, reconnect with the stored cursor | Pass by log evidence. The runner's own verdict is `ok: false`, and the cause is in the runner, not the product (below). Cursor became non-null about 0.5 s after dispatch, while status was still `pending`: dispatch return 495 ms (`cursor/logs/run.jsonl` line 3), `poll … hasCursor: false` at 02:48:24.581Z (line 5), `poll … hasCursor: true` at 02:48:25.084Z (line 6). The runner stopped with that cursor, `7389a3282213df8f` (line 7). The replacement's events open carried it: `events-open`, `lastEventId: "7389a3282213df8f"`, `n: 2`, at 02:48:25.099Z (line 9). Completion followed: one result GET at 02:49:00.405Z (line 10), one notice (line 11), one `addRuns` (line 2). Stored cursor after the run: `f5d2fa437749addb`, so the cursor moved past the resumed value. The durable state agrees: one `outbound:…:completed` row, handled and notified, one `run_notifications` row, research `completed`. Summary `reconnectsAfterCompletionWindow: 0` (line 12). Log: `~/.cache/pi-webtasks-live/runs/20261008T-gaps/cursor/logs/run.jsonl`. **Why `ok: false`:** the runner read `opens` right after `rt.start()` returned (line 8, 02:48:25.098Z, `lastEventId: null, matches: false`). The replacement's open was recorded one millisecond later (line 9, 02:48:25.099Z). The check therefore read an empty entry, and `ok` (line 12) is false. The open in line 9 is the evidence. |
| `anthropic/claude-sonnet-5-5` navigation | Pass, with extra reads. Available, no substitution. One session, natural prompt. Planned steps: query `web_search` (line 4), URL `web_search` (line 5), `interactive_search` (line 6), entity `web_search` (line 7), low `deep_search` (line 8). Extra: a second `interactive_search` with a follow-up about the Rust Foundation (line 15). Two `deep_search` calls on the saved reference (lines 18 and 22) were reads, not submits. Notify at 02:43:35.054Z (line 24). The follow-up turn settled, with no error (line 25). Artifact `~/.pi/agent/webtasks/results/20261008-024335-3ewh46.json`. |
| `antigravity/gemini-3.7-flash` navigation | **Fail (misuse).** Available, no substitution. The planned steps ran, and the notice arrived at 02:42:51.337Z (line 27), settled without error (line 28). Misuse: entity lookup repeated three times (lines 7, 15, and 20, at 02:41:45.979Z, 02:42:31.593Z, and 02:42:39.156Z; the store records three `entity` search rows). Extra query search (line 16, 02:42:31.593Z). The runner's `ok: true` (line 29) checks that a notice and the tools were present. It does not measure misuse. Artifact `~/.pi/agent/webtasks/results/20261008-024251-kbufda.json`. |
| `openai-codex/gpt-6.1-sol` navigation | **Undetermined.** Available, no substitution. Planned steps ran. The notice arrived at 02:44:36.271Z (`gpt/logs/run.jsonl` line 30), queued behind a turn that was still active. The runner's 180 s settle check timed out at 02:47:36.272Z (line 31). The follow-up turn had not settled. Tool calls did follow the notice, per the session transcript `gpt/sessions/2026-10-08T02-41-41-309Z_live-nav-gpt.jsonl`: `bash` `sleep 90` at 02:45:37.284Z (result 02:47:07.290Z), a `deep_search` read of the saved reference at 02:47:10.916Z (free), and an `edit` of a notes file at 02:47:24.622Z. The earlier `bash` `sleep 60` started at 02:44:33.636Z, before the notice. The runner's `tool-end` log stops at 02:44:26.753Z and does not show these calls. Whether the delay was model latency or the model's own waits is undetermined. It is not attributed to the extension. Artifact `~/.pi/agent/webtasks/results/20261008-024436-ecqnhr.json`. |
| Session replacement by RPC `switch_session` (not `/reload`) | Pass for session replacement. **Actual `/reload` was not exercised.** `/reload` is interactive-only and refuses while streaming. `pi --help` has no reload flag, and RPC has no `reload` command (`reload/logs/run.jsonl` line 1). What was tested is `switch_session` on the same session file, which returned `success: true, sameSession: true` at 02:41:46.396Z (line 7). It tore down and restarted the extension runtime. The notice was delivered once, in that session, at 02:44:06.757Z (line 8). Summary `notices: 1`, `paid: 1` (line 9). Default model `anthropic/claude-haiku-5-5`. Artifact `~/.pi/agent/webtasks/results/20261008-024406-3suppx.json`. |
| Cited claims | Pass on the claims that were re-fetched. Rust reference says a new language release every six weeks. The book appendix says the same. `go.dev/doc/devel/release` says go1.22.0 was released 2024-02-06. The Go release-cycle page says Go is released every six months. The Rust blog says Rust 1.76.0 was announced Feb. 8, 2024. `rust-lang.org/governance` lists a Leadership Council and top-level teams, which supports the interactive answers. `foundation.rust-lang.org/about` returned 403, so foundation-specific sentences were not checked. Later 2026 version dates were not each re-fetched. |

Navigation outcomes, per model. There is no blanket navigation pass.

| Model | Outcome |
| --- | --- |
| `anthropic/claude-haiku-5-5` (default, first run) | Pass for `web_search` then `deep_search`; notice delivered. |
| `anthropic/claude-sonnet-5-5` | Pass, with extra reads. |
| `antigravity/gemini-3.7-flash` | Fail (misuse): repeated entity lookups. |
| `openai-codex/gpt-6.1-sol` | Undetermined: follow-up turn still active at the 180 s check. |

## Records and decisions

- The rename to pi-webtasks is kept. The old store at `~/.pi/agent/parallelized/webhooks/webhooks.sqlite` is not read, and there is no legacy reader. Its 2 pending registrations are accepted as lost (Manager decision). Nothing in this checkout opened that file for this record.
- Live acceptance so far is on `d4665e7`. The progress-only backoff rule was added after those runs and is covered by offline tests only.
- Latest user decision: the `/webtasks` command is removed. The extension registers exactly three model tools and no commands. Credentials come only from `_PARALLEL_API_KEY` or `PARALLEL_API_KEY` in the environment, or from `.env` or `parallel.env` beside the package manifest. There is no device login, balance command, or account file. Manual `recover` is gone.
- Behavior change: a failed result fetch is retried once when its owning session next starts. The retry is a read of the saved run, never a new submission. Watcher passes and inbox writes do not retry it. The earlier records above that used `/webtasks status`, `login`, `balance`, or `recover` describe the command that was removed.

## Remaining release checks

1. Run store-backed public-tool tests after the backend contract lands.
2. Adapt the end-to-end lifecycle test to the new public tools and the in-session collector. Done offline: `tests/outbound.test.ts` and `tests/webhook-lifecycle.test.ts` run registered tools with the in-session collector.
3. Verify with fake clients: cursor persistence, reconnect, backoff, snapshot binding, SSE/webhook deduplication, retention, and resume notification. Offline coverage exists in `tests/outbound.test.ts` (including cursor rollback and the connection and snapshot deadlines), and retention in `tests/webhook-inbox.test.ts`. Live verification remains item 7.
4. Run full type checks and the current offline suite.
5. Inspect package contents and verify that credentials and runtime artifacts are absent.
6. Load this checkout alone through native Pi and verify real model/tool navigation with targeted paid calls. Done per model, not as a blanket pass: default `anthropic/claude-haiku-5-5` passed; Sonnet passed with extra reads; Gemini failed (misuse: repeated entity lookups); GPT is undetermined (the follow-up turn was still active at 180 s; see the follow-up table).
7. Verify live provider SSE against the real API with one authorized small run: event shape, `last_event_id` resume, stream end behavior, and result fetch. Done in part. The first stop had no stored cursor, so it was not a resume test. The free probe and the mid-run stop both show resume with the stored cursor. The mid-run log shows the reconnect used the stored cursor (`cursor/logs/run.jsonl` line 7 stop with cursor, line 9 events open with it), but the runner's own verdict is `ok: false` because its check ran early (line 8). One result fetch and one notice followed. Stream end behavior was observed, not measured against a clock.
8. Verify real model navigation of `deep_search` including a session close and reopen during a run. Partly done. The interactive `/reload` was not exercised: it is interactive-only and refuses while streaming. `switch_session` on the same session replaced the runtime and delivered one notice. Those are different operations, and only the second was tested.
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
