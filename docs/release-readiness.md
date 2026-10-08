# Release readiness

Status: implementation in progress. No installation or publication occurred.

## Scope

- Exactly three model tools, including native synchronous people/company search in `web_search`.
- Lookup-only startup and lazy Task Group initialization for actual deep submissions.
- Existing SQLite inbox for research references, conversation references, and durable recovery.
- Background result processing inside the existing receiver process, not a new daemon.
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
| Current receiver | An existing user-systemd process serves `127.0.0.1:8787/parallel/webhook`. GET returns 405. |
| Current ingress | An existing Cloudflare tunnel targets the receiver. Its configured HTTPS URL fails DNS resolution from this machine. |

Worker conclusions support only their stated checks.
Full integration and affected-flow reruns remain pending.
Local mock transport does not establish a live research result or public callback.
Model catalog presence is not proof that a model request succeeds.

## Remaining release checks

1. Run store-backed public-tool tests after the backend contract lands.
2. Adapt the end-to-end lifecycle test to the new public tools and same-process result worker.
3. Verify stopped-owner collection, delayed registration, callback deduplication, retention, and resume notification.
4. Run full type checks and the current offline suite.
5. Inspect package contents and verify that credentials and runtime artifacts are absent.
6. Load this checkout alone through native Pi and verify real model/tool navigation with targeted paid calls.
7. Verify actual provider callback delivery against the new receiver implementation after an authorized deployment.

No broad paid matrix, account mutation, or monitoring experiment is required.
Effort policy is user-confirmed: discovery fast/basic/advanced, Responses low/medium/high, and Tasks core/pro/ultra2x.
The default is low. No automatic escalation or further tier-selection experiment is required.
Behavior and source support still need acceptance checks.
Caller-defined strict output schemas remain an open contract choice.

## Checkout versus installed copy

This repository is the implementation target.
The running receiver uses `~/.pi/agent/git/github.com/JangMan-J/pi-parallelized/src/webhook-receiver.ts`.
Its installed code does not acquire this checkout's new worker through a source edit here.
Production deployment must replace the receiver code in the existing process configuration, not add another process.
That deployment and any public-route repair remain separate from local release preparation.
