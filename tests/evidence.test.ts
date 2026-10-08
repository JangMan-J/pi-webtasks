import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { presentEvidence } from "../src/evidence.ts";
import { PREVIEW_LIMIT, getPreviewLimit, researchOutput } from "../src/results.ts";
import { setup } from "./helpers/test-host.ts";

const source = {
  url: "https://example.org/policy", title: "Official policy",
  excerpts: ["Minor upgrades do not require a dump and restore.", "Support ends November 9, 2028."],
  full_content: null,
};
const payload = { search_id: "search-1", results: [source], warnings: [{ message: "Example warning" }] };

async function fixture(t: Parameters<typeof setup>[0], data: unknown = payload, args: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "parallel-evidence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const receipt = await researchOutput(data, args, { artifactDir: dir });
  return { dir, receipt };
}

test("readable evidence preserves source text, metadata, exact line pointers and private file permissions", async t => {
  const { receipt } = await fixture(t);
  const shown = await presentEvidence(receipt, {}, "readable");
  assert.ok(shown.readableArtifact);
  const markdown = await readFile(shown.readableArtifact, "utf8");
  const lines = markdown.split("\n");
  const match = shown.text.match(/Saved excerpts: lines (\d+)–(\d+)/)!;
  assert.equal(lines.slice(Number(match[1]) - 1, Number(match[2])).join("\n"), source.excerpts.join("\n\n"));
  for (const text of [source.url, ...source.excerpts, "search-1", "Example warning", "Full content: not requested.", "Excerpt preview shortened: no."]) {
    assert.ok(shown.text.includes(text), text);
  }
  assert.equal((await stat(shown.readableArtifact)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(receipt.artifact!, "utf8")), payload);
});

test("small results expose complete fitting evidence in JSON and readable modes", async t => {
  const fact = "PostgreSQL 16 support ends November 9, 2028.";
  const excerpt = `${"Policy context. ".repeat(100)}\n${fact}`;
  const { receipt } = await fixture(t, { results: [{ ...source, excerpts: [excerpt] }] });
  const legacy = await presentEvidence(receipt, {}, "json");
  assert.equal(legacy.text.includes(fact), true);
  const readable = await presentEvidence(receipt, {}, "readable");
  assert.ok(readable.text.includes(excerpt));
  assert.match(readable.text, /Excerpt preview shortened: no/);
  assert.ok(readable.text.length <= PREVIEW_LIMIT);
});

test("large Unicode evidence stays bounded while the companion preserves every source and excerpt", async t => {
  const excerpts = ["👍\n".repeat(3000), "second excerpt", "third excerpt"];
  const sources = Array.from({ length: 9 }, (_, i) => ({ ...source, url: `${source.url}/${i}`, excerpts }));
  const { receipt } = await fixture(t, { results: sources });
  const shown = await presentEvidence(receipt, {}, "readable");
  assert.ok(shown.text.length <= PREVIEW_LIMIT);
  assert.equal(shown.text.isWellFormed(), true);
  assert.match(shown.text, /Excerpt preview shortened: yes/);
  const markdown = await readFile(shown.readableArtifact!, "utf8");
  assert.ok(markdown.includes(excerpts[0]));
  assert.ok(markdown.includes("third excerpt"));
  assert.ok(markdown.includes(sources[8].url));
});

test("full content distinguishes unavailable from saved content with working line ranges", async t => {
  const { receipt } = await fixture(t, { results: [source, { ...source, full_content: "full body\nnext line" }] });
  const shown = await presentEvidence(receipt, { full_content: true }, "readable");
  assert.match(shown.text, /Full content: requested but not returned/);
  const match = shown.text.match(/Full content: saved at lines (\d+)–(\d+)/)!;
  const lines = (await readFile(shown.readableArtifact!, "utf8")).split("\n");
  assert.equal(lines.slice(Number(match[1]) - 1, Number(match[2])).join("\n"), "full body\nnext line");
});

test("publish dates are preserved in preview and companion only when supplied", async t => {
  const dated = {
    results: [
      { ...source, title: "Dated", publish_date: "2026-09-24\nupdated", excerpts: ["dated excerpt"] },
      { ...source, title: "Undated", url: "https://example.org/undated", excerpts: ["undated excerpt"] },
    ],
  };
  const { receipt } = await fixture(t, dated);
  const shown = await presentEvidence(receipt, {}, "readable");
  assert.match(shown.text, /## Source 1: Dated[\s\S]*Publish date: 2026-09-24 updated/);
  assert.doesNotMatch(shown.text, /## Source 2: Undated[\s\S]*Publish date:/);
  const markdown = await readFile(shown.readableArtifact!, "utf8");
  assert.ok(markdown.includes("- Source 1: Dated, publish_date: 2026-09-24 updated — https://example.org/policy"));
  assert.ok(markdown.includes("Publish date: 2026-09-24 updated"));
  assert.ok(markdown.includes("- Source 2: Undated — https://example.org/undated"));
});

test("requested short full content is visible without duplicating excerpt text", async t => {
  const data = { results: [{ ...source, excerpts: ["excerpt-only text"], full_content: "short full body\nsecond line" }] };
  const { receipt } = await fixture(t, data);
  const shown = await presentEvidence(receipt, { full_content: true }, "readable");
  assert.match(shown.text, /Full content: saved at lines \d+–\d+ and shown below\./);
  assert.ok(shown.text.includes("Full content:\nshort full body\nsecond line"));
  assert.equal(shown.text.includes("Retrieved excerpts:\nexcerpt-only text"), false);
  assert.match(shown.text, /0 of 1 excerpts shown/);
  assert.match(shown.text, /Full content shown for 1 source/);
});

test("six or more short sources are all previewed in provider order", async t => {
  const results = Array.from({ length: 7 }, (_, i) => ({
    ...source,
    title: `Short ${i + 1}`,
    url: `https://example.org/short-${i + 1}`,
    excerpts: [`complete excerpt ${i + 1}`],
  }));
  const { receipt } = await fixture(t, { results });
  const shown = await presentEvidence(receipt, { preview_chars: 8000 }, "readable");
  assert.ok(shown.text.length <= 8000);
  let last = -1;
  for (let i = 0; i < results.length; i++) {
    const at = shown.text.indexOf(`## Source ${i + 1}: Short ${i + 1}`);
    assert.ok(at > last, `source ${i + 1} appears in order`);
    last = at;
    assert.ok(shown.text.includes(`complete excerpt ${i + 1}`));
  }
  assert.match(shown.text, /Excerpt preview shortened: no\./);
});

test("tight readable budgets retain identifiers and warnings ahead of extra sources", async t => {
  const args = { preview_chars: 2000 };
  const data = {
    search_id: "keep-search-id",
    warnings: [{ message: "Check source freshness before delivery." }],
    results: Array.from({ length: 20 }, (_, i) => ({ ...source, url: `https://example.org/${i}`, title: `Source ${i}` })),
  };
  const { receipt } = await fixture(t, data, args);
  const shown = await presentEvidence(receipt, args, "readable");
  assert.ok(shown.readableArtifact);
  assert.ok(shown.text.length <= args.preview_chars);
  assert.match(shown.text, /keep-search-id/);
  assert.match(shown.text, /Check source freshness before delivery/);
  assert.match(shown.text, /Source index:/);
});

test("file mode returns no evidence bodies; JSON arm remains byte-for-byte unchanged", async t => {
  const args = { return_mode: "file" };
  const { receipt, dir } = await fixture(t, payload, args);
  const before = await readdir(dir);
  const legacy = await presentEvidence(receipt, args, "json");
  assert.equal(legacy.text, JSON.stringify(receipt, null, 2));
  assert.deepEqual(await readdir(dir), before);
  const shown = await presentEvidence(receipt, args, "readable");
  for (const excerpt of source.excerpts) assert.equal(shown.text.includes(excerpt), false);
  assert.match(shown.text, /Result bodies omitted \(file mode\)/);
  assert.ok((await readFile(shown.readableArtifact!, "utf8")).includes(source.excerpts[0]));
});

test("companions use already-redacted data and never overwrite existing files", async t => {
  const { receipt } = await fixture(t, { ...payload, api_key: "fake-secret" });
  const natural = receipt.artifact!.replace(/\.json$/, ".md");
  await writeFile(natural, "unrelated file");
  const first = await presentEvidence(receipt, {}, "readable");
  const second = await presentEvidence(receipt, {}, "readable");
  assert.notEqual(first.readableArtifact, second.readableArtifact);
  for (const shown of [first, second]) {
    assert.match(basename(shown.readableArtifact!), /^\d{8}-\d{6}-[a-z2-9]{6}-[a-z2-9]{6}\.md$/);
    assert.ok(shown.text.includes(`Readable evidence: ${shown.readableArtifact}`));
  }
  assert.equal(await readFile(natural, "utf8"), "unrelated file");
  assert.equal((await readFile(receipt.artifact!, "utf8")).includes("fake-secret"), false);
  assert.equal((await readFile(first.readableArtifact!, "utf8")).includes("fake-secret"), false);
});

test("presentation failure falls back to the saved JSON receipt without losing identifiers", async t => {
  const { receipt, dir } = await fixture(t);
  const missing = { ...receipt, artifact: `${receipt.artifact}/missing.json` };
  assert.deepEqual(await presentEvidence(missing, {}, "readable"), { text: JSON.stringify(missing, null, 2) });
  // The JSON fits the filesystem's component limit, its natural companion name is
  // taken, and the collision fallback name is too long: no file is claimed or left.
  const longPath = join(dir, `${"x".repeat(248)}.json`);
  await writeFile(longPath, JSON.stringify(payload));
  await writeFile(join(dir, `${"x".repeat(248)}.md`), "unrelated file");
  const before = await readdir(dir);
  const blocked = { ...receipt, artifact: longPath };
  assert.deepEqual(await presentEvidence(blocked, {}, "readable"), { text: JSON.stringify(blocked, null, 2) });
  assert.deepEqual(JSON.parse(await readFile(longPath, "utf8")), payload);
  assert.equal(await readFile(join(dir, `${"x".repeat(248)}.md`), "utf8"), "unrelated file");
  assert.deepEqual((await readdir(dir)).sort(), before.sort());
  const odd = await fixture(t, { results: [{ entity_id: "entity-1" }] });
  assert.equal((await presentEvidence(odd.receipt, {}, "readable")).text, JSON.stringify(odd.receipt, null, 2));
});

test("web_search query and URL paths switch presentation without changing requests, schemas or raw results", async t => {
  const h = await setup(t, () => new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } }));
  for (const [name, args] of [["web_search", { query: "official policy" }], ["web_search", { urls: [source.url] }]] as const) {
    const tool = h.tools.get(name);
    const schema = JSON.stringify(tool.parameters);
    delete process.env.PIPARA_OUTPUT_FORMAT; // Readable is the default.
    const readable = await tool.execute("readable", args, undefined, undefined, h.ctx);
    assert.match(readable.content[0].text, /## Source 1: Official policy/);
    assert.ok(readable.details.readable_artifact);
    process.env.PIPARA_OUTPUT_FORMAT = "json";
    const legacy = await tool.execute("json", args, undefined, undefined, h.ctx);
    assert.ok(JSON.parse(legacy.content[0].text).preview.results);
    assert.equal(legacy.details.readable_artifact, undefined);
    assert.deepEqual(h.calls.at(-1)!.body, h.calls.at(-2)!.body);
    assert.equal(h.calls.at(-1)!.path, h.calls.at(-2)!.path);
    assert.deepEqual(JSON.parse(await readFile(readable.details.artifact, "utf8")), JSON.parse(await readFile(legacy.details.artifact, "utf8")));
    assert.equal(JSON.stringify(tool.parameters), schema);
  }
  assert.equal(h.calls.length, 4, "one API request per invocation, no presentation retries");
});

test("agent reaches evidence beyond preview using one advertised read without guessing JSON keys", async t => {
  // Reproduces benchmark R1/A1 failure shape: decisive fact appears later in excerpts.
  const r1Fixture = JSON.parse(await readFile(join(import.meta.dirname, "fixtures/evidence/r1-nodejs-extract.json"), "utf8"));
  const { receipt } = await fixture(t, r1Fixture);
  const shown = await presentEvidence(receipt, {}, "readable");
  assert.ok(shown.readableArtifact);
  assert.match(shown.text, /Saved excerpts: lines (\d+)–(\d+)/);

  // Read the advertised line range from the readable artifact in one operation:
  const match = shown.text.match(/Saved excerpts: lines (\d+)–(\d+)/)!;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const markdown = await readFile(shown.readableArtifact, "utf8");
  const lines = markdown.split("\n");
  const extracted = lines.slice(start - 1, end).join("\n");

  // Decisive EOL date is accessible in one direct read:
  assert.ok(extracted.includes("End-of-life is scheduled for 2027-04-30."));
  assert.equal(extracted, r1Fixture.results[0].excerpts.join("\n\n"));
});

test("oversized first-five / nine-source response locates omitted sources via advertised source index", async t => {
  // Reproduces case where first 5 sources consume the preview budget, leaving sources 6-9 omitted from excerpt bodies.
  const base = JSON.parse(await readFile(join(import.meta.dirname, "fixtures/evidence/oversized-first-five.json"), "utf8"));
  const fixtureData = {
    ...base,
    results: base.results.map((r: any, i: number) => i === 0 ?
      { ...r, excerpts: [`${r.excerpts[0]}\n${"large budget pressure 👍 ".repeat(500)}`] } : r),
  };
  const args = { preview_chars: 8000 };
  const { receipt } = await fixture(t, fixtureData);
  const shown = await presentEvidence(receipt, args, "readable");
  assert.ok(shown.text.length <= getPreviewLimit(args));
  assert.match(shown.text, /Excerpt preview shortened: yes/);

  // The preview header advertises the exact line range for the compact source index:
  const indexMatch = shown.text.match(/Source index: lines (\d+)–(\d+) in the readable evidence file \(9 sources saved\)/)!;
  assert.ok(indexMatch, "Preview advertises source index line range");
  const indexStart = Number(indexMatch[1]);
  const indexEnd = Number(indexMatch[2]);

  // One read of the advertised source index lines locates all 9 sources, including Source 9:
  const markdown = await readFile(shown.readableArtifact!, "utf8");
  const lines = markdown.split("\n");
  const indexLines = lines.slice(indexStart - 1, indexEnd);
  assert.equal(indexLines.length, 9, "Source index contains an entry for every source");

  // Source 9 entry contains URL and exact line pointer:
  const source9Line = indexLines[8];
  assert.ok(source9Line.includes("Source 9: Ninth Source Beyond Preview"));
  assert.ok(source9Line.includes(fixtureData.results[8].url));
  const s9Match = source9Line.match(/excerpts: lines (\d+)–(\d+)/)!;
  assert.ok(s9Match, "Source 9 index entry contains excerpt line range");

  // Reading Source 9's advertised range yields the decisive text:
  const s9Excerpts = lines.slice(Number(s9Match[1]) - 1, Number(s9Match[2])).join("\n");
  assert.equal(s9Excerpts, fixtureData.results[8].excerpts[0]);
  assert.ok(s9Excerpts.includes("decisive target fact that answers the research question."));
});

test("null and empty excerpts present cleanly without fake pointers or legacy fallback", async t => {
  const { receipt } = await fixture(t, {
    results: [
      { url: "https://example.org/null-excerpts", title: "Null Excerpts", excerpts: null },
      { url: "https://example.org/empty-excerpts", title: "Empty Excerpts", excerpts: [] },
    ],
  });
  const shown = await presentEvidence(receipt, {}, "readable");
  assert.ok(shown.readableArtifact, "presents readable evidence rather than falling back");
  assert.match(shown.text, /## Source 1: Null Excerpts/);
  assert.match(shown.text, /## Source 2: Empty Excerpts/);
  // Both sources advertise none returned:
  const matches = shown.text.match(/Saved excerpts: none returned\./g);
  assert.equal(matches?.length, 2);
  const markdown = await readFile(shown.readableArtifact!, "utf8");
  assert.ok(markdown.includes("No excerpts returned."));
  assert.ok(markdown.includes("- Source 1: Null Excerpts — https://example.org/null-excerpts (excerpts: none)"));
});

test("S2 replay: short same-stem names, directory once, and whole excerpts with exact offsets", async t => {
  // Analogous to tier1-S2/lazy: one Extract of 4 sources with 0.6-4.3k-char multiline
  // excerpts. The old preview cut source 4 mid-code-block and printed a ~95-char
  // companion name with two UUIDs, which the agent mistyped twice (ENOENT) before `ls`.
  const s2 = JSON.parse(await readFile(join(import.meta.dirname, "fixtures/evidence/s2-extract-navigation.json"), "utf8"));
  const { receipt, dir } = await fixture(t, s2, { urls: s2.results.map((r: any) => r.url) });
  const shown = await presentEvidence(receipt, { preview_chars: 8000 }, "readable");
  const text = shown.text;
  assert.ok(text.length <= 8000, `${text.length}`);

  // One stem, no second UUID; the directory appears once and the read path is copy-ready.
  const json = basename(receipt.artifact!);
  assert.match(json, /^\d{8}-\d{6}-[a-z2-9]{6}\.json$/);
  assert.equal(shown.readableArtifact, receipt.artifact!.replace(/\.json$/, ".md"));
  assert.equal(text.split(dir).length - 1, 1, "directory printed once");
  const copied = text.match(/^Readable evidence: (\S+)$/m)![1];
  assert.equal(copied, shown.readableArtifact);
  assert.match(text, new RegExp(`^Raw JSON: ${json.replaceAll(".", "\\.")} \\(same directory\\)$`, "m"));
  const markdown = (await readFile(copied, "utf8")).split("\n");
  assert.deepEqual(JSON.parse(await readFile(join(dirname(copied), json), "utf8")), s2);

  // Fewer complete excerpts, never a fragment; omitted ones name exact read offsets.
  assert.equal(text.includes("[Excerpt shortened"), false);
  let omitted = 0;
  let last = -1;
  s2.results.forEach((r: any, i: number) => {
    const at = text.indexOf(`## Source ${i + 1}: `);
    assert.ok(at > last, "source order kept");
    last = at;
    const excerpt = r.excerpts[0];
    if (text.includes(excerpt)) return;
    omitted++;
    const block = text.slice(at, text.indexOf("\n\n## Source", at + 1) >>> 0);
    const m = block.match(/Not shown: excerpt 1 of 1 at lines (\d+)–(\d+) of the readable evidence file \(offset=(\d+), limit=(\d+)\)/)!;
    assert.ok(m, `source ${i + 1} names its omitted excerpt`);
    assert.equal(m[3], m[1]);
    assert.equal(Number(m[4]), Number(m[2]) - Number(m[1]) + 1);
    // One read at the advertised offset returns the whole excerpt.
    assert.equal(markdown.slice(Number(m[3]) - 1, Number(m[3]) - 1 + Number(m[4])).join("\n"), excerpt);
    // No partial copy of the omitted excerpt leaks into the preview.
    assert.equal(text.includes(excerpt.split("\n").at(-1)), false);
  });
  assert.ok(omitted > 0 && omitted < 4, `${omitted} omitted`);
  assert.match(text, new RegExp(`Excerpt preview shortened: yes; ${4 - omitted} of 4 excerpts shown, each complete`));

  // The raw JSON is navigable without guessing keys: field_map names each excerpt list.
  const map = receipt.field_map as any;
  assert.deepEqual(Object.keys(map.fields), [0, 1, 2, 3].map(i => `results[${i}].excerpts`));
  const raw = (await readFile(receipt.artifact!, "utf8")).split("\n");
  const [, from, to] = map.fields["results[3].excerpts"].match(/^lines (\d+)-(\d+);/);
  assert.deepEqual(JSON.parse(raw.slice(Number(from) - 1, Number(to)).join("\n").replace(/^\s*"excerpts": /, "").replace(/,$/, "")), s2.results[3].excerpts);
  assert.ok(text.includes("field_map (raw JSON lines, not readable evidence lines):"));
});

test("legacy artifact names stay readable and their old companions are untouched", async t => {
  const dir = await mkdtemp(join(tmpdir(), "parallel-legacy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const legacyJson = join(dir, "1790098553346-44f8a430-c918-4573-991f-3b58da2d5407.json");
  const legacyMd = `${legacyJson}.7be708fa-7494-44e2-bc01-312441e4a666.md`;
  await writeFile(legacyJson, JSON.stringify(payload, null, 2));
  await writeFile(legacyMd, "old companion");
  const receipt = { artifact: legacyJson, return_mode: "preview" as const, omitted: true as const, notice: "legacy" };
  const shown = await presentEvidence(receipt, {}, "readable");
  assert.equal(shown.readableArtifact, join(dir, "1790098553346-44f8a430-c918-4573-991f-3b58da2d5407.md"));
  assert.ok((await readFile(shown.readableArtifact!, "utf8")).includes(source.excerpts[1]));
  assert.equal(await readFile(legacyMd, "utf8"), "old companion");
  assert.ok(shown.text.includes(source.excerpts[1]));
});

test("explicit output_path keeps overwrite semantics; its companion never replaces a Markdown file", async t => {
  const dir = await mkdtemp(join(tmpdir(), "parallel-explicit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const opts = { cwd: dir, artifactDir: join(dir, "results") };
  const first = await researchOutput(payload, { output_path: "out/report.json" }, opts);
  assert.equal(first.artifact, join(dir, "out/report.json"));
  const a = await presentEvidence(first, {}, "readable");
  assert.equal(a.readableArtifact, join(dir, "out/report.md"));
  await writeFile(a.readableArtifact!, "user notes");
  await assert.rejects(researchOutput(payload, { output_path: "out/report.json" }, opts), /EEXIST/);
  const replaced = { ...payload, results: [{ ...source, excerpts: ["replacement text"] }] };
  const second = await researchOutput(replaced, { output_path: "out/report.json", overwrite: true }, opts);
  assert.deepEqual(JSON.parse(await readFile(second.artifact!, "utf8")), replaced);
  const b = await presentEvidence(second, {}, "readable");
  assert.match(basename(b.readableArtifact!), /^report-[a-z2-9]{6}\.md$/);
  assert.equal(await readFile(join(dir, "out/report.md"), "utf8"), "user notes");
  assert.ok((await readFile(b.readableArtifact!, "utf8")).includes("replacement text"));
  assert.ok(b.text.includes("Raw JSON: report.json (same directory)"));
});

test("full content with object parameter reports requested status and preserves working ranges", async t => {
  const a1Fixture = JSON.parse(await readFile(join(import.meta.dirname, "fixtures/evidence/a1-python-extract.json"), "utf8"));
  const { receipt } = await fixture(t, a1Fixture);
  const shown = await presentEvidence(receipt, { full_content: { max_chars_per_result: 20000 } }, "readable");
  const match = shown.text.match(/Full content: saved at lines (\d+)–(\d+)/)!;
  assert.ok(match);
  const markdown = await readFile(shown.readableArtifact!, "utf8");
  const lines = markdown.split("\n");
  const fullBody = lines.slice(Number(match[1]) - 1, Number(match[2])).join("\n");
  assert.equal(fullBody, a1Fixture.results[0].full_content);
});
