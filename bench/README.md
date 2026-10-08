# Reduced benchmark harness

This harness compares the frozen extension with Parallel CLI, the supplied Pi-adapted skills, and the Responses helper.
The protocol is in `docs/benchmark-plan.md`.

## Scope

The default schedule contains three pilot pairs and twelve primary pairs: 30 worker runs.
Both arms use Kimi-K3-fast with low reasoning, unrestricted network access, and the same find-docs skill.
Optional replication and diagnostics remain disabled.

The extension image has no CLI installation.
The CLI image has no extension mount.
Each worker receives a fresh workspace and profile.
Gold packets, other runs, and host instructions stay outside the containers.

The gateway holds the real Parallel key.
Workers receive random run tokens that authorize only their own bounded requests.
The ledger starts with the previous $0.024 smoke liability.
Its plan cap is $13, below the user's absolute $25 Parallel-usage ceiling.
Model usage does not debit that ceiling.

## Verification

Run the offline tests:

```sh
node --test bench/*.test.ts
node bench/curate.ts
npx tsc --ignoreConfig --types node --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck bench/*.ts
```

The gateway tests use a mock upstream.
The observer tests use the installed Pi dispatch path with a mock model transport.
Neither suite calls paid APIs.

## Preparation

Use the tested Podman image already recorded in `docs/benchmark-preflight-results.json`.
The host needs Pi 0.86.1, its selected model credentials, and Secretspec access to `PIPARA_API_KEY`.

```sh
node bench/prepare.ts --prepare
node bench/prepare.ts --freeze
node bench/preflight.ts
```

Preparation exports the extension from its pinned commit.
It copies the baseline files without changes and verifies their hashes.
A wrapper resolves the skill's `npx ctx7@latest` command to the common frozen Context7 0.5.11 package.
Other package and network routes remain available.

The Responses helper remains byte-identical to the supplied file.
Its transport adapter redirects only the hardcoded Responses URL to the gateway.
Offline tests verify payload, header, and argument parity.

## Execution

The following commands make funded requests.
Do not rerun attempted pairs to replace unfavorable results.

```sh
node bench/run.ts pilot
node bench/grade.ts pilot
```

Before primary execution, inspect the pilot events and record `pilot-acceptance.json` in `.pi/benchmark/data/`.
The acceptance record must confirm prompt catalogs, timestamps, token accounting, follow-ups, limits, and absence of harness faults.
After a pilot harness correction, freeze the manifest again and repeat the offline preflight.

```sh
node bench/prepare.ts --freeze
node bench/preflight.ts
node bench/run.ts primary
node bench/grade.ts primary
node bench/grade.ts primary --reconcile
node bench/summarize.ts
```

The runner refuses an existing pair directory with a prior attempt record.
It does not silently restart failed or interrupted pairs.
A stale `runner.lock` requires inspection of the recorded process and containers before removal.

The two graders run independently through the host's authoritative OAuth storage.
They do not receive cloned refresh tokens.
The reusable container credential wrapper also preserves rotated OAuth records under the host auth lock.
Primary workers use the selected Fireworks API credential and delete each disposable credential file after use.

## Records and limits

Local records live in `.pi/benchmark/data/`.
They include event IDs, redacted provider prompts, tool results, answers, usage, timing, and gateway liabilities.
The final human-readable report is `docs/benchmark-results.md`.

The gateway supports bounded Search, Extract, Responses, Task, and Task Group requests.
It denies unpriced endpoints, unknown price-sensitive fields, foreign research IDs, recurring services, and account mutations.
It does not block general internet access.
FindAll, memory scopes, external MCP servers, and webhook destinations are outside this benchmark's live spending boundary.

Each retry requires a new reservation before dispatch.
Errors and timeouts retain their full liability.
The ledger does not call conservative liability an invoice charge.

Failed worker runs remain outcomes.
Unsuccessful resolutions count at the common deadline in the restricted-time analysis.
Only settled judgments enter the primary scored analysis.
Unresolved adjudication prevents a superiority claim.
The second rating round exposes disagreements to both raters without averaging their scores.
The original six disagreements stay on record. `bench/final-adjudication.json` is a later Grok overlay that copies disputed fields from a named original rater against frozen gold and traces. It is not a third independent model and does not rewrite rater files. `node bench/summarize.ts` rebuilds reports from those records without calling graders or workers.

Webhook notifications are unnecessary for the default cases.
The adjacent receiver's offline verifier tests do not prove a real signed delivery or reboot persistence.
No receiver or Funnel change is part of this harness.
