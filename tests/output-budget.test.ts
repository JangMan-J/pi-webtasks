import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactError, MAX_PREVIEW_LIMIT, MIN_PREVIEW_LIMIT, PREVIEW_LIMIT, getPreviewLimit, preview, redact, researchOutput, researchReceipt } from "../src/results.ts";

async function tempDir(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "parallel-output-budget-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function size(value: unknown) {
  return JSON.stringify(value, null, 2).length;
}

function task(content: unknown, basis: unknown[] = []) {
  return { run: { run_id: "run_budget", status: "completed" }, output: { type: "json", content, basis } };
}

test("preview_chars contract and invalid budgets reject before operations or artifact writes", async t => {
  assert.equal(getPreviewLimit({}), PREVIEW_LIMIT);
  assert.equal(getPreviewLimit({ preview_chars: MIN_PREVIEW_LIMIT }), MIN_PREVIEW_LIMIT);
  assert.equal(getPreviewLimit({ preview_chars: MAX_PREVIEW_LIMIT }), MAX_PREVIEW_LIMIT);
  assert.throws(() => getPreviewLimit({ preview_chars: MIN_PREVIEW_LIMIT - 1 }), /preview_chars/);
  let called = false;
  await assert.rejects(
    researchReceipt(async () => { called = true; return preview({ id: "x" }, null); }, { preview_chars: MIN_PREVIEW_LIMIT - 1 }),
    /preview_chars/,
  );
  assert.equal(called, false);

  const dir = await tempDir(t);
  await assert.rejects(researchOutput({ id: "x" }, { preview_chars: MAX_PREVIEW_LIMIT + 1 }, { artifactDir: dir }), /preview_chars/);
  assert.deepEqual(await readdir(dir), []);
});

test("Task narrative and structured output stay complete when the full receipt fits", async t => {
  const dir = await tempDir(t);
  const report = "r".repeat(5944);
  assert.equal([...report].length, 5944);
  const data = task({ report, items: Array.from({ length: 6 }, (_, i) => ({ i, text: `item-${i}` })) }, [
    { field: "report", confidence: 0.91, reasoning: "fits", citations: [{ url: "https://example.test/source", excerpts: ["short excerpt"] }] },
  ]);
  const receipt = await researchOutput(data, {}, { artifactDir: dir });
  assert.ok(size(receipt) <= PREVIEW_LIMIT, `${size(receipt)}`);
  assert.equal((receipt.control as any)["run.run_id"], "run_budget");
  const output = (receipt.preview as any).output;
  assert.equal(output.content.report, report);
  assert.equal(output.content.items.length, 6);
  assert.equal(output.basis[0].confidence, 0.91);
  assert.equal(output.basis[0].citations[0].url, "https://example.test/source");
  assert.equal("content_shortened" in output, false);
});

test("JSON source previews keep all fitting sources, dates and complete excerpts", async t => {
  const dir = await tempDir(t);
  const results = Array.from({ length: 7 }, (_, i) => ({
    url: `https://example.test/${i}`, title: `Source ${i}`, publish_date: "2026-09-24",
    excerpts: ["x".repeat(1200), "second whole excerpt", "third whole excerpt"],
  }));
  const receipt = await researchOutput({ results }, {}, { artifactDir: dir });
  const shown = (receipt.preview as any).results;
  assert.equal(shown.length, 7);
  for (let i = 0; i < results.length; i++) {
    assert.deepEqual(shown[i].excerpts, results[i].excerpts);
    assert.equal(shown[i].publish_date, results[i].publish_date);
    assert.equal("excerpts_omitted" in shown[i], false);
  }
  const limited = preview({ results: [{ ...results[0], excerpts: ["large ".repeat(2000)] }, results[1]] }, "/saved.json", { preview_chars: 2000 });
  assert.ok(size(limited) <= 2000);
  assert.equal((limited.preview as any).results[0].url, results[0].url);
  assert.equal((limited.preview as any).results[0].excerpts_omitted, 1);
  assert.deepEqual(JSON.parse(await readFile(receipt.artifact!, "utf8")), { results });
});

test("budget projection treats prototype-shaped keys as data", () => {
  const content = JSON.parse(`{"__proto__":{"polluted":"no"},"long":"${"x".repeat(20_000)}"}`);
  const receipt = preview(task(content), "/saved.json", { preview_chars: 2000 });
  const returned = JSON.parse(JSON.stringify(receipt));
  assert.ok(size(receipt) <= 2000);
  assert.equal(Object.hasOwn(returned.preview.output.content, "__proto__"), true);
  assert.equal(({} as any).polluted, undefined);
});

test("oversize Task bodies fit selected budgets with useful IDs, citations, confidence and explicit omissions", async t => {
  const dir = await tempDir(t);
  const data = task({ narrative: `start ${"αβγδεζηθ".repeat(7000)} end` }, [
    { field: "narrative", confidence: null, reasoning: "reason ".repeat(4000), citations: [{ url: "https://example.test/a", excerpts: ["excerpt ".repeat(600)] }] },
    { field: "narrative", confidence: 0.2, reasoning: "second ".repeat(1000), citations: [{ url: "https://example.test/b", excerpts: ["b"] }] },
  ]);

  for (const budget of [MIN_PREVIEW_LIMIT, 8_000, PREVIEW_LIMIT, MAX_PREVIEW_LIMIT]) {
    const receipt = await researchOutput(data, { preview_chars: budget }, { artifactDir: dir });
    const text = JSON.stringify(receipt, null, 2);
    assert.ok(text.length <= budget, `${budget}: ${text.length}`);
    assert.equal(text.isWellFormed(), true);
    assert.equal((receipt.control as any)["run.run_id"], "run_budget");
    const output = (receipt.preview as any).output;
    assert.ok(output.content.narrative.length > 0, `content retained at ${budget}`);
    if (output.content_shortened) assert.ok(output.content_omitted?.length > 0, `content omission noted at ${budget}`);
    else assert.equal(output.content.narrative, data.output.content.narrative);
    assert.equal(output.basis[0].confidence, null);
    assert.equal(output.basis[0].citations[0].url, "https://example.test/a");
    assert.ok(output.basis[0].reasoning_shortened || output.basis_omitted !== undefined || output.basis[0].citations[0].excerpts_shortened !== undefined);
  }
});

test("long direct preview content recovers unused metadata budget", () => {
  const receipt = preview(
    { run: { run_id: "keep", status: "completed" }, output: { content: "Useful evidence. ".repeat(5000) } },
    "/saved.json",
    { preview_chars: PREVIEW_LIMIT },
  );
  const text = JSON.stringify(receipt, null, 2);
  assert.ok(text.length <= PREVIEW_LIMIT, `${text.length}`);
  assert.equal((receipt.control as any)["run.run_id"], "keep");
  const output = (receipt.preview as any).output;
  assert.equal(output.content_shortened, true);
  assert.ok(output.content.length > 22_000, `${output.content.length}`);
  assert.ok(output.content_omitted?.length > 0);
});

test("oversize citation metadata keeps bounded sources and useful content", () => {
  const receipt = preview(
    {
      output: {
        content: "A finding worth retaining.",
        basis: [{
          field: "content",
          confidence: "low",
          reasoning: "Check the sources.",
          citations: Array.from({ length: 100 }, (_, i) => ({ url: `https://example.org/${i}/${"x".repeat(50)}`, excerpts: ["Support."] })),
        }],
      },
    },
    "/saved.json",
    { preview_chars: MIN_PREVIEW_LIMIT },
  );
  const text = JSON.stringify(receipt, null, 2);
  assert.ok(text.length <= MIN_PREVIEW_LIMIT, `${text.length}`);
  const output = (receipt.preview as any).output;
  assert.equal(output.content, "A finding worth retaining.");
  assert.equal(output.basis[0].confidence, "low");
  assert.ok(output.basis[0].citations.length > 0);
  assert.ok(output.basis[0].citations.length < 100);
  assert.ok(output.basis[0].citations_omitted > 0);
});

test("body budget recovery reports field_map omission explicitly", () => {
  const map = Array.from({ length: 12 }, (_, i) => ({ path: `content.${i}.${"x".repeat(80)}`, chars: 5000, start: i + 1, end: i + 1 }));
  const receipt = preview(
    { output: { content: "Useful evidence. ".repeat(500) } },
    "/saved.json",
    { preview_chars: MIN_PREVIEW_LIMIT },
    undefined,
    map,
  );
  assert.ok(size(receipt) <= MIN_PREVIEW_LIMIT, `${size(receipt)}`);
  assert.equal("field_map" in receipt, false);
  assert.equal(receipt.field_map_omitted, map.length);
  assert.ok((receipt.preview as any).output.content.length > 0);
});

test("Responses answer_omitted counts the current block when no projection fits", () => {
  const receipt = preview(
    { response: { id: "resp_budget", status: "completed", output: [{ type: "message", content: [
      { type: "output_text", text: "a".repeat(1500) },
      { type: "output_text", text: "b".repeat(10_000) },
    ] }] } },
    "/saved.json",
    { preview_chars: MIN_PREVIEW_LIMIT },
  );
  assert.ok(size(receipt) <= MIN_PREVIEW_LIMIT, `${size(receipt)}`);
  assert.equal((receipt.preview as any).answer.length, 1);
  assert.equal((receipt.preview as any).answer_omitted, 1);
});

test("JSON and Unicode stay intact in receipts and complete redacted disk data", async t => {
  const dir = await tempDir(t);
  const data = task({ text: "line1\nline2 🦄 café \u2028 \u2029 \ud800", list: ["one", "two"] }, [
    { field: "text", confidence: 0, reasoning: "unicode basis", citations: [{ url: "https://example.test/unicode", excerpts: ["ok"] }] },
  ]);
  const receipt = await researchOutput(data, { preview_chars: 8_000 }, { artifactDir: dir });
  const json = JSON.stringify(receipt, null, 2);
  assert.equal(json.isWellFormed(), true);
  assert.ok(JSON.parse(json));
  const saved = JSON.parse(await readFile(receipt.artifact!, "utf8"));
  assert.deepEqual(saved, JSON.parse(JSON.stringify(redact(data))));
});

test("all-small content is unchanged and file mode has no bodies", async t => {
  const dir = await tempDir(t);
  const data = task({ summary: "small", values: [1, 2, 3, 4] }, [
    { field: "summary", confidence: 1, reasoning: "clear", citations: [{ url: "https://example.test/small", excerpts: ["tiny"] }] },
  ]);
  const direct = preview(data, "/tmp/saved.json");
  const receipt = await researchOutput(data, {}, { artifactDir: dir });
  assert.deepEqual((receipt.preview as any).output, (direct.preview as any).output);
  const file = await researchOutput(data, { return_mode: "file", preview_chars: 8_000 }, { artifactDir: dir });
  assert.equal("preview" in file, false);
  assert.ok(size(file) <= 8_000);
});
