# pi-webtasks

Session-bound web research for Pi, with a local evidence store.

The extension owns transport, storage, indexing, recovery, and delivery. The model
owns the research work: what to search, what to read, and what to ask. Nothing
exposes SQL, provider ids, file paths, or raw HTTP.

## Install

```sh
pi install npm:pi-webtasks
```

Then run `/login` in Pi and choose **Parallel** (see [Credentials](#credentials)).

## Status

Five tools, split by who writes the answer. The agent writes it from pages it
reads (`web_search`, `web_fetch`), or a Parallel research agent writes it
(`web_answer`, `web_research`):

| Tool | Work |
| --- | --- |
| `web_search` | Find pages for an objective and 1-3 keyword queries; store the ranked sources and excerpts and return handles. |
| `web_fetch` | Read known http(s) URLs (pages, PDFs) into the same store, as focused excerpts or full content. |
| `web_answer` | Ask Parallel's research agent (Responses API) for a cited answer in seconds, and follow up in the same conversation. |
| `web_research` | Hand a research job to Parallel's deep-research agent (Task API) in the background: a cited report or structured fields with per-field citations. `core` is the processor floor and `ultra2x` the most an agent may choose; progress and completion arrive as alerts. |
| `web_recall` | Search stored evidence, or read one item by handle in bounded slices. |

The agent-facing wording (tool descriptions, guidelines, receipts, and errors)
describes Parallel's capabilities and what to do next. It does not expose the
extension's policies or plumbing: processor limits, event streams, and the
store stay internal. `tests/tool-wording.test.ts` checks that every guideline
names its own tool, because Pi merges all guidelines into one list.

There are no webhooks, no background receiver, no artifact files, and no awkward
effort tiers. Collection happens inside Pi; if Pi is closed, collection stops
and the next session reconciles provider state where retention permits.

## Background research

`web_research` requires an explicit output contract: either `output_schema` (a
JSON Schema object) for fields, or `output_description` for the cited text report
you want. The extension never invents one, and never relies on the provider's
`auto` default. It submits once and returns a receipt. The run's event stream is
collected while Pi is open: every event is recorded, and interim findings become
stored evidence as they arrive, so `web_recall` can read partial results
before the run finishes. Progress messages and source statistics feed the
progress alerts. If the stream drops, it reconnects with backoff (3 s up to
5 min).

Alerts wake an idle session and queue behind a busy one; they never steer or
interrupt active work. Progress updates follow one third of the lower published
upper-latency estimate per processor (for example `core` every 1m40s). They are
reminders to look, not deadlines or completion percentages. Completion, failure,
and action-required alerts are immediate. A closed stream is never treated as
completion: the provider's run status decides.

Alerts are persisted before delivery and delivered at-least-once: an alert stays
unacknowledged until the agent reads that run, and a new runtime offers
unacknowledged alerts again rather than losing them. Do not expect exactly-once.

Task runs carry the local reference in their metadata inside the session's Task
Group, so a crash between submission and recording the provider id is recovered
from the group instead of resubmitting. `core` is the processor floor
(`lite`/`base` are not offered for research) and `ultra2x` is what an agent may
choose; the configured default is `core` (`WEBTASKS_TASK_PROCESSOR` overrides).

## How evidence behaves

- Every Search and Extract result is stored in `research.sqlite` under the Pi
  session that requested it (`WEBTASKS_DIR`, else `<agent-dir>/webtasks`).
- The model sees a bounded receipt with stable handles, never the whole corpus.
  `web_recall { handle }` returns a bounded slice plus the next offset;
  `web_recall { query }` searches stored text and returns handles.
- Evidence belongs to one Pi session. A handle from another session behaves
  exactly like a missing one, so nothing leaks across sessions.
- Receipts return a local **context handle**. Passing it as `context` to a later
  `web_search`/`web_fetch` keeps related calls in one provider research session;
  the provider id itself never leaves the store.
- A paid call is recorded before it is sent and is never retried automatically.
  Replaying the same Pi invocation returns what is already stored instead of
  paying twice; an interrupted request is marked `uncertain`, not silently
  resubmitted.
- Retrieved text is untrusted material, not instructions.

## Development

Requirements: Node.js 22.19 or later, npm, and Pi 1.1 or later.
The only runtime dependency is the pinned `parallel-web` SDK. SQLite uses Node's
built-in implementation.

```sh
npm ci
npm run check
```

`npm run check` runs the type checker and the offline suite. The offline suite
uses real SQLite in temporary directories and a stubbed HTTP layer; it makes no
paid request. `PI_PACKAGE_DIR` selects another installed Pi package directory for
runtime tests.

`node scripts/extract-tool-schemas.ts <dir>` dumps the registered tools exactly
as the model sees them.

`npm run smoke:pack` packs the package, installs the tarball into a scratch
project, and loads it through Pi's real extension loader.

CI (`.github/workflows/ci.yml`) runs the type checker, the suite, and the pack
smoke test on Node 22.19 (the engines floor), 24, and 26, plus Pi 1.1.0 (the
peer floor).

## Releasing

Releases publish from GitHub Actions through npm trusted publishing (OIDC), so
no npm token is stored anywhere and every version carries a provenance
attestation.

```sh
npm version patch        # or minor / major: bumps package.json, commits, tags vX.Y.Z
git push --follow-tags   # the tag runs .github/workflows/publish.yml
```

The publish workflow reruns CI, refuses a tag that does not match
`package.json`, publishes, and creates the GitHub release.

One-time setup:

1. Publish the first version by hand, because npm attaches a trusted publisher
   only to a package that exists: `npm login`, then `npm publish`.
2. On npmjs.com, open the package's **Settings > Trusted publishing**. Add GitHub
   Actions with user `JangMan-J`, repository `pi-webtasks`, workflow
   `publish.yml`, and environment `npm`.
3. Optional but recommended: under **Publishing access**, choose *Require
   two-factor authentication and disallow tokens*.

Retired experiments, benchmarks, and the pre-rewrite implementation live in
`.archive/` (git-ignored). `npm run docs:snapshot` refreshes the Parallel docs
mirror into `docs/parallel/` (git-ignored); the design record and API notes live
there too, outside version control.

## Credentials

Run `/login` in Pi and choose **Parallel**. Pi offers two sign-in methods:

- **Browser sign-in** (listed under *Sign in with an account*). Pi opens
  platform.parallel.ai in your browser. There you approve the request for
  `127.0.0.1` and select an existing API key or create one. Pi receives the
  approval on a temporary listener on `127.0.0.1`, exchanges it for the key, and
  stores it. The listener accepts one callback and closes on success, error, or
  cancel. After 120 seconds, Pi offers a prompt for the callback address from the
  browser's address bar, for example over SSH without port forwarding. The
  listener stays open while that prompt waits, so a browser callback can still
  complete sign-in.
- **API key** (listed under *Sign in with an API key*). Paste a key from the API
  keys page on platform.parallel.ai.

An empty entry stores nothing. Parallel adds no models, so the model picker is
unchanged. The extension registers no commands.

The stored login is used first. Without one, the extension uses
`_PARALLEL_API_KEY` (`PARALLEL_API_KEY` is also accepted), then a key in `.env` or
`parallel.env` beside the package manifest. Exported settings take precedence
over the key files. The key is resolved on every call, so a login or logout takes
effect on the next request. Credential files are not packaged or committed.

Do not install `@parallel-web/pi-extension` alongside this package: it registers a
`web_search` tool with the same name, so the two would collide.

Balance is not shown by the extension; check the provider account directly. Do
not paste credential values into tool arguments, diagnostics, or source files.

## Limits

- Search, Extract, and Answers are synchronous calls; only research tasks run in
  the background.
- `web_recall` returns bounded pages and slices, never a whole corpus in one
  call. A page cursor carries its own search, so `web_recall { cursor }`
  alone continues it.
- Collection stops when Pi closes. Intermediate progress from while Pi was closed
  is not replayed by the provider; completed results are recovered where the
  account's retention policy allows.
- Stored evidence is private data under the agent directory; retention and
  cross-session visibility are still open decisions.
