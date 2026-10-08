# Readable evidence evaluation

Date: 2026-09-21 UTC. Implementation: Gemini 3.8 Flash. Independent verification: Main.

This report describes the original presentation change. The [council implementation](council-implementation.md) adds short filenames, complete excerpts, field maps, and routing checks.

## Scope

This evaluation covers Search and Extract presentation in `src/evidence.ts`.
The fixtures under `tests/fixtures/evidence/` are synthetic, not historical API responses.
They reproduce truncation and navigation problems reported in `docs/benchmark-results.md`.
These checks do not establish better model behavior or answer quality.

## Changes

- A source index at the start of each Markdown companion lists every source and its excerpt and full-content line ranges.
- When the first five sources consume the preview budget, the preview still points to this index.
- Null and absent excerpts no longer force a fallback to JSON.
- Sources without excerpts report `Saved excerpts: none returned.` instead of a pointer to an empty line.
- Receipt diagnostics, counts, and control fields retain JSON serialization.

The API requests, source order, raw JSON artifacts, and 8,000-character preview limit remain unchanged.
`PIPARA_OUTPUT_FORMAT=json` returns the original JSON receipt and creates no Markdown companion.
Presentation failures also return that receipt without another API request.

## Offline comparison

| Synthetic case | Original JSON preview | Readable output |
| --- | --- | --- |
| Decisive fact in a later excerpt | The preview omits the fact. | One advertised line-range read returns the complete excerpts. |
| Requested full content | The agent must inspect the JSON structure. | A separate line range identifies the saved full content. |
| Nine sources, large first five | The preview omits later sources. | One index read finds source 9. A second read retrieves its evidence. |
| No excerpts returned | No usable evidence range exists. | The preview states that no excerpts returned. |

The original benchmark recorded duplicate extraction and unsuccessful artifact searches.
It did not establish that presentation alone caused those failures.

## Verification

Run the focused checks:

```sh
node --test tests/evidence.test.ts
npm run typecheck
```

Main reran the evidence suite: 12 tests passed, with no failures.
The tests cover exact line ranges, full-content states, Unicode, source order, file mode, private permissions, metadata, and fallback.
They also verify fixture credential redaction and registered-tool request parity between both presentation modes.

Main also used the actual `read` tool on a nine-source synthetic result:

- The preview contained 7,839 characters and omitted source 9's evidence.
- The advertised index occupied lines 6–14.
- Reading that index located source 9 at line 84.
- Reading line 84 returned `evidence-9`.

The local probe receipt is `.pi/verification/evidence/latest-probe.json`.
No research API request or model benchmark rerun occurred.

## Remaining empirical question

A new paired model evaluation is needed to determine whether agents use these pointers reliably and reduce unnecessary retrieval.
Offline tests cannot settle that question. No such paid rerun is part of this implementation.
