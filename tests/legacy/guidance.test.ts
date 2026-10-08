import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { loadTools } from "../helpers/test-host.ts";

const artifactRule = "Read saved artifacts for omitted content. Never repeat a paid request to recover it.";

// These test actual prompt composition, not whether a model follows the rules.
test("shared research guidance renders once and follows active tools with appended prompts", async () => {
  const { tools, buildSystemPromptSections } = await loadTools();
  const retrieval = ["parallel_search", "parallel_extract", "parallel_responses"];
  const gap = tools.get("parallel_search").promptGuidelines[0];
  const evidence = tools.get("parallel_search").promptGuidelines[1];
  const definitions = [...tools.values()];
  const options = {
    cwd: process.cwd(),
    selectedTools: [...tools.keys()],
    toolSnippets: Object.fromEntries(definitions.map(t => [t.name, t.promptSnippet])),
    toolGuidelines: Object.fromEntries(definitions.map(t => [t.name, t.promptGuidelines])),
  };
  const occurrences = (text: string, value: string) => text.split(value).length - 1;
  const all = buildSystemPromptSections(options);
  assert.equal(occurrences(all.rules, gap), 1);
  assert.equal(occurrences(all.rules, evidence), 1);
  assert.equal(occurrences(all.rules, artifactRule), 1);
  for (const name of [...tools.keys()].filter(name => name !== "parallel_account" && name !== "parallel_tools")) {
    const single = buildSystemPromptSections({ ...options, selectedTools: [name] });
    assert.equal(occurrences(single.rules, artifactRule), 1, `${name} must keep artifact reuse visible`);
  }
  for (const name of retrieval) {
    assert.ok(tools.get(name).promptGuidelines.includes(gap));
    const single = buildSystemPromptSections({ ...options, selectedTools: [name] });
    assert.equal(occurrences(single.rules, gap), 1, name);
    assert.ok(single.tools.includes(tools.get(name).promptSnippet));
  }
  const inactive = buildSystemPromptSections({ ...options, selectedTools: ["parallel_account"] });
  assert.equal(inactive.rules.includes(gap), false);
  const appended = buildSystemPromptSections({ ...options, appendSystemPrompt: "Additional evaluation instructions." });
  assert.equal(appended.rules, all.rules);
  assert.ok(appended.addendum.includes("Additional evaluation instructions."));
  const replaced = buildSystemPromptSections({ ...options, customPrompt: "Replacement evaluation prompt." });
  assert.equal(replaced.rules, undefined, "Replacement prompts must explicitly preserve the tested guidance");
});

test("activator wording gates on needed-and-missing without suppressing later deferred work", async t => {
  const previous = process.env.PIPARA_LAZY_TOOLS;
  t.after(() => {
    if (previous === undefined) delete process.env.PIPARA_LAZY_TOOLS;
    else process.env.PIPARA_LAZY_TOOLS = previous;
  });
  process.env.PIPARA_LAZY_TOOLS = "1";
  const { tools, buildSystemPromptSections } = await loadTools();
  const activator = tools.get("parallel_tools");
  assert.deepEqual(activator.promptGuidelines, []);
  assert.match(activator.description, /needed deferred tool is absent/);
  assert.match(activator.description, /parallel_task: deep\/background research/);
  assert.match(activator.description, /parallel_group: batch over existing inputs/);
  assert.match(activator.description, /parallel_findall: discover matching entities/);
  assert.match(activator.description, /parallel_search, parallel_extract, and parallel_responses need no activation/);
  assert.match(activator.promptSnippet, /needed but missing/);
  for (const family of ["Task", "Group", "FindAll", "Monitor", "Memory", "Account"]) assert.ok(activator.promptSnippet.includes(family));
  assert.match(activator.promptSnippet, /skip if already listed/);

  const definitions = [...tools.values()];
  const options = {
    cwd: process.cwd(),
    selectedTools: ["parallel_search", "parallel_extract", "parallel_responses", "parallel_tools"],
    toolSnippets: Object.fromEntries(definitions.map(t => [t.name, t.promptSnippet])),
    toolGuidelines: Object.fromEntries(definitions.map(t => [t.name, t.promptGuidelines])),
  };
  const mixed = buildSystemPromptSections(options);
  assert.ok(mixed.tools.includes(tools.get("parallel_search").promptSnippet));
  assert.ok(mixed.tools.includes(activator.promptSnippet));
  assert.doesNotMatch(mixed.tools, /skip.*Search|Search.*skip/i);
  assert.equal(mixed.rules.split(artifactRule).length - 1, 1);
});

test("tool reference is packaged, discoverable once, and contains valid Task templates", async () => {
  const { tools, buildSystemPromptSections } = await loadTools();
  const path = fileURLToPath(new URL("../../docs/tool-reference.md", import.meta.url));
  const reference = await readFile(path, "utf8");
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.ok(manifest.files.includes("docs/tool-reference.md"));
  const definitions = [...tools.values()].filter(tool => tool.name !== "parallel_tools");
  for (const tool of definitions) {
    assert.equal(tool.promptGuidelines.filter((rule: string) => rule.includes(path)).length, 1, tool.name);
  }
  const prompt = buildSystemPromptSections({
    cwd: "/unrelated/project",
    selectedTools: definitions.map(tool => tool.name),
    toolSnippets: Object.fromEntries(definitions.map(tool => [tool.name, tool.promptSnippet])),
    toolGuidelines: Object.fromEntries(definitions.map(tool => [tool.name, tool.promptGuidelines])),
  });
  assert.equal(prompt.rules.split(path).length - 1, 1);
  assert.ok(!prompt.rules.includes(reference), "Reference contents must stay out of the prompt until read");
  const examples = [...reference.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
  assert.equal(examples.length, 2);
  for (const args of examples) {
    assert.deepEqual(validateToolArguments(tools.get("parallel_task"), { type: "toolCall", id: "reference", name: "parallel_task", arguments: args }), args);
  }
  assert.deepEqual(examples.map(args => JSON.parse(args.task_spec).output_schema.type), ["text", "auto"]);
});

test("deduplicated guidance stays below the prior word budget", async t => {
  const { tools } = await loadTools();
  const rules = [...new Set<string>([...tools.values()].flatMap(tool => tool.promptGuidelines).map(rule => rule.trim()))];
  const words = rules.join(" ").split(/\s+/).length;
  assert.ok(words < 463, `${words} words exceed the previous 463-word budget`);
  t.diagnostic(`${rules.length} unique guidelines, ${words} words (previously 463)`);
});
