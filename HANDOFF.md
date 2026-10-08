# Manager handoff: outbound completion

## Resume here

The user asked to switch deep research from mandatory inbound webhooks to outbound SSE with polling fallback.
Implementation and live acceptance were completed on `feature/outbound-completion`.
Manager fast-forwarded `master` to `e086691` after independently reviewing and verifying the final cleanup fix.
Later user decision removed `/webtasks`; Manager reviewed, verified, and fast-forwarded `master` to `0a282c1`.
Latest wording change is integrated through `7f561f3`, plus Manager cleanup of monetary wording in result/error safety messages.
Native Parallel provider login is integrated through `36f8423`.
The API Keys link correction is integrated through `5e81012`; the correct tab is plural, `api-keys`.
User confirmed the link works, then identified `https://docs.parallel.ai/integrations/account-api` as the correct login surface.
User selected browser PKCE after asking which option supports sign-in without copying a key.
Lead now owns PKCE implementation; device flow and account key/app creation were not selected.
PKCE candidate `8f50640` is integrated with Manager callback guard and regression in merge commit `1937317`.
No installation or publication occurred.
The backoff and SSE cleanup fixes are committed and verified offline.

1. Implementation and corrected CLI report are integrated.
2. Browser PKCE is integrated; real approval/token exchange is still unverified and requires the user's sign-in.
3. Keep model-navigation failures visible; avoid repeating paid research unnecessarily.
4. Treat installation/publication and optional receiver deployment as separate work.
5. If source changes after this handoff, rerun proportionate checks before further integration.

Find checkout locations with `git worktree list`; use branch names and commit hashes rather than assuming a worktree path.
Read `docs/release-readiness.md` on the implementation branch for detailed live evidence.
The primary checkout now contains the accepted implementation.

## Coordination

- Manager session owns review and integration.
- Project Lead: `9c5cab43-ebf3-41ff-93ef-b1045e5dee9c`.
- Project branch: `feature/outbound-completion`.
- Latest supervision snapshot: Lead idle, two delegated Agents active.
- SSE implementation assignment is resolved and integrated.
- CLI comparison and corrections are resolved as `result:cli-compare#1` and `result:cli-compare#2`.
- Native `/login` assignment is resolved and integrated at `36f8423`, following `result:login-finish#1`.
- `result:account-api#1` established distinct account-device and research-key PKCE flows; Lead now implements the selected browser PKCE path.
- PKCE implementation is resolved as `result:login-finish#2`, with contract `result:pkce-contract#1`.
  Manager took the follow-up directly after Lead reported missing Herdsman delegation files; no delegation installation was changed.
- Revalidate supervision state before process inspection or stopping work.
- The other paused project, `herdsman/work-6f4f7c3d`, is outside this assignment.

Send assignment-relevant artifacts through tool `files`; a message alone does not transfer them.
Do not restart completed acceptance runs or the running comparison.

## User decisions and authorization

- Exactly three public tools: `web_search`, `interactive_search`, `deep_search`.
- Deep completion uses outbound Task Group SSE, with bounded snapshot polling fallback.
- No public listener, callback URL, tunnel, signing secret, or new daemon is required.
- Signed webhooks remain optional.
- Collection runs while the owning Pi session is open and catches up on restart.
- Lookup-only startup and lazy Task Group creation remain requirements.
- No registry of every Pi session: startup session metadata writes were removed and the old `pi_sessions` table dropped.
- Keep the rename to pi-webtasks; the user clarified that they requested it.
- Keep `WEBTASKS_*` and the new store path.
- Latest user decision supersedes the command/login decision: no `/webtasks` or other registered commands.
- Account/device login, logout, and balance integration are removed; existing credential files remain untouched.
- Credentials resolve on every call: native Pi stored login first, environment `_PARALLEL_API_KEY` then `PARALLEL_API_KEY`, then package-adjacent `.env` or `parallel.env`.
  Standalone receiver uses environment/key-file credentials only.
- Failed result GETs retry once at the next owning-session start; watcher/collector passes do not retry them.
- Model-facing tool guidance has no cost/price references; human-facing price documentation remains.
- `deep_search` locates hard-to-find facts and produces detailed reports, including when ordinary search fails or the user is dissatisfied.
- `web_search` guidance directs models to deep research after a few unsuccessful searches instead of repeated searching.
- No-resubmit safety messages remain, with monetary wording removed.
- Latest requested feature: API-key entry through Pi's own `/login`, opening/showing `https://platform.parallel.ai/settings?tab=api-keys` and using native auth storage.
  This does not restore extension commands or OAuth.
  User subsequently chose Pi's existing provider login behavior, superseding the masked-entry requirement.
  Implement through native provider registration and auth storage; no custom masking, extra commands, dummy models, or Pi runtime UI changes.
- Leave the old store unread; the user accepts leaving its two pending registrations unresolved.
- Implementation and live testing are authorized; installation, publication, and receiver deployment are separate.
- Leave the sibling `pi-parallelized` checkout and its unfinished work untouched.

Spending is allowed, but the user explicitly objects to waste such as repeatedly running expensive searches on the same topic.
The Manager's temporary three-paid-call cap was superseded by the user's explicit approval of scoped acceptance checks.
Approved scope: real mid-run cursor resume, session replacement/reload check, and navigation on the prior three models.
Use low effort, reuse evidence and jobs, and keep each paid call tied to a named check.
There is no blanket prohibition on paid calls and no permission to spend down the account.

The Lead also received a direct user request to compare pi-webtasks against four other CLIs.
The reported comparison plan is about eight tasks, one run per task/arm, low research effort.
Infrastructure repeats must be explained and must not duplicate uncertain paid submissions.
Model costs, research-price estimates, and actual observable charges must be reported separately.

## Implemented behavior

- Private SQLite store is created automatically at `~/.pi/agent/webtasks/webtasks.sqlite`, unless `WEBTASKS_DIR` overrides it.
- Parallel registers as a native API-key provider with zero models, no OAuth, and no extension commands.
  Use native `/login`, "Sign in with an API key", then Parallel; environment/key-file fallbacks remain.
  Key management link: `https://platform.parallel.ai/settings?tab=api-keys`.
  Pi stores the key in its native `auth.json`; no custom account-file reader is restored.
  Stored key is resolved on every request, so mid-session login/logout does not retain a module-level client/key cache.
- Collector opens a group event stream from its saved cursor, takes a group-runs snapshot, then consumes events.
- Cursor advancement and event recording share a SQLite transaction.
- Metadata-matched snapshot recovery can bind uncertain accepted work without resubmission.
- Completion uses the existing result-fetch, saved-artifact, and owning-session notification flow.
- SDK retries are disabled for collector calls; paid creation is never automatically repeated.
- SSE connections have a 10-minute deadline; snapshots have a 60-second deadline.
- Backoff starts at 5 seconds, doubles to 300 seconds, and honors server retry hints capped at 900 seconds.
- Stop/switch aborts and settles collection before the database closes.
- Persistent notification deduplication covers optional-webhook/SSE duplicates.
- `action_required` runs remain watched for later completion.
- Optional receiver default route changed to `/webtasks/webhook`; an old route needs explicit configuration.

These describe reviewed/reported branch behavior, not installed production behavior.

## Verification and commits

Baseline: `453087a`, saved by the Manager because this repository initially had no commits.

Important branch commits:

| Commit | Work |
| --- | --- |
| `21dfcbd` | Outbound completion docs |
| `c288bb8` | SSE and snapshot collector |
| `1cd0eef` | Bench path fix |
| `55a0915` | Independent review fixes |
| `73eeab5` | Remove every-session startup write |
| `920a42f` | Drop old session registry table |
| `d4665e7` | Project/settings/path rename |
| `f57da32` | First live acceptance record |
| `3450752` | Free cursor-resume probe |
| `71d65d2` | Follow-up live acceptance record |
| `67507c3` | Durable-progress backoff and corrected acceptance records |
| `e086691` | Release event and snapshot requests on every pass exit |
| `0a282c1` | Remove commands/account integration; retry failed result GETs once per owning-session start |
| `7f561f3` | Remove tool-price guidance; reposition deep research |
| `36f8423` | Native Parallel API-key provider login, no models, per-call credential resolution |
| `5e81012` | Correct dashboard link to `settings?tab=api-keys` |
| `1937317` | Merge browser PKCE login with malformed callback guard |

Manager reruns at `55a0915`: typecheck passed; tests 169/169; `check:all` exit 0, bench 84/84, curate 361 checks.
Manager reruns at `3450752`: typecheck passed; tests 166/166.
Manager rerun at `67507c3`: `check:all` exit 0, main 169/169, bench 84/84, curate 361 checks.
`npm pack --dry-run --json` listed 20 intended source/documentation files, with no credentials or runtime artifacts.
Manager rerun at `e086691`: `check:all` exit 0, main 172/172, bench 84/84, curate 361 checks.
Three new cleanup tests assert request signals are aborted before collector shutdown.
Implementer reports mutation checks: all three fail on the unfixed revision; releasing only one request fails the other request's tests.
Manager rerun at `0a282c1`: `check:all` exit 0, main 174/174, bench 84/84, curate 361 checks.
New loader assertions verify zero commands; startup retry tests cover successful recovery and repeated failure without watcher-driven retries.
Manager rerun after `7f561f3` and result/error wording cleanup: `check:all` exit 0, main 175/175, bench 84/84, curate 361 checks.
Registered-tool text scan covers descriptions, snippets, guidelines, and nested parameter descriptions.
Whether the revised guidance increases appropriate deep-research use is untested; no further live runs were requested.
Manager rerun at `36f8423`: `check:all` exit 0, main 183/183, bench 84/84, curate 361 checks.
Provider tests cover registration, prompt ordering, empty/cancelled input, stored-key tool use, login/logout during a session, and key secrecy in outputs/artifacts.
Installed Pi 1.1.0 scripted-PTY test in an isolated profile confirmed Parallel listed in `/login` and synthetic credentials saved under `parallel`.
Evidence index: `~/.cache/pi-webtasks-login-evidence/EMPIRICAL.md`.
Manager reran the login-link test at `5e81012`: one selected test passed.
Lead reports full `check:all` passed at that revision; browser navigation to the corrected page has not been rerun by Manager.
Manager rerun for `1937317`: `check:all` exit 0, main 198/198, bench 84/84, curate 361 checks.
Malformed-target regression failed on the candidate with uncaught `ERR_INVALID_URL` and passed with the guard.
It confirms HTTP 400, no token request from malformed input, then a valid callback and one synthetic token exchange.
`npm pack --dry-run --json` lists 22 intended files, no credential or runtime artifacts.
Earlier failures were a test executing before session startup and a stale bench path; both were fixed.

## Live findings

Live runs used detached `d4665e7`, native Pi 1.1.0, private stores, and no callback or receiver.

- Initial SSE completion: accepted quickly while pending; terminal event, one result fetch, one owning-session notice.
- Initial stop/restart did not exercise cursor resume: stopped before a cursor existed.
- Free probe replayed completion using a pre-completion cursor; collector recovery on a store copy produced one fetch and one notice.
- Later live run stopped after a non-null cursor existed; the replacement passed that cursor to the events endpoint and collected completion once.
- Default-model navigation (`anthropic/claude-haiku-5-5`) passed search, deep submission, notification, and saved-reference reading.
- `anthropic/claude-sonnet-5-5` navigation passed.
- `antigravity/gemini-3.7-flash` covered the tools but repeated entity lookup three times and made extra searches.
- `openai-codex/gpt-6.1-sol` received completion, but its follow-up did not settle within 180 seconds; cause undetermined.
- RPC `switch_session` to the same session replaced the runtime and delivered a notice.
  This is session replacement evidence, not a true extension `/reload` check.
- Citation checks support Rust's six-week cadence, Go's six-month cycle, the cited 2024 releases, and Rust's Leadership Council.
  The Rust Foundation page returned 403; its claims and later 2026 dates remain unverified.

First batch: three paid research calls, published-price estimate $0.051.
Corrected follow-up count: 25 paid calls and about $0.219 estimated; one saved-reference read was removed from the earlier count of 26.
Cumulative acceptance: 28 paid provider calls, about $0.270 estimated.
Actual billed costs were not observable; do not call these estimates measured charges.
Research estimates exclude model inference costs.

Evidence:

- First logs: `~/.cache/pi-webtasks-live/runs/20261008T012130Z/logs/`.
- Direct answer: `~/.cache/pi-webtasks-live/runs/20261008T012130Z/artifacts/20261008-012323-68cf8v.json`.
- Free probe: first logs directory, `cursor-probe.jsonl`.
- Follow-up logs: `~/.cache/pi-webtasks-live/runs/20261008T-gaps/`.
- Real cursor resume: follow-up directory, `cursor/logs/run.jsonl`.
- Native artifacts: `~/.pi/agent/webtasks/results/`.
- Detailed filenames and check results: branch `docs/release-readiness.md`.

Manager confirmed the first artifacts exist.
Manager inspected the real cursor-resume log: replacement opened with the saved cursor, one result fetch, one notice.
Its `ok:false` runner summary reflects a check performed 1 ms before the replacement-open log; the subsequent log establishes matching cursor use.
Other follow-up conclusions rely on the Lead's report and committed acceptance record.

## Remaining work and limits

- Backoff fix/tests, paid-call recount, first-run wording, and the legacy-store decision are committed in `67507c3`.
- SSE cleanup gap is fixed in `e086691`: deadline cleanup also aborts its request controller.
  Previously snapshot failure or a no-work early return could abandon an opened, unconsumed event request.
  Snapshot request release is covered too; the cleanup reason is distinct from deadline expiry.
- Native `/login` caveat: installed source routes `secret` through a plain input and echoes the submitted key.
  Source evidence reported by Lead: `interactive-mode.js:5219/5228`, `login-dialog.js:43,62–63`, and pi-tui input rendering at line 343.
  Zero-model providers appear feasible and native auth can resolve stored credentials at call time, but picker/startup behavior is not empirically verified.
  The original phase made no changes or real credential writes.
  User resolved this blocker with "the same way any provider is registered"; standard native login is now implemented.
  Verification used synthetic keys/profiles, leaving actual credentials/settings untouched.
  After saving the key, Pi prints that Parallel has no default chat model and suggests `/model`; the credential is saved despite that message.
  Zero models were retained rather than adding fake picker entries.
  `--list-models` showed no Parallel models; the actual `/model` TUI picker was not opened.
  A human login with real credentials has not been exercised.
  Fixing Pi's prompt or post-login message is outside this scope.
  Manager verified existing settings load this primary checkout; no settings change or separate install is needed, just reload/restart.
- OAuth decision and implemented flow: browser PKCE `/getKeys/` with research-key access, alongside native API-key paste.
  Device Account API `/getServiceKeys/` tokens are account-only and were not selected.
  PKCE implementation must verify exact client registration, redirect URI, authorization/token fields, expiry and refresh semantics.
  Use a temporary loopback-only listener, cryptographic state and PKCE S256, callback validation, cancellation/timeout, and cleanup on every outcome.
  Preserve native provider id `parallel`, native credential storage, existing API-key credentials, zero chat models, three tools, and no extension commands.
  The old account helper requested broad mutation scopes, including `balance:add`; those must not become defaults without justification.
  Chosen PKCE scope excludes account administration, key/app creation, balance/credit operations, and public webhook infrastructure.
  Implementation and synthetic isolated callback/auth tests are authorized; real auth calls or credential/settings writes are not part of this verification.
  Lead must supply official contract evidence, implementation commit, native-login evidence and `check:all` results before integration.
  Contract supplied in `result:pkce-contract#1`; candidate implementation `8f50640` adds native `auth.oauth` alongside `auth.apiKey`.
  Token is a long-lived research API key, so its OAuth wrapper uses `Number.MAX_SAFE_INTEGER` expiry and no-network refresh.
  Manager reran candidate `check:all`: main 197/197, bench 84/84, curate 361 checks.
  Synthetic native-PTY evidence: `~/.cache/pi-webtasks-login-evidence/pkce/EVIDENCE.md`.
  Menus/authorize URL and loopback binding/cancel/deny/bad-state cleanup passed; no real browser approval or live token exchange was attempted.
  Manager's raw local probe `GET http://[ HTTP/1.1` crashed at `parallel-oauth.ts:112` with uncaught `ERR_INVALID_URL`.
  Manager implemented the minimal parsing guard and regression after taking the Lead's offered handoff.
  Malformed input now returns 400, makes no token request, and allows subsequent valid auth.
  README accurately states that the listener remains open during the manual-paste prompt after 120 seconds.
  Callback page reports authorization received rather than falsely claiming sign-in finished before token exchange.
  Implemented login path: reload/restart Pi, `/login` → Sign in with an account → Parallel, approve in browser and select an existing key or create one.
  Callback/paste handling uses state and PKCE; the listener closes after success/error/cancel.
  No real credentials/auth/account/research calls occurred during implementation or review.
- The Manager observed the old `~/.pi/agent/parallelized/webhooks/webhooks.sqlite`: 28 events, 57 registrations, 55 done and 2 pending.
  Preserve that file; leave it unread by the new implementation as requested.
- Optional receiver/offline-owner behavior is not live-verified; it requires a separate authorized deployment.
- Two processes can fetch the same completed result; this can create another artifact but not another paid submission.
- Notification deduplication rows currently have no pruning policy.
- `scripts/live-check.ts` still refers to retired tools, including `account.balance`, and is outside `check:all`.
  Unused legacy operation helpers remain; cleanup was not included in the command-removal scope.
- CLI report commits `06279df` and `4afd5ce` were cherry-picked to `master` as `3a2b90f` and `8b6b9d6`; only `docs/cli-comparison.md` changed.
  Eight tasks ran across four existing CLI panes and five Pi arms, using implementation `d4665e7`.
  Manager checked the corrected grade sheet: Claude has seven passes and one partial.
  Reconciliation uses unique toolCall IDs joined to store rows by session: 80 query searches, 62 extract dispatches, and two medium interactive calls.
  Earlier effort histograms counted repeated stream events, not requests.
  Five cells are contaminated by reads of gold/rubric files; default Pi used mixed models, not the settings default.
  None of the Pi arms submitted `deep_search`; this is limited to the tested prompts and conditions.
  Some research calls used medium/high effort despite the low-effort scope.
  Research charges were not observable: corrected estimate $0.434–$0.436 from the 2026-09-20 price snapshot.
  This includes $0.224 searches, $0.100 interactive calls, and $0.110–$0.112 for 110 SKU-counted excerpts versus 112 URL arguments.
  Pi catalog-based model-cost estimates sum to about $7.97, not invoices.
  Other CLIs' charges are unknown.
  Raw artifacts: `~/.cache/pi-webtasks-compare/`; grades: `analysis/grades-corrected.json`; counts: `analysis/call-reconciliation.json`.
  Do not infer an overall ranking or repeat paid trials to repair these reporting issues.
- `master` includes the accepted implementation through `1937317`.
  No production install, publication, login migration, or receiver deployment has been completed by this Manager.
