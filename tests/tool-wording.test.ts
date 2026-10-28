import assert from "node:assert/strict";
import test from "node:test";
import { loadTools } from "./helpers/test-host.ts";

const TOOLS = ["web_search", "web_fetch", "web_research", "web_answer", "web_recall"];

test("every tool has a snippet, and every guideline names the tool it is about", async () => {
  // Pi merges all tools' guidelines into one flat list of rules with no tool attribution,
  // so a guideline that does not name its tool reads as a rule for every tool.
  const { tools } = await loadTools();
  assert.deepEqual([...tools.keys()], TOOLS);
  for (const [name, tool] of tools) {
    assert.ok(tool.promptSnippet?.trim(), `${name} needs a promptSnippet: Pi omits tools without one from the tool list`);
    for (const guideline of tool.promptGuidelines ?? []) {
      assert.match(guideline, new RegExp(`\\b${name}\\b`), `${name} guideline does not name ${name}: ${guideline}`);
    }
  }
});

test("the routing rule comes first and names every web tool", async () => {
  const { tools } = await loadTools();
  const first = tools.get("web_search").promptGuidelines[0];
  for (const name of TOOLS) assert.match(first, new RegExp(`\\b${name}\\b`), `the routing rule omits ${name}`);
});

test("web_search requires an objective and keyword queries", async () => {
  // Parallel's published search tool requires both; they do different jobs.
  const { tools } = await loadTools();
  assert.deepEqual([...tools.get("web_search").parameters.required].sort(), ["objective", "search_queries"]);
});

test("the search mode description marks exactly the configured default", async () => {
  const { tools } = await loadTools();
  const description = tools.get("web_search").parameters.properties.mode.description;
  assert.equal(description.match(/\(the default\)/g)?.length, 1);
  assert.match(description, /basic \(~1 s\) for extended excerpts per result \(the default\)/);
});
