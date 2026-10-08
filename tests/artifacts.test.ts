import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { presentEvidence } from "../src/evidence.ts";
import { FIELD_MAP_MIN_CHARS, PREVIEW_LIMIT, fieldEntries, preview, redact, researchOutput } from "../src/results.ts";

// Multiline, quoted, escaped, astral, LS/PS and lone-surrogate text in one string.
const long = (tag: string) => `${tag}: ${'Line with "quotes" \\ and tab\t.\nNext line 🦄 café. '.repeat(6)}\u2028sep\u2029end \ud800 ${tag}`;
const url = "https://example.org/doc";

const shapes: Record<string, unknown> = {
  task: {
    run: { run_id: "trun_1", status: "completed", interaction_id: "int_1" },
    output: {
      type: "json",
      content: { summary: long("summary"), "odd \"key\"\n": long("odd"), items: ["a", "b"], nested: { n: 1 } },
      basis: [{ field: "summary", reasoning: long("reasoning"), citations: [{ url, excerpts: [long("ex1"), long("ex2")] }] }],
    },
  },
  taskText: { run: { run_id: "trun_2", status: "completed" }, output: { type: "text", content: long("text answer"), basis: [] } },
  group: {
    taskgroup_id: "tgrp_1", run_ids: ["r1", "r2"],
    runs: [{ run: { run_id: "r1", status: "completed" }, output: { type: "text", content: long("group answer"), basis: [] } }],
    events: [{ type: "task_run.state", run: { run_id: "r2", status: "failed", error: { message: "boom" } } }],
  },
  findall: {
    run: { findall_id: "fa_1", status: { status: "completed", is_active: false } },
    candidates: [{
      candidate_id: "c1", name: "Acme", url, description: long("description"), match_status: "matched",
      output: { founded: { value: "1999", type: "enrichment" } },
      basis: [{ field: "founded", reasoning: long("why"), citations: [{ url, excerpts: [long("cite")] }] }],
    }],
  },
  responses: {
    id: "resp_1", status: "completed", previous_response_id: "resp_0",
    output: [
      { type: "web_search_call", action: { type: "search", query: "q" } },
      { type: "message", content: [{ type: "output_text", text: long("answer"), annotations: [{ type: "url_citation", url, start_index: 0, end_index: 4 }] }] },
    ],
  },
  search: {
    search_id: "search_1",
    results: [{ url, title: "T", excerpts: [long("s1"), "short", long("s2")] }, { url, title: "Empty", excerpts: [] }],
    "weird.key": { "0": long("zero"), "": long("empty key"), "a b": [long("in array"), { deep: long("deep") }] },
    ...JSON.parse(`{"__proto__": ${JSON.stringify(long("proto"))}}`),
    skipped: undefined, empty: {}, none: null,
  },
};

// Evaluate a field_map path: .ident, [index], ["json key"].
function at(root: any, path: string): unknown {
  if (path === "(root)") return root;
  let value = root;
  let rest = path;
  while (rest) {
    const m = /^\.?([A-Za-z_$][\w$]*)/.exec(rest) ?? /^\[(\d+)\]/.exec(rest) ?? /^\[("(?:[^"\\]|\\.)*")\]/.exec(rest);
    assert.ok(m, `unparseable path ${path}`);
    const key = m[1].startsWith('"') ? JSON.parse(m[1]) : m[1];
    assert.ok(Object.hasOwn(value, key), `${path}: missing ${key}`);
    value = value[key];
    rest = rest.slice(m[0].length);
  }
  return value;
}

const describe = /^lines? (\d+)(?:-(\d+))?; (\d+) chars(?:; (\d+) items?)?$/;

// Read the advertised lines exactly as an agent would (offset/limit on "\n" lines)
// and check that they hold the complete field value.
function checkField(lines: string[], data: unknown, path: string, description: string) {
  const m = description.match(describe);
  assert.ok(m, description);
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  const value = at(data, path);
  const slice = lines.slice(start - 1, end).join("\n").replace(/^\s*(?:"(?:[^"\\]|\\.)*": )?/, "").replace(/,$/, "");
  assert.deepEqual(JSON.parse(slice), value, path);
  const chars = (v: unknown): number => typeof v === "string" ? [...v].length :
    v && typeof v === "object" ? Object.values(v).reduce((n: number, x) => n + chars(x), 0) : 0;
  assert.equal(Number(m[3]), chars(value), `${path} chars`);
  assert.ok(Number(m[3]) >= FIELD_MAP_MIN_CHARS);
  if (m[4]) assert.equal(Number(m[4]), (value as unknown[]).length);
}

async function tempDir(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "parallel-artifacts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("field_map gives exact pretty-JSON lines for nested Task, Group, FindAll, Responses and Search text", async t => {
  const dir = await tempDir(t);
  for (const [name, data] of Object.entries(shapes)) {
    for (const return_mode of ["preview", "file"]) {
      const receipt = await researchOutput(data, { return_mode }, { artifactDir: dir });
      const text = JSON.stringify(receipt, null, 2);
      assert.ok(text.length <= PREVIEW_LIMIT && text.isWellFormed(), name);
      const map = receipt.field_map as any;
      assert.ok(map?.fields, `${name}/${return_mode} has a field_map`);
      assert.equal(map.omitted, undefined, `${name}: small maps are complete`);
      const raw = await readFile(receipt.artifact!, "utf8");
      // LS/PS/NEL are escaped so every reader counts the same lines; the value is unchanged.
      assert.equal(/[\u0085\u2028\u2029]/.test(raw), false);
      assert.deepEqual(JSON.parse(raw), JSON.parse(JSON.stringify(redact(data))));
      const lines = raw.split("\n");
      const paths = Object.keys(map.fields);
      assert.deepEqual(paths, fieldEntries(JSON.parse(raw)).entries.map(e => e.path), `${name}: source order`);
      for (const path of paths) checkField(lines, JSON.parse(raw), path, map.fields[path]);
    }
  }
  const task = (await researchOutput(shapes.task, {}, { artifactDir: dir })).field_map as any;
  assert.deepEqual(Object.keys(task.fields), ["output.content", "output.basis[0].reasoning", "output.basis[0].citations[0].excerpts"]);
  const search = (await researchOutput(shapes.search, {}, { artifactDir: dir })).field_map as any;
  assert.ok(Object.keys(search.fields).includes('["weird.key"][""]'));
  assert.ok(Object.keys(search.fields).includes('["weird.key"]["a b"][1].deep'));
  assert.ok(Object.keys(search.fields).includes("__proto__"));
  const responses = (await researchOutput(shapes.responses, {}, { artifactDir: dir })).field_map as any;
  assert.deepEqual(Object.keys(responses.fields), ["output[1].content[0].text"]);
});

test("field_map truncates explicitly without displacing identifiers, diagnostics or the preview limit", async t => {
  const dir = await tempDir(t);
  const ids = Array.from({ length: 6 }, (_, i) => `run_${i}`);
  const data = {
    taskgroup_id: "tgrp", run_ids: ids, next_cursor: "cursor-keep", status: "running",
    errors: [{ message: "partial failure" }],
    results: Array.from({ length: 300 }, (_, i) => ({ url: `${url}/${i}`, title: `R${i}`, excerpts: [long(`r${i}`)] })),
  };
  for (const return_mode of ["preview", "file"]) {
    const args = { return_mode };
    const receipt = await researchOutput(data, args, { artifactDir: dir });
    const without = preview(data, receipt.artifact, args);
    assert.deepEqual(receipt.control, without.control);
    assert.deepEqual(receipt.counts, without.counts);
    assert.deepEqual(receipt.diagnostics, without.diagnostics);
    assert.deepEqual((receipt.control as any).run_ids, ids);
    const text = JSON.stringify(receipt, null, 2);
    assert.ok(text.length <= PREVIEW_LIMIT, `${text.length}`);
    const map = receipt.field_map as any;
    const shown = Object.keys(map.fields).length;
    assert.ok(shown > 0 && shown < 300);
    assert.equal(map.omitted, 300 - shown);
    // next_line is where the first omitted field starts, so reading on is exact.
    const lines = (await readFile(receipt.artifact!, "utf8")).split("\n");
    const next = fieldEntries(data).entries[shown];
    assert.equal(map.next_line, next.start);
    checkField(lines, data, next.path, `lines ${next.start}-${next.end}; ${next.chars} chars; ${next.items} items`);
  }
  // Readable Search presentation carries the bounded map and stays within budget.
  const receipt = await researchOutput(data, {}, { artifactDir: dir });
  const shown = await presentEvidence(receipt, {}, "readable");
  assert.ok(shown.readableArtifact);
  assert.ok(shown.text.length <= PREVIEW_LIMIT);
  assert.match(shown.text, /field_map \(raw JSON lines, not readable evidence lines\): .*"omitted":\d+,"next_line":\d+/);
});

test("short text and failed saves carry no field_map; saved failures do", async t => {
  const dir = await tempDir(t);
  const small = await researchOutput({ id: "x", output_text: "short" }, {}, { artifactDir: dir });
  assert.equal("field_map" in small, false);
  const saved = await researchOutput({ error: { message: long("stream failure") }, partial: true }, { return_mode: "file" }, { artifactDir: dir });
  assert.deepEqual(Object.keys((saved.field_map as any).fields), ["error.message"]);
  await assert.rejects(researchOutput(shapes.responses, {}, {}), err => {
    const failed = JSON.parse((err as Error).message);
    assert.equal(failed.artifact, null);
    assert.equal("field_map" in failed, false);
    return true;
  });
});

test("automatic names are short, copy-safe, unique, and never overwrite even with overwrite=true", async t => {
  const dir = await tempDir(t);
  const opts = { artifactDir: join(dir, "results") };
  const receipts = await Promise.all(Array.from({ length: 20 }, () => researchOutput({ id: "x" }, { overwrite: true }, opts)));
  const names = receipts.map(r => basename(r.artifact!));
  assert.equal(new Set(names).size, 20);
  for (const name of names) assert.match(name, /^\d{8}-\d{6}-[a-z2-9]{6}\.json$/);
  assert.equal((await readdir(opts.artifactDir)).length, 20);
  assert.ok(receipts.every(r => r.artifact!.length < join(opts.artifactDir, "x").length + 28));
});
