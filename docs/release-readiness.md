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
Remaining before release: an independent reviewer rerun of the fixed revision, full integration and affected-flow reruns, and live acceptance.
Local fake clients do not establish a live research result, live SSE behavior, or optional public callback delivery.
Model catalog presence is not proof that a model request succeeds.

## Remaining release checks

1. Run store-backed public-tool tests after the backend contract lands.
2. Adapt the end-to-end lifecycle test to the new public tools and the in-session collector. Done offline: `tests/outbound.test.ts` and `tests/webhook-lifecycle.test.ts` run registered tools with the in-session collector.
3. Verify with fake clients: cursor persistence, reconnect, backoff, snapshot binding, SSE/webhook deduplication, retention, and resume notification. Offline coverage exists in `tests/outbound.test.ts` (including cursor rollback and the connection and snapshot deadlines), and retention in `tests/webhook-inbox.test.ts`. Live verification remains item 7.
4. Run full type checks and the current offline suite.
5. Inspect package contents and verify that credentials and runtime artifacts are absent.
6. Load this checkout alone through native Pi and verify real model/tool navigation with targeted paid calls.
7. Verify live provider SSE against the real API with one authorized small run: event shape, `last_event_id` resume, stream end behavior, and result fetch.
8. Verify real model navigation of `deep_search` (item 6) including a session close and reopen during a run.
9. Optional: verify actual provider callback delivery against the receiver after an authorized deployment.

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
