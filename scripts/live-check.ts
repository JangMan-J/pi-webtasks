// Explicitly opt in: npm run test:live -- --live /absolute/path/to/test-report.json
// Resume the same report. Accepted submissions are never repeated.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadTools, context, checkResult } from "../tests/helpers/test-host.ts";
import { errorData } from "../src/results.ts";

const reportPath = process.argv[3];
assert.equal(process.argv[2], "--live", "Paid test requires --live and prior user consent");
assert.ok(reportPath && isAbsolute(reportPath), "Supply an absolute report path");
await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
let report: any;
try { report = JSON.parse(await readFile(reportPath, "utf8")); }
catch (err: any) {
  if (err.code !== "ENOENT") throw err;
  report = { scope: `pi-context-test-${randomUUID()}`, started: new Date().toISOString(), budget_usd: 5, reserved_usd: 0, steps: {} };
}
async function save() {
  await writeFile(`${reportPath}.new`, JSON.stringify(report, null, 2), { mode: 0o600 });
  await rename(`${reportPath}.new`, reportPath);
}
await save();
await loadTools();
const { tools, commands } = await loadTools();
const scope = report.scope;
const workdir = dirname(reportPath);
const ctx = context(workdir, async (title, body) => {
  // Consent is limited to this test's exact resources. No top-ups or global memory clear.
  if (title === "Create Parallel monitor?") return body.includes(scope) || body.includes((await saved("task.create"))?.run_id ?? "no-test-run");
  if (title === "Clear Parallel memory?") return true; // call() enforces exact scope below
  const resources = await Promise.all(Object.keys(report.steps).filter(label => /^(account\.create_(app|key)|monitor\.(create|snapshot))/.test(label)).map(saved));
  const ids = resources.flatMap(r => [r?.app_id, r?.api_key_id, r?.monitor_id]).filter(Boolean);
  if (["Delete Parallel app?", "Delete Parallel API key?", "Cancel Parallel monitor?"].includes(title)) return ids.some(id => body.includes(id));
  if (title === "Create Parallel API key?") return body.includes(`${scope}-key`);
  return false;
});

async function call(label: string, tool: string, args: any, reserve = 0): Promise<any> {
  const previous = report.steps[label];
  if (previous) {
    if (previous.state === "started") throw new Error(`Unknown completion for ${label}; inspect server state before continuing`);
    return previous.data;
  }
  if (tool === "memory") assert.equal(args.memory_scope_key, scope);
  assert.notEqual(args.action, "add_credit", "Top-ups are offline only");
  assert.ok(report.reserved_usd + reserve <= report.budget_usd, "Test budget exceeded");
  report.reserved_usd += reserve;
  report.steps[label] = { state: "started", tool, action: args.action, at: new Date().toISOString() };
  await save();
  console.log(`START ${label}`);
  const progress: string[] = [];
  let data: any;
  try {
    const definition: any = tools.get(`parallel_${tool}`);
    const result = await definition.execute(label, args, AbortSignal.timeout(180_000), (u: any) => progress.push(JSON.stringify(u)), ctx);
    const checked = checkResult(result, tool !== "account");
    data = tool === "account" ? checked.receipt : JSON.parse(await readFile(checked.receipt.artifact, "utf8"));
    report.steps[label] = { ...report.steps[label], state: "passed", chars: checked.chars, receipt: checked.receipt, progress_count: progress.length, data: tool === "account" ? data : undefined, artifact: checked.receipt?.artifact };
    assert.ok(progress.every(p => p.length < 1000), "Unbounded progress update");
    if (data?.error || data?.timeout || data?.events?.some((e: any) => e.type === "error")) report.steps[label].state = "partial";
  } catch (err) {
    let error: any = errorData(err);
    try { error = JSON.parse((err as Error).message); } catch { /* structured errorData */ }
    report.steps[label] = { ...report.steps[label], state: "failed", error };
  }
  await save();
  console.log(`${report.steps[label].state.toUpperCase()} ${label}${report.steps[label].chars ? ` ${report.steps[label].chars} chars` : ""}`);
  return data;
}
async function saved(label: string): Promise<any> {
  const step = report.steps[label];
  return step?.artifact ? JSON.parse(await readFile(step.artifact, "utf8")) : step?.data;
}
async function use(label: string, tool: string, args: any, reserve = 0) {
  await call(label, tool, args, reserve);
  return saved(label);
}

const taskSpec = { output_schema: { type: "json", json_schema: { type: "object", properties: { name: { type: "string", description: "Official name of the organization" }, homepage: { type: "string", description: "Official homepage URL" } }, required: ["name", "homepage"], additionalProperties: false } } };
const task = await use("task.create", "task", { action: "create", input: "Identify the Internet Engineering Task Force (IETF) official name and homepage. Use https://www.ietf.org/ as source.", processor: "lite", task_spec: JSON.stringify(taskSpec), memory_scope_key: scope, metadata: JSON.stringify({ test: scope }) }, 0.02);
const ingest = await use("findall.ingest", "findall", { action: "ingest", objective: "Find web standards organizations with official websites, such as IETF, W3C, and WHATWG." }, 0.02);
const findArgs = { objective: "Find web standards organizations with official websites, such as IETF, W3C, and WHATWG.", entity_type: ingest?.entity_type ?? "organizations", match_conditions: JSON.stringify(ingest?.match_conditions ?? [{ name: "standards", description: "Publishes standards used on the web" }]), match_limit: 5, memory_scope_key: scope, metadata: JSON.stringify({ test: scope }) };
const findall = await use("findall.create", "findall", { ...findArgs, action: "create", generator: "base" }, 0.5);
const group = await use("group.create", "group", { action: "create", metadata: JSON.stringify({ test: scope }) });
const groupRuns = group?.taskgroup_id ? await use("group.add", "group", { action: "add", taskgroup_id: group.taskgroup_id, inputs: JSON.stringify([{ input: "Identify the W3C official name and homepage using https://www.w3.org/", processor: "lite", memory_scope_key: scope }]), task_spec: JSON.stringify(taskSpec) }, 0.02) : undefined;
await use("search.preview", "search", { search_queries: ["IETF official standards organization"], objective: "Locate the official IETF website", max_results: 2 }, 0.01);
const search = await saved("search.preview");
await use("extract.file", "extract", { urls: ["https://www.ietf.org/"], objective: "What is the IETF?", full_content: true, max_chars_total: 12000, session_id: search?.session_id, return_mode: "file", output_path: `${scope}-extract.json` }, 0.01);
const response = await use("responses.call", "responses", { input: "What does IETF stand for? Answer in one sentence and cite https://www.ietf.org/.", effort: "low" }, 0.02);
await use("responses.stream", "responses", { input: "What is the IETF's official website? Answer in one sentence with a source link.", effort: "low", stream: true, previous_response_id: response?.response?.id, return_mode: "file" }, 0.02);
const preview = await use("findall.preview", "findall", { ...findArgs, action: "preview", generator: "preview" }, 0.15);
await use("findall.entity_search", "findall", { action: "entity_search", objective: "Companies developing web browsers", entity_type: "companies", match_limit: 5 }, 0.01);
if (task?.run_id) {
  await use("task.status", "task", { action: "status", run_id: task.run_id });
  await use("task.input", "task", { action: "input", run_id: task.run_id });
  await use("task.events", "task", { action: "events", run_id: task.run_id, wait_seconds: 10, return_mode: "file" });
  await use("task.result", "task", { action: "result", run_id: task.run_id, wait_seconds: 45 });
}
if (group?.taskgroup_id) {
  await use("group.status", "group", { action: "status", taskgroup_id: group.taskgroup_id });
  await use("group.events", "group", { action: "events", taskgroup_id: group.taskgroup_id, wait_seconds: 5, return_mode: "file" });
  await use("group.runs", "group", { action: "runs", taskgroup_id: group.taskgroup_id, wait_seconds: 10, include_input: true, include_output: true });
  if (groupRuns?.run_ids?.[0]) await use("group.run", "group", { action: "run", taskgroup_id: group.taskgroup_id, run_id: groupRuns.run_ids[0] });
}
if (findall?.findall_id) {
  const id = findall.findall_id;
  await use("findall.schema", "findall", { action: "schema", findall_id: id });
  await use("findall.status", "findall", { action: "status", findall_id: id });
  await use("findall.events", "findall", { action: "events", findall_id: id, wait_seconds: 5, return_mode: "file" });
  await use("findall.result", "findall", { action: "result", findall_id: id });
  await use("findall.extend", "findall", { action: "extend", findall_id: id, additional_match_limit: 1 }, 0.1);
  await use("findall.enrich", "findall", { action: "enrich", findall_id: id, processor: "lite", output_schema: JSON.stringify({ type: "object", properties: { abbreviation: { type: "string", description: "The organization's commonly used abbreviation" } }, required: ["abbreviation"], additionalProperties: false }) }, 0.2);
}
// Real mutations are confined to this test's resources, and cleanup runs immediately.
await use("account.balance", "account", { action: "balance" });
await use("account.list_apps", "account", { action: "list_apps" });
const app = await use("account.create_app", "account", { action: "create_app", app_name: scope });
if (app?.app_id) {
  try { await use("account.create_key", "account", { action: "create_key", app_id: app.app_id, api_key_name: scope, save_key_path: `${scope}-key.json` }); }
  finally {
    const key = await saved("account.create_key");
    if (key?.api_key_id) await use("account.delete_key", "account", { action: "delete_key", app_id: app.app_id, api_key_id: key.api_key_id });
    await use("account.delete_app", "account", { action: "delete_app", app_id: app.app_id });
  }
}
const monitor = await use("monitor.create", "monitor", { action: "create", query: `Track announcements on https://www.ietf.org/blog/ . Integration test ${scope}.`, frequency: "1w", processor: "lite", memory_scope_key: scope, metadata: JSON.stringify({ test: scope }) }, 0.02);
if (monitor?.monitor_id) {
  try {
    await use("monitor.list", "monitor", { action: "list", limit: 2 });
    await use("monitor.get", "monitor", { action: "get", monitor_id: monitor.monitor_id });
    await use("monitor.update", "monitor", { action: "update", monitor_id: monitor.monitor_id, frequency: "2w", query: `Track IETF blog announcements at https://www.ietf.org/blog/ . Integration test ${scope}.` });
    await use("monitor.trigger", "monitor", { action: "trigger", monitor_id: monitor.monitor_id }, 0.02);
    await use("monitor.events", "monitor", { action: "events", monitor_id: monitor.monitor_id, include_completions: true });
  } finally { await use("monitor.cancel", "monitor", { action: "cancel", monitor_id: monitor.monitor_id }); }
}
await use("memory.retrieve", "memory", { action: "retrieve", memory_scope_key: scope, limit: 2 });
if (task?.run_id) await use("memory.evict", "memory", { action: "evict", memory_scope_key: scope, kind: "task", id: task.run_id });
await use("memory.clear", "memory", { action: "clear", memory_scope_key: scope });
for (const [label, run] of [["findall.cancel", findall], ["findall.preview_cancel", preview]] as const) {
  if (run?.findall_id) await use(label, "findall", { action: "cancel", findall_id: run.findall_id });
}
// Recheck the account lifecycle after fixing null/204 receipt recording.
const recheck = await use("account.create_app.recheck", "account", { action: "create_app", app_name: `${scope}-recheck` });
if (recheck?.app_id) {
  try { await use("account.create_key.recheck", "account", { action: "create_key", app_id: recheck.app_id, api_key_name: scope, save_key_path: `${scope}-key-recheck.json` }); }
  finally {
    const key = await saved("account.create_key.recheck");
    if (key?.api_key_id) await use("account.delete_key.recheck", "account", { action: "delete_key", app_id: recheck.app_id, api_key_id: key.api_key_id });
    await use("account.delete_app.recheck", "account", { action: "delete_app", app_id: recheck.app_id });
  }
}
const appsAfter = await use("account.cleanup_verified", "account", { action: "list_apps" });
assert.ok(!JSON.stringify(appsAfter).includes(app?.app_id), "Original test app remains");
assert.ok(!JSON.stringify(appsAfter).includes(recheck?.app_id), "Recheck test app remains");
for (const action of ["delete_key", "delete_app"]) {
  if (report.steps[`account.${action}.recheck`]?.state === "passed") report.steps[`account.${action}`].superseded_by = `account.${action}.recheck`;
}
const baseline = await saved("task.result");
if (baseline?.run?.status === "completed") {
  const snapshot = await use("monitor.snapshot", "monitor", { action: "create", type: "snapshot", task_run_id: task.run_id, frequency: "1w", processor: "lite", memory_scope_key: scope, metadata: JSON.stringify({ test: scope }) }, 0.02);
  if (snapshot?.monitor_id) {
    try { await use("monitor.snapshot_get", "monitor", { action: "get", monitor_id: snapshot.monitor_id }); }
    finally { await use("monitor.snapshot_cancel", "monitor", { action: "cancel", monitor_id: snapshot.monitor_id }); }
  }
}
if (monitor?.monitor_id) {
  const after = await use("monitor.cleanup_verified", "monitor", { action: "get", monitor_id: monitor.monitor_id });
  assert.equal(after?.status, "cancelled");
}
if (findall?.findall_id) {
  await use("findall.result_after_enrich", "findall", { action: "result", findall_id: findall.findall_id });
  await use("findall.schema_after_enrich", "findall", { action: "schema", findall_id: findall.findall_id });
}
const snapshot = await saved("monitor.snapshot");
if (snapshot?.monitor_id) {
  const after = await use("monitor.snapshot_cleanup_verified", "monitor", { action: "get", monitor_id: snapshot.monitor_id });
  assert.equal(after?.status, "cancelled");
}
await use("search.file", "search", { search_queries: ["W3C official standards organization"], max_results: 2, return_mode: "file" }, 0.01);
await use("extract.preview", "extract", { urls: ["https://www.ietf.org/"], objective: "What is the IETF?", max_chars_total: 12000 }, 0.01);
const searchData = await saved("search.preview");
assert.ok(searchData.results.length > 0);
const extractData = await saved("extract.file");
assert.ok(extractData.results.some((r: any) => r.full_content?.length > 0));
const taskData = await saved("task.result");
assert.equal(taskData.run.status, "completed");
assert.ok(taskData.output.content.homepage);
const responseData = await saved("responses.call");
assert.ok(responseData.output_text.length > 0);
assert.ok(responseData.response.output.some((o: any) => o.content?.some((c: any) => c.annotations?.some((a: any) => a.url))));
const streamData = await saved("responses.stream");
assert.ok(streamData.events.some((e: any) => e.type === "response.completed"));
const runsData = await saved("group.runs");
assert.ok(runsData.events.some((e: any) => e.run?.status === "completed" && e.output));
const findData = await saved("findall.result");
assert.ok(findData.candidates.some((c: any) => c.url));
report.behavior_checks = "Nonempty search, saved full page, completed structured task, cited answer, terminal Responses stream, completed group output, FindAll candidates, absent test apps, cancelled monitors";
const enrichmentRun = await use("findall.enrichment_create", "findall", {
  action: "create", objective: "Find companies that develop major web browsers, including Google, Microsoft, Apple, Mozilla, and Opera.",
  entity_type: "companies", match_conditions: JSON.stringify([{ name: "browser_developer", description: "Develops a major web browser" }]),
  generator: "base", match_limit: 5, memory_scope_key: scope, metadata: JSON.stringify({ test: scope }),
}, 0.5);
if (enrichmentRun?.findall_id) {
  for (let i = 0; i < 36 && !report.enrichment_verified; i++) {
    const result = await use(`findall.enrichment_poll.${i}`, "findall", { action: "result", findall_id: enrichmentRun.findall_id, return_mode: "file" });
    if (result?.candidates?.some((c: any) => c.match_status === "matched")) {
      await use("findall.enrichment_apply", "findall", { action: "enrich", findall_id: enrichmentRun.findall_id, processor: "lite", output_schema: JSON.stringify({ type: "object", properties: { browser: { type: "string", description: "Name of a web browser developed by this company" } }, required: ["browser"], additionalProperties: false }) }, 0.2);
    }
    const enriched = result?.candidates?.filter((c: any) => c.output?.browser?.value || typeof c.output?.browser === "string") ?? [];
    if (enriched.length) {
      report.enrichment_verified = { findall_id: enrichmentRun.findall_id, candidates: enriched.length, artifact: report.steps[`findall.enrichment_poll.${i}`].artifact };
      await save();
      break;
    }
    if (!report.steps[`findall.enrichment_poll.${i + 1}`]) await new Promise(resolve => setTimeout(resolve, 5000));
  }
  await use("findall.enrichment_cancel", "findall", { action: "cancel", findall_id: enrichmentRun.findall_id });
  await use("memory.clear_after_enrichment", "memory", { action: "clear", memory_scope_key: scope });
}
const defaultPreview = await use("findall.preview_default", "findall", { action: "preview", objective: "Find companies that develop web browsers", match_limit: 5, memory_scope_key: scope }, 0.15);
if (defaultPreview?.findall_id) {
  try { assert.equal(defaultPreview.generator, "preview", "Default preview must stay on the preview generator"); }
  finally { await use("findall.preview_default_cancel", "findall", { action: "cancel", findall_id: defaultPreview.findall_id }); }
}
await use("memory.clear_final", "memory", { action: "clear", memory_scope_key: scope });
if (!report.balance_command) {
  const notices: { text: string; level: string }[] = [];
  await commands.get("webtasks").handler("balance", { ...ctx, ui: { ...ctx.ui, notify(text: string, level: string) { notices.push({ text, level }); } } });
  assert.equal(notices[0]?.level, "info");
  assert.equal(typeof JSON.parse(notices[0].text).credit_balance_cents, "number");
  report.balance_command = { state: "passed" };
}
report.finished = new Date().toISOString();
report.offline_only = ["account.add_credit", "/webtasks login (device flow helpers tested offline)", "/webtasks logout (isolated credentials tested offline)", "webhook signatures"];
await save();
console.log(JSON.stringify({ report: reportPath, reserved_usd: report.reserved_usd, counts: Object.values(report.steps).reduce((out: any, s: any) => { out[s.state] = (out[s.state] || 0) + 1; return out; }, {}) }));
