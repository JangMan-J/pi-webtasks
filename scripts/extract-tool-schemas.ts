#!/usr/bin/env node
// Dump every registered tool as the model sees it: provider function schema,
// prompt snippet/guidelines, and the rendered system-prompt sections.
// Loads the extension through Pi's real loader. No API key or network.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadTools } from "../tests/helpers/test-host.ts";

const out = resolve(process.argv[2] ?? "tool-schemas");
// Inspect both real registration modes; an all-active host has no activator.
const previous = process.env.PIPARA_LAZY_TOOLS;
let full: Awaited<ReturnType<typeof loadTools>>;
let deferredHost: Awaited<ReturnType<typeof loadTools>>;
try {
  process.env.PIPARA_LAZY_TOOLS = "0";
  full = await loadTools();
  process.env.PIPARA_LAZY_TOOLS = "1";
  deferredHost = await loadTools();
} finally {
  if (previous === undefined) delete process.env.PIPARA_LAZY_TOOLS;
  else process.env.PIPARA_LAZY_TOOLS = previous;
}
const { commands, buildSystemPromptSections } = full;
const definitions = [...deferredHost.tools.values()] as any[];
// The registered selector is the source of truth for deferred tool names.
const selector = deferredHost.tools.get("parallel_tools").parameters.properties.tools.items;
const deferred: string[] = selector.enum;

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
    deferredWhenLazy: deferred.includes(d.name),
  };
});
const options = (selected: string[]) => ({
  cwd: "/workspace",
  selectedTools: selected,
  toolSnippets: Object.fromEntries(definitions.map(t => [t.name, t.promptSnippet])),
  toolGuidelines: Object.fromEntries(definitions.map(t => [t.name, t.promptGuidelines])),
});
const all = [...full.tools.keys()] as string[];
const lazy = entries.map(e => e.name).filter(n => !deferred.includes(n));
const prompt = { allActive: buildSystemPromptSections(options(all)), lazy: buildSystemPromptSections(options(lazy)) };
const sum = (names: string[]) => entries.filter(e => names.includes(e.name)).reduce((t, e) => t + e.providerSchemaChars, 0);
const totals = {
  tools: entries.length,
  activeTools: { allActive: all, lazy },
  providerSchemaChars: { allActive: sum(all), lazy: sum(lazy) },
  promptSectionChars: {
    allActive: { tools: prompt.allActive.tools?.length ?? 0, rules: prompt.allActive.rules?.length ?? 0 },
    lazy: { tools: prompt.lazy.tools?.length ?? 0, rules: prompt.lazy.rules?.length ?? 0 },
  },
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
  "# pi-parallelized tool schemas",
  "",
  `Generated ${new Date().toISOString()} from \`src/index.ts\` through Pi's extension loader.`,
  "Provider chars = `JSON.stringify({type:\"function\",function:{name,description,parameters}})`, the per-request payload measure used in `bench/ab-overhead.ts`.",
  "",
  "| Tool | Provider chars | Deferred when lazy |",
  "| --- | ---: | --- |",
  ...entries.map(e => `| \`${e.name}\` | ${e.providerSchemaChars} | ${e.deferredWhenLazy ? "yes" : "no"} |`),
  `| Total (all active / lazy) | ${totals.providerSchemaChars.allActive} / ${totals.providerSchemaChars.lazy} | |`,
  "",
  "## System prompt sections contributed (all tools active)",
  "",
  "### Tools",
  "",
  "```text", prompt.allActive.tools ?? "", "```",
  "",
  "### Rules",
  "",
  "```text", prompt.allActive.rules ?? "", "```",
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
