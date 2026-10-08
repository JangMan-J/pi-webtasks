#!/usr/bin/env node
// Dump every registered pi-webtasks tool as the model sees it: provider function schema, prompt
// snippet/guidelines, and the rendered system-prompt sections. Loads the extension through Pi's real
// loader. No API key or network.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadTools } from "../tests/helpers/test-host.ts";

const out = resolve(process.argv[2] ?? "tool-schemas");
const host = await loadTools();
const { commands, buildSystemPromptSections } = host;
const definitions = [...host.tools.values()] as any[];

const entries = definitions.map(d => {
  const provider = { type: "function", function: { name: d.name, description: d.description, parameters: d.parameters } };
  return {
    name: d.name,
    label: d.label,
    description: d.description,
    promptSnippet: d.promptSnippet ?? null,
    promptGuidelines: d.promptGuidelines ?? [],
    parameters: JSON.parse(JSON.stringify(d.parameters)),
    providerSchemaChars: JSON.stringify(provider).length,
  };
});
const prompt = buildSystemPromptSections({
  cwd: "/workspace",
  selectedTools: [...host.tools.keys()],
  toolSnippets: Object.fromEntries(definitions.map(t => [t.name, t.promptSnippet])),
  toolGuidelines: Object.fromEntries(definitions.map(t => [t.name, t.promptGuidelines])),
});
const totals = {
  tools: entries.length,
  providerSchemaChars: entries.reduce((total, e) => total + e.providerSchemaChars, 0),
  promptSectionChars: { tools: prompt.tools?.length ?? 0, rules: prompt.rules?.length ?? 0 },
};

await mkdir(out, { recursive: true });
await writeFile(resolve(out, "tool-schemas.json"), JSON.stringify({
  generated: new Date().toISOString(),
  source: "src/index.ts via Pi extension loader (tests/helpers/test-host.ts)",
  totals,
  commands: [...(commands?.keys?.() ?? [])],
  tools: entries,
  systemPromptSections: prompt,
}, null, 2) + "\n");

const md = [
  "# pi-webtasks tool schemas",
  "",
  `Generated ${new Date().toISOString()} from \`src/index.ts\` through Pi's extension loader.`,
  "Provider chars = `JSON.stringify({type:\"function\",function:{name,description,parameters}})`, the per-request payload measure used in `bench/ab-overhead.ts`.",
  "",
  "| Tool | Provider chars |",
  "| --- | ---: |",
  ...entries.map(e => `| \`${e.name}\` | ${e.providerSchemaChars} |`),
  `| Total | ${totals.providerSchemaChars} |`,
  "",
  "## System prompt sections contributed",
  "",
  "### Tools",
  "",
  "```text", prompt.tools ?? "", "```",
  "",
  "### Rules",
  "",
  "```text", prompt.rules ?? "", "```",
  "",
  ...entries.flatMap(e => [
    `## \`${e.name}\``,
    "",
    `Label: ${e.label}`,
    "",
    `Description: ${e.description}`,
    "",
    `Prompt snippet: ${e.promptSnippet ?? "(none)"}`,
    "",
    "Prompt guidelines:",
    "",
    ...(e.promptGuidelines.length ? e.promptGuidelines.map((g: string) => `- ${g}`) : ["- (none)"]),
    "",
    "```json", JSON.stringify(e.parameters, null, 2), "```",
    "",
  ]),
].join("\n");
await writeFile(resolve(out, "tool-schemas.md"), md);
console.log(JSON.stringify({ out, ...totals }, null, 2));
