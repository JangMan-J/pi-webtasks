# CLI web research comparison

One run per task per arm, 2026-10-08. This is not an SSE completion acceptance record. No arm is ranked overall. Cells differ by model, account, system prompt, tool surface, and whether the saved text was complete.

## Method

Native Pi 1.1.0 loaded only the throwaway checkout `d4665e7e2dbc5549394de34125f8a1f069be26c6` (`pi --no-extensions -e <checkout>/src/index.ts`), with `WEBTASKS_DIR` under `~/.cache/pi-webtasks-compare/webtasks` and `WEBTASKS_WEBHOOK_URL` unset for those processes. The other four CLIs were driven in the panes the user had opened, via `herdr agent prompt`, one prompt at a time. Headless mode was not needed for them. Their settings files were not edited. Muse and agy blocked on per-request network or command prompts; those were answered with session- or one-shot allows. Persist-to-settings options were not selected. The Muse pane already showed "Permissions changed to Unrestricted" before the first comparison prompt; this run did not choose that option.

Prompts were the same text for every arm (`~/.cache/pi-webtasks-compare/prompts.json`). No tool names were added. The rubric was written before the first paid call (`~/.cache/pi-webtasks-compare/rubric.json`, 2026-10-08T02:48:36Z). Gold items use `bench/gold-round2.json` acceptable minimums, deterministic facts, and traps. `bench/r2-grade.ts` was not executed: it expects the round-2 benchmark layout and two extra grader models. Grading used those published criteria on the saved answer text. The first pass did not receive arm labels (`analysis/grades-blind.json`). Keyword checks false-failed some correct wordings; those cells were corrected after reading the answer (`analysis/grades-corrected.json`).

Citation spot-check: up to two URLs from each saved answer, fetched with free HTTP. 102 fetches, 79 HTTP 200, 55 of those pages contained a rubric token that also appeared in the answer. A token on the page is not a full claim check. Fetches that failed are not counted as support.

Pi research-tool default effort is `low` (`src/research.ts`). Deduped tool calls still include medium and high query dispatches. That is recorded in the call table, not treated as a uniform low-effort run. No run was repeated. `pi-sonnet` people-board logged `database is locked` and still returned a `web_search` answer; that call was not repeated.

## Versions and models

| Arm | Route | Version | Model actually used | Account / login |
| --- | --- | --- | --- | --- |
| grok | herdr `w3:pG` | grok 1.0.46 (2765805b9442) | `grok-4.7-build-fast`, effort high, always-approve | grok.com login already in the pane |
| muse | herdr `w3:pH` | Muse Code 1.4.3 | `muse-spark-1.3-contributor`, effort max | pane login; session network allows only |
| claude | herdr `w3:pK` | Claude Code 2.1.293 | `claude-sonnet-5-5`, effort medium, bypass permissions | pane login |
| agy | herdr `w3:pJ` | Antigravity CLI 1.3.1 | Gemini 3.8 Flash, medium, accept-edits | Google AI Ultra login shown in the pane |
| pi-sonnet | headless Pi | Pi 1.1.0 | `anthropic/claude-sonnet-5-5`, thinking medium | Pi Anthropic auth. Matches the Claude Code model id, not its system prompt |
| pi-grok | headless Pi | Pi 1.1.0 | `xai/grok-4.7`, thinking high | Pi xAI auth. `grok-4.7-build-fast` is not in Pi's catalog; this is not the grok build model |
| pi-gemini | headless Pi | Pi 1.1.0 | `antigravity/gemini-3.8-flash`, thinking medium | Pi antigravity catalog entry, not the agy CLI account |
| pi-muse | headless Pi | Pi 1.1.0 | `meta/muse-spark-1.3-contributor`, thinking max | Pi meta catalog entry, not the Muse Code pane login |
| pi-default | headless Pi | Pi 1.1.0 | not one model | no `--model` flag. Settings say `anthropic/claude-haiku-5-5`. The transcripts did not use that id |

`pi-default` transcript models: `openai-codex/gpt-6.1-sol` (people-board, rust-current), `openai-codex/gpt-6-astra` (url-cbm, synth-litellm, fireworks), `anthropic/claude-fable-5-1` (xai-transport, portal-kde, deep-codex). The process inherited `PI_MODEL=grok-4.7`, `PI_PROVIDER=xai`, `PI_REASONING_LEVEL=high`, and `PI_OFFLINE=1`. Those variables do not explain the three transcript models. Searches still completed with `PI_OFFLINE=1`. This arm is not a settings-default comparison.

Native web tools observed, not a full tool list: Claude used WebFetch and WebSearch. Grok's pane shows web search/fetch in its help (`--disable-web-search` exists) and cited fetched pages. Muse logged "Searched web" and "Fetched". Agy logged searches, page reads, and `curl`, behind one-shot command prompts. On these prompts, Pi called `web_search` and, twice, `interactive_search`. The private store has zero `research` rows for these sessions. That is not a finding about whether `deep_search` is chosen in other conditions.

## Tasks

| Id | Kind | Prompt source |
| --- | --- | --- |
| people-board | people / companies | rubric written from https://www.anthropic.com/company before the runs |
| rust-current | current fact | rubric from https://blog.rust-lang.org/2026/10/01/Rust-1.99.0/ and the Rust homepage, fetched before the runs. Required: 1.99.0, announced 2026-10-01 |
| url-cbm | known URL | gold Q4, URL in the prompt |
| synth-litellm | cited synthesis | gold Q8 |
| fireworks | pinned contract | gold Q1 |
| xai-transport | cited synthesis | gold Q2 |
| portal-kde | cited synthesis | gold Q7 |
| deep-codex | deeper research | gold Q5. Under these prompts and model conditions, zero `research` rows were stored |

## Results

P pass, ~ partial, I incorrect, U saved text missing the decisive sentence, C trace read grader-only gold or the prewritten rubric (not counted as independent research).

| Task | grok | muse | claude | agy | pi-default | pi-sonnet | pi-grok | pi-gemini | pi-muse |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| people-board | P | P | P | P | P | P | P | P | P |
| rust-current | P | P | P | P | I | P | P | P | P |
| url-cbm | U | P | P | P | P | P | P | P | P |
| synth-litellm | P | P | P | P | P | P | P | P | P |
| fireworks | ~ | P | P | C | P | P | P | P | P |
| xai-transport | P | P | P | C | P | P | P | P | P |
| portal-kde | ~ | P | ~ | C | P | ~ | P | P | C |
| deep-codex | ~ | P | P | C | P | P | P | P | P |

Checked failures and non-passes:

- `pi-default` rust-current answered Rust 1.98.1 on 2026-09-03. The pre-run fetch of the official announcement was 1.99.0 on 2026-10-01.
- grok url-cbm: the saved pane text quotes `rpc_is_allowed_for_ui` and says a complete client needs more methods, but it does not contain `list_projects` or `get_code_snippet`. The pane scrollback is short. Not scored as wrong.
- fireworks grok, portal-kde grok, deep-codex grok: the saved pane text has some required facts and not others. Grok's alternate screen does not keep the whole answer. Those cells stay partial rather than being inferred.
- portal-kde claude and pi-sonnet: both unit names are in the saved text; the false-negative sentence was not.
- agy fireworks, xai-transport, portal-kde, and deep-codex read `bench/gold-round2.json` and `bench/gold-round2-references.json` from the worktree. Those four are contaminated.
- pi-muse portal-kde read `~/.cache/pi-webtasks-compare/rubric.json`, which already stated both unit names. Contaminated.
- pi-grok fireworks: a tool result listed `gold-round2.json` among checkout paths. A read of the reference text was not confirmed. The cell stays a pass on the answer text, with that exposure noted.

People-board passes include Claude, agy, and pi-sonnet, which named the six directors and kept the LTBT trustees off the board. The first keyword pass had marked those incorrect.

## Per-arm notes

These are observations from this run, not strengths of the product in general.

- Grok build answered several items in the pane and cited pages. Three gold items are only partial in the saved scrollback, so the pane transcript is a weak record for long answers. Model is `grok-4.7-build-fast`, which Pi could not match.
- Muse Code met the rubric on the saved text for 8/8, after the synth-litellm wording was reread. It stopped for a network allow on several hosts. Session allow was used; settings were not written by this run. Effort in the pane was max, not low.
- Claude Code met the rubric on 7 of 8 saved texts. The other cell is portal-kde, partial. That matches `~/.cache/pi-webtasks-compare/analysis/grades-corrected.json` and a reread of the saved Claude answers. A 6/8 count does not. It used WebFetch summaries and said so. It also ran shell commands in the user's worktree, including a scratchpad under `/tmp`.
- agy met the four early tasks. The four later tasks read the gold files in the worktree, so they are not evidence about its web tools. Command allows were one-shot; persist-to-settings was not selected.
- Pi with an explicit model id stayed on that id. On these runs the research tools that dispatched were `web_search` and two `interactive_search` calls. Zero `research` rows were stored for these sessions; that does not say `deep_search` is unused in general. pi-grok and pi-gemini also used a lot of `bash`/`read` against local files, including, in the cases above, grader files. That is a confound against "native web tool" and against isolation.
- pi-default is not interpretable as the settings default. It also gave the one clear current-fact miss (Rust 1.98.1).

## Calls, time, and cost

Wall time is `herdr agent prompt --wait` or the Pi process, not time-to-first-token. Herdr wait returned when the pane went idle, done, or blocked.

| Arm | Tasks | Wall sum (s) | Median (s) | Pane or local tools |
| --- | --- | --- | --- | --- |
| grok | 8 | 535 | 64 | no tool ledger in the pane |
| muse | 8 | 250 | 21 | "Searched web" / "Fetched" lines; no call ledger |
| claude | 8 | 204 | 26 | WebFetch and WebSearch visible; no call ledger |
| agy | 8 | 101 | 11 | searches and `curl` behind prompts; no call ledger |
| pi-default | 8 | 404 | 47 | 29 `bash`, 5 `read`, plus the research split below |
| pi-sonnet | 8 | 206 | 30 | 9 `bash`, plus the research split below |
| pi-grok | 8 | 655 | 66 | 72 `bash`, 37 `read`, plus the research split below |
| pi-gemini | 8 | 323 | 47 | 42 `bash`, 4 `read`, plus the research split below |
| pi-muse | 8 | 397 | 44 | 31 `bash`, 9 `read`, plus the research split below |

Pi research counts are unique `toolCall` ids in `raw/pi/<arm>/*.jsonl`, joined to the private store on the Pi session id. Repeated streamed copies of the same id are not requests. An earlier histogram counted those copies and did not match the deduped calls. The table below replaces it.

Store rows for these session ids: 80 completed `search`, 62 completed `extract`, 2 completed `conversations`, 0 `research`, 0 failed status rows, 0 store sessions outside these Pi runs. Query-search calls equal `search` rows per arm. URL-read calls equal `extract` rows. The two `interactive_search` calls equal the two conversation rows. No entity lookup was in the tool calls or the store. No call carried `effort` together with `urls` or `entity`, so none was rejected before dispatch on that rule.

| Arm | Query low/fast | No effort given (default low/fast) | Query medium/basic | Query high/advanced | URL reads (extract) | Entity lookups | Rejected before dispatch | Interactive |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pi-default | 2 | 0 | 3 | 1 | 12 | 0 | 0 | 0 |
| pi-sonnet | 0 | 2 | 2 | 0 | 6 | 0 | 0 | 2 medium |
| pi-grok | 8 | 2 | 16 | 1 | 19 | 0 | 0 | 0 |
| pi-gemini | 0 | 24 | 0 | 0 | 14 | 0 | 0 | 0 |
| pi-muse | 6 | 0 | 10 | 3 | 11 | 0 | 0 | 0 |
| Total | 16 | 28 | 31 | 5 | 62 | 0 | 0 | 2 medium |

Those 80 query calls are the 80 completed search rows. The 62 URL reads are the 62 completed extract rows. Medium and high query calls, and the two medium interactive calls, are an execution deviation from the low-effort brief. They are not rewritten as low. Omitted effort is the extension default, low, not a tier column in the store. Store artifacts record `sku_search` or `sku_extract_excerpts` and do not record the search tier. The tier split is the deduped tool-call argument.

For these prompts, tasks, and model conditions, `deep_search` was not among the deduped tool calls, and the `research` table has zero rows. That is all this run shows.

Costs, kept separate:

- Model token costs are visible only in the Pi jsonl `usage.cost.total` fields. Summing distinct assistant usage objects gives about $3.69 pi-default, $3.44 pi-grok, $0.44 pi-gemini, $0.36 pi-sonnet, $0.04 pi-muse. These are transcript estimates, not an invoice. The pi-default sum is dominated by `claude-fable-5-1` turns.
- Research-call charges were not read from an account balance. Using `bench/prices.lock.json` (snapshot 2026-09-20, not a live quote) on the reconciled tiers: 44 fast searches (16 explicit low plus 28 omitted-effort) at $0.001 = $0.044; 31 basic at $0.005 = $0.155; 5 advanced at $0.005 = $0.025. Query-search estimate $0.224. The two interactive calls used `effort: medium`; the same snapshot prices Responses medium at $0.05, so $0.100, from the tool argument rather than a store tier column. Extract is $0.001 per URL in that snapshot. The 62 extract dispatches list 112 URLs in the tool arguments and 110 `sku_extract_excerpts` counts in the artifacts. The gap is pi-default only (20 URL arguments, 18 SKU counts). Extract estimate $0.110 to $0.112. Combined research estimate about $0.434 to $0.436. Not an invoice, and not a uniform low-effort bill.
- Grok's session `usage.json` has `costUsdTicks` 109811990800 for `grok-4.7-build-fast` over 9 turns and 70 model calls. The tick-to-dollar unit is not in that file, so no USD figure is stated. Claude's pane shows cumulative token counts (about 213k to 259k across the session) and no price. Muse and agy charges were not visible. Those are unobservable, not zero.

## Confounds

- Different models, thinking levels, and system prompts. pi-grok is not grok build's fast model. pi-gemini is not the agy account. pi-muse is not the Muse Code login. pi-default was not haiku.
- One run each. Eight tasks. A miss or a pass is not a rate.
- Herdr panes kept context across tasks. Pi started a new process per task. Later herdr answers can use earlier tool results. Later agy answers also found the gold files in the worktree cwd.
- Grok and some herdr captures are scrollback-limited. A partial there means the saved text, not a proven wrong answer.
- Claude, Muse, and agy were not low-effort panes. Pi thinking levels matched the other CLI where a model id matched, except the missing grok fast variant. On the deduped query calls, 31 were medium/basic and 5 were high/advanced, plus 2 medium interactive calls. That is an execution deviation from the low-effort brief.
- Local `bash`/`read` let Pi and agy open grader files. That is misuse relative to a web-only comparison, and it happened.
- `r2-grade.ts` did not grade these freeform answers. Citation checks are spot checks, not entailment.

## Paths

- Task list: `~/.cache/pi-webtasks-compare/prompts.json` and `task-order.json`
- Rubric: `~/.cache/pi-webtasks-compare/rubric.json`
- Raw transcripts: `~/.cache/pi-webtasks-compare/raw/herdr/<arm>/` and `raw/pi/<arm>/`
- Extracted answers: `~/.cache/pi-webtasks-compare/answers/`
- Blind grading sheet: `~/.cache/pi-webtasks-compare/analysis/grades-blind.json`
- Corrections after reading answers: `~/.cache/pi-webtasks-compare/analysis/grades-corrected.json`
- Citation fetches: `~/.cache/pi-webtasks-compare/analysis/citations.json` and `cited-pages/`
- Call and effort reconciliation: `~/.cache/pi-webtasks-compare/analysis/call-reconciliation.json`
- This file: `docs/cli-comparison.md`
