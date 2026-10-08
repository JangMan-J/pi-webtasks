import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomInt } from "node:crypto";

export const PREVIEW_LIMIT = 24_000;
export const MIN_PREVIEW_LIMIT = 2_000;
export const MAX_PREVIEW_LIMIT = 64_000;

export function getPreviewLimit(args: Record<string, unknown> = {}): number {
  const value = args.preview_chars;
  if (value === undefined) return PREVIEW_LIMIT;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < MIN_PREVIEW_LIMIT || value > MAX_PREVIEW_LIMIT) {
    throw new Error(`preview_chars must be an integer from ${MIN_PREVIEW_LIMIT} to ${MAX_PREVIEW_LIMIT}`);
  }
  return value;
}
// Receipt field_map: strings (or string lists / `content` objects) at least this
// long are "text-bearing"; the map itself stays within MAP_LIMIT compact chars.
export const FIELD_MAP_MIN_CHARS = 200;
const MAP_LIMIT = 1_800;
const NAME_ATTEMPTS = 5;
const SECRET = /^(raw_api_key|api_?key|x-api-key|access_token|refresh_token|authorization|client_secret|device_code|webhook_secret|signing_secret|password)$/i;
const CONTROL = /^(id|.*_ids?|.*_cursor|cursor|next_page.*|has_more|status|is_active|processor|generator|type|kind|timeout|partial|limit_reached|creation_artifact|retry_after.*|next_poll.*|poll_after.*|termination_reason|triggered|evicted|cleared)$/;
const LISTS = ["results", "candidates", "entities", "monitors", "events", "matches", "runs"];
type Obj = Record<string, unknown>;
export type OutputOptions = { cwd?: string; artifactDir?: string };
export type Receipt = { artifact: string | null; return_mode: "preview" | "file"; omitted: true; notice: string; [key: string]: unknown };
export class ArtifactError extends Error {}
export class PartialResponseError extends Error {
  response: unknown;
  constructor(message: string, response: unknown) {
    super(message);
    this.response = response;
  }
}

export function redact(value: unknown, mcpServer = false): unknown {
  if (Array.isArray(value)) return value.map(v => redact(v, mcpServer));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
      SECRET.test(k) || (mcpServer && k === "headers") ? "[redacted]" : redact(v, k === "mcp_servers"),
    ]));
  }
  return value;
}

export function errorData(err: unknown): unknown {
  if (!(err instanceof Error)) return redact(err);
  const e = err as Error & { status?: number; error?: unknown };
  if (e.error !== undefined) return redact({ status: e.status, error: e.error });
  let message: unknown = e.message;
  try { message = JSON.parse(e.message); } catch { /* Plain error message. */ }
  return redact({ status: e.status, error: e.error, message });
}

// Pretty JSON with every line break outside "\n" escaped, so line numbers agree
// for readers that also split on NEL/LS/PS (for example Python splitlines).
// Parsing yields the identical value.
function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u0085\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export async function writeOutput(cwd: string, path: string, value: unknown, overwrite = false): Promise<string> {
  const abs = resolve(cwd, path.replace(/^@/, ""));
  await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
  // Exclusive creation also protects concurrent calls and dangling symlinks.
  await writeFile(abs, serialize(value), { flag: overwrite ? "w" : "wx", mode: 0o600 });
  return abs;
}

// Copy-safe nonce: lowercase, no 0/o/1/l/i look-alikes.
const NONCE = "abcdefghjkmnpqrstuvwxyz23456789";
export function nonce(length = 6): string {
  let out = "";
  for (let i = 0; i < length; i++) out += NONCE[randomInt(NONCE.length)];
  return out;
}

// One short stem per result, e.g. 20260923-121314-k3f9a2 (UTC). The JSON is
// <stem>.json and its readable companion <stem>.md in the same directory.
function artifactStem(now = new Date()): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}-${nonce()}`;
}

function exists(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "EEXIST";
}

export type FieldEntry = { path: string; chars: number; start: number; end: number; items?: number };

function codePoints(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

function fieldPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  if (/^[A-Za-z_$][\w$]*$/.test(key)) return parent ? `${parent}.${key}` : key;
  return `${parent}[${JSON.stringify(key)}]`;
}

function textChars(value: unknown): number {
  if (typeof value === "string") return codePoints(value);
  if (!value || typeof value !== "object") return 0;
  let n = 0;
  for (const v of Array.isArray(value) ? value : Object.values(value)) n += textChars(v);
  return n;
}

/**
 * Text-bearing fields of `value` with 1-based inclusive line ranges in
 * `JSON.stringify(value, null, 2)`. Every scalar, including a multiline string,
 * is one line there; only non-empty containers span lines. `chars` counts
 * Unicode code points. Paths use `.key`, `[index]`, and `["json key"]` for keys
 * that are not identifiers.
 */
export function fieldEntries(value: unknown): { lines: number; entries: FieldEntry[] } {
  const entries: FieldEntry[] = [];
  let line = 1; // Line of the value being walked; afterwards its last line.
  const skipped = (v: unknown) => v === undefined || typeof v === "function" || typeof v === "symbol";
  function walk(v: unknown, path: string, key: string | number | null, collect: boolean): void {
    if (typeof v === "string") {
      const chars = collect ? codePoints(v) : 0;
      if (chars >= FIELD_MAP_MIN_CHARS) entries.push({ path: path || "(root)", chars, start: line, end: line });
      return;
    }
    if (!v || typeof v !== "object") return;
    const start = line;
    if (Array.isArray(v)) {
      if (!v.length) return;
      if (collect && v.every(x => typeof x === "string")) {
        line += v.length + 1;
        const chars = textChars(v);
        if (chars >= FIELD_MAP_MIN_CHARS) entries.push({ path: path || "(root)", chars, items: v.length, start, end: line });
        return;
      }
      v.forEach((item, i) => { line++; walk(skipped(item) ? null : item, fieldPath(path, i), i, collect); });
      line++;
      return;
    }
    const kept = Object.entries(v).filter(([, x]) => !skipped(x));
    if (!kept.length) return;
    // A structured `content` object (for example Task JSON output) is one entry.
    let container: FieldEntry | undefined;
    if (collect && key === "content") {
      const chars = textChars(v);
      if (chars >= FIELD_MAP_MIN_CHARS) entries.push(container = { path, chars, start, end: start });
    }
    for (const [k, x] of kept) { line++; walk(x, fieldPath(path, k), k, collect && !container); }
    line++;
    if (container) container.end = line;
  }
  walk(value, "", null, true);
  return { lines: line, entries };
}

function lineCount(text: string): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

function object(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
}
function clip(text: string, limit = 900): string {
  const chars = [...text];
  return chars.length <= limit ? text : `${chars.slice(0, Math.max(0, limit - 1)).join("").toWellFormed()}…`;
}
function sample(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return clip(value);
  if (!value || typeof value !== "object") return value;
  if (depth >= 3) return Array.isArray(value) ? `[${value.length} items; see artifact]` : "[object; see artifact]";
  if (Array.isArray(value)) return value.slice(0, 3).map(v => sample(v, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 8).map(([k, v]) => [clip(k, 100), sample(v, depth + 1)]));
}

function jsonSize(value: unknown): number {
  return JSON.stringify(value, null, 2)?.length ?? 0;
}

type Projection = { value: unknown; shortened: boolean; omitted: string[] };

function clippedString(text: string, budget: number): Projection {
  if (JSON.stringify(text).length <= budget) return { value: text, shortened: false, omitted: [] };
  const chars = [...text];
  let lo = 0, hi = chars.length, best = "";
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = `${chars.slice(0, mid).join("").toWellFormed()}…`;
    if (JSON.stringify(candidate).length <= budget) { best = candidate; lo = mid + 1; }
    else hi = mid - 1;
  }
  const shown = Math.max(0, [...best].length - 1);
  return { value: best, shortened: true, omitted: [`${chars.length - shown} content character${chars.length - shown === 1 ? "" : "s"}`] };
}

function projectValue(value: unknown, budget: number, depth = 0): Projection {
  if (budget < 20) return { value: "[omitted; preview budget exhausted]", shortened: true, omitted: ["value"] };
  if (typeof value === "string") return clippedString(value, budget);
  if (!value || typeof value !== "object") return { value, shortened: false, omitted: [] };
  if (jsonSize(value) <= budget) return { value, shortened: false, omitted: [] };
  if (depth >= 5) return { value: Array.isArray(value) ? `[${value.length} items; see artifact]` : { fields: fields(value) }, shortened: true, omitted: ["nested value"] };
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    const omitted: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const full = [...out, value[i]];
      if (jsonSize(full) <= budget) { out.push(value[i]); continue; }
      const projected = projectValue(value[i], Math.max(20, budget - jsonSize(out) - 20), depth + 1);
      const partial = [...out, projected.value];
      if (jsonSize(partial) <= budget) out.push(projected.value);
      omitted.push(...projected.omitted);
      if (i < value.length - 1) omitted.push(`${value.length - i - 1} array item${value.length - i - 1 === 1 ? "" : "s"}`);
      break;
    }
    return { value: out, shortened: true, omitted };
  }
  const out: Obj = Object.create(null);
  const entries = Object.entries(value);
  const omitted: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const [k, v] = entries[i];
    const full = { ...out, [k]: v };
    if (jsonSize(full) <= budget) { out[k] = v; continue; }
    const projected = projectValue(v, Math.max(20, budget - jsonSize(out) - JSON.stringify(k).length - 20), depth + 1);
    const partial = { ...out, [k]: projected.value };
    if (jsonSize(partial) <= budget) out[k] = projected.value;
    omitted.push(...projected.omitted);
    if (i < entries.length - 1) omitted.push(`${entries.length - i - 1} object field${entries.length - i - 1 === 1 ? "" : "s"}`);
    break;
  }
  return { value: out, shortened: true, omitted };
}
// API validation errors nest beyond the generic preview depth. Preserve useful
// field diagnostics, not the request's input values, within a separate budget.
function validationErrors(value: unknown, errors: Obj[] = [], depth = 0): Obj[] {
  if (depth > 8 || errors.length >= 5) return errors;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 10)) validationErrors(item, errors, depth + 1);
    return errors;
  }
  const v = object(value);
  if (Array.isArray(v.loc) && typeof v.msg === "string") {
    errors.push({ loc: v.loc.slice(0, 10).map(p => typeof p === "number" ? p : clip(String(p), 80)), msg: clip(v.msg, 400), type: typeof v.type === "string" ? clip(v.type, 80) : undefined });
  } else {
    for (const key of ["error", "errors", "detail"]) if (v[key]) validationErrors(v[key], errors, depth + 1);
  }
  return errors;
}

function fields(value: unknown): unknown {
  if (!value || typeof value !== "object") return { type: typeof value };
  return Object.fromEntries(Object.entries(value).slice(0, 12).map(([k, v]) =>
    [clip(k, 100), Array.isArray(v) ? { items: v.length } : { type: v === null ? "null" : typeof v }]));
}

function bodyContent(value: Obj): unknown {
  return value.content ?? value.text ?? value.output_text;
}

function basisFull(value: unknown): Obj {
  const x = object(value);
  const out: Obj = { field: x.field };
  if ("confidence" in x) out.confidence = x.confidence;
  if ("reasoning" in x) out.reasoning = x.reasoning;
  if (Array.isArray(x.citations)) out.citations = x.citations.map(c => {
    const citation = object(c);
    return { url: citation.url, excerpts: citation.excerpts };
  });
  return out;
}

function annotationFull(value: unknown): Obj {
  const x = object(value);
  const citation = x.url_citation ? object(x.url_citation) : x;
  return { type: x.type, url: citation.url, title: citation.title, start_index: citation.start_index, end_index: citation.end_index };
}

function citedFull(value: unknown): Obj {
  const v = object(value);
  const out: Obj = { content: bodyContent(v) };
  if (Array.isArray(v.basis)) out.basis = v.basis.map(basisFull);
  if (Array.isArray(v.annotations)) {
    const annotations = v.annotations.map(annotationFull);
    out.annotations = annotations;
    if (annotations.length) out.annotation_offsets = "Offsets refer to the original artifact text. Read the full content block before interpreting spans.";
  }
  return out;
}

function setWithinBudget(target: Obj, key: string, value: unknown, budget: number): boolean {
  const had = Object.hasOwn(target, key);
  const previous = target[key];
  target[key] = value;
  if (jsonSize(target) <= budget) return true;
  if (had) target[key] = previous;
  else delete target[key];
  return false;
}

function projectCitation(value: unknown, budget: number): Obj | undefined {
  const citation = object(value);
  const out: Obj = { url: citation.url };
  if (jsonSize(out) > budget) return undefined;
  if (Array.isArray(citation.excerpts) && citation.excerpts.length) {
    const excerpt = citation.excerpts[0];
    const projected = typeof excerpt === "string" ? clippedString(excerpt, Math.max(40, budget - jsonSize(out) - 40)) : projectValue(excerpt, Math.max(40, budget - jsonSize(out) - 40));
    const withExcerpt: Obj = { ...out, excerpts: [projected.value] };
    if (projected.shortened) withExcerpt.excerpts_shortened = true;
    if (citation.excerpts.length > 1) withExcerpt.excerpts_omitted = citation.excerpts.length - 1;
    if (jsonSize(withExcerpt) <= budget) Object.assign(out, withExcerpt);
  }
  return out;
}

function projectBasisItem(value: unknown, budget: number): Obj | undefined {
  const x = object(value);
  const out: Obj = { field: x.field };
  if (jsonSize(out) > budget) return undefined;
  if ("confidence" in x) setWithinBudget(out, "confidence", x.confidence, budget);
  if (Array.isArray(x.citations)) {
    const citations: Obj[] = [];
    setWithinBudget(out, "citations_omitted", x.citations.length, budget);
    for (let i = 0; i < x.citations.length; i++) {
      const citation = projectCitation(x.citations[i], Math.max(80, budget - jsonSize(out) + jsonSize(citations) - 20));
      if (!citation) break;
      citations.push(citation);
      out.citations = citations;
      if (x.citations.length > citations.length) out.citations_omitted = x.citations.length - citations.length;
      else delete out.citations_omitted;
      if (jsonSize(out) > budget) {
        citations.pop();
        if (citations.length) out.citations = citations;
        else delete out.citations;
        setWithinBudget(out, "citations_omitted", x.citations.length - citations.length, budget);
        break;
      }
    }
    if (!citations.length) delete out.citations;
  }
  if (typeof x.reasoning === "string") {
    const reasoning = clippedString(x.reasoning, Math.max(40, Math.min(300, budget - jsonSize(out) - 40)));
    if (setWithinBudget(out, "reasoning", reasoning.value, budget) && reasoning.shortened) setWithinBudget(out, "reasoning_shortened", true, budget);
  }
  return out;
}

function projectBasis(values: unknown[], budget: number): { basis: Obj[]; omitted: number } {
  const basis: Obj[] = [];
  let omitted = 0;
  for (let i = 0; i < values.length; i++) {
    const item = projectBasisItem(values[i], Math.max(120, budget - jsonSize(basis) - 20));
    if (!item || jsonSize([...basis, item]) > budget) { omitted = values.length - i; break; }
    basis.push(item);
  }
  return { basis, omitted };
}

function projectAnnotations(values: unknown[], budget: number): { annotations: Obj[]; omitted: number } {
  const annotations: Obj[] = [];
  let omitted = 0;
  for (let i = 0; i < values.length; i++) {
    const annotation = annotationFull(values[i]);
    if (jsonSize([...annotations, annotation]) > budget) { omitted = values.length - i; break; }
    annotations.push(annotation);
  }
  return { annotations, omitted };
}

function citedMetadata(v: Obj, budget: number, fraction: number): Obj {
  const meta: Obj = {};
  if (fraction <= 0) {
    if (Array.isArray(v.basis) && v.basis.length) meta.basis_omitted = v.basis.length;
    if (Array.isArray(v.annotations) && v.annotations.length) meta.annotations_omitted = v.annotations.length;
    return meta;
  }
  if (Array.isArray(v.basis)) {
    const basisBudget = Math.max(120, Math.min(2_400, Math.floor(budget * 0.25 * fraction)));
    const { basis, omitted } = projectBasis(v.basis, basisBudget);
    if (basis.length) meta.basis = basis;
    if (omitted) meta.basis_omitted = omitted;
  }
  if (Array.isArray(v.annotations)) {
    const annotationsBudget = Math.max(80, Math.min(1_200, Math.floor(budget * 0.12 * fraction)));
    const { annotations, omitted } = projectAnnotations(v.annotations, annotationsBudget);
    if (annotations.length) {
      meta.annotations = annotations;
      meta.annotation_offsets = "Original artifact text, not this shortened preview. Read the full content block before interpreting spans.";
    }
    if (omitted) meta.annotations_omitted = omitted;
  }
  return meta;
}

function citedWithContent(contentValue: unknown, meta: Obj, budget: number): Obj | undefined {
  let lo = 0;
  let hi = Math.max(0, budget);
  let best: Obj | undefined;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const content = projectValue(contentValue, mid);
    const candidate: Obj = { content: content.value };
    if (content.shortened) {
      candidate.content_shortened = true;
      candidate.content_omitted = content.omitted;
    }
    for (const [k, v] of Object.entries(meta)) candidate[k] = v;
    if (jsonSize(candidate) <= budget) { best = candidate; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

function citedProjected(value: unknown, budget: number): Obj {
  const v = object(value);
  const content = bodyContent(v);
  for (const fraction of [1, 0.5, 0.25, 0]) {
    const projected = citedWithContent(content, citedMetadata(v, budget, fraction), budget);
    if (projected) return projected;
  }
  return { content: "[omitted; preview budget exhausted]", content_shortened: true, content_omitted: ["content"] };
}

function cited(value: unknown, budget = Number.POSITIVE_INFINITY): Obj {
  return Number.isFinite(budget) ? citedProjected(value, budget) : citedFull(value);
}
function record(value: unknown, depth = 0): unknown {
  if (depth > 3) return { fields: fields(value) };
  const v = object(value);
  const out: Obj = {};
  for (const k of ["id", "run_id", "monitor_id", "findall_id", "candidate_id", "event_id", "event_group_id", "type", "event_type", "kind", "status", "match_status", "url"]) {
    if (k in v) out[k] = sample(v[k]);
  }
  // Never shorten source URLs.
  if (typeof v.url === "string") out.url = v.url;
  for (const k of ["title", "name", "description", "input_excerpt", "output_excerpt", "message", "excerpt", "error_message"]) {
    if (k in v) out[k] = sample(v[k]);
  }
  if (typeof v.publish_date === "string") out.publish_date = v.publish_date;
  if (Array.isArray(v.excerpts)) out.excerpts = v.excerpts;
  if (typeof v.full_content === "string") out.full_content = v.full_content;
  if (v.output) out.output = cited(v.output);
  if (v.changed_output) out.changed_output = cited(v.changed_output);
  if (v.run) out.run = sample(v.run);
  if (v.data) out.data = record(v.data, depth + 1);
  if (v.response) out.response = { id: object(v.response).id, status: object(v.response).status };
  return Object.keys(out).length ? out : { fields: fields(value) };
}

export function preview(data: unknown, artifact: string | null, args: Obj = {}, saveError?: unknown, map?: FieldEntry[]): Receipt {
  const limit = getPreviewLimit(args);
  const mode = args.return_mode === "file" ? "file" : "preview";
  const receipt: Receipt = {
    artifact, return_mode: mode, omitted: true,
    notice: saveError ? "Artifact save failed. Do not repeat the API request. Response bodies are omitted." :
      "Only selected fields are returned. Read selected artifact fields locally; never repeat a paid request to recover omitted content. Secret fields are redacted. Files persist until removed.",
  };
  const fits = () => jsonSize(receipt) <= limit;
  const remaining = (reserve = 0) => Math.max(0, limit - jsonSize(receipt) - reserve);
  function add(target: Obj, key: string, value: unknown): boolean {
    const previous = target[key];
    target[key] = value;
    if (fits()) return true;
    if (previous !== undefined) target[key] = previous;
    else delete target[key];
    return false;
  }
  function addProjectedBody(target: Obj, key: string, value: unknown): boolean {
    for (const reserve of [40, 120, 300, 600]) if (add(target, key, cited(value, remaining(reserve)))) return true;
    return false;
  }
  function omitFieldMapForBodyBudget(): void {
    const omitted = map?.length;
    delete receipt.field_map;
    delete receipt.field_map_omitted;
    if (omitted) add(receipt, "field_map_omitted", omitted);
  }
  function addBody(target: Obj, key: string, value: unknown): boolean {
    if (add(target, key, citedFull(value))) return true;
    if (addProjectedBody(target, key, value)) return true;
    omitFieldMapForBodyBudget();
    return addProjectedBody(target, key, value);
  }
  if (saveError) receipt.save_error = sample(errorData(saveError));
  const control: Obj = {};
  const counts: Obj = {};
  const diagnostics: Obj = {};
  const pendingDiagnostics: [string, unknown][] = [];
  receipt.control = control;
  receipt.counts = counts;
  receipt.diagnostics = diagnostics;
  let omittedControls = 0;
  const safe = object(redact(data));
  // Request identifiers fill gaps in stream envelopes; response values win.
  for (const k of ["search_id", "session_id", "response_id", "previous_response_id", "previous_interaction_id", "run_id", "taskgroup_id", "findall_id", "monitor_id", "id"]) {
    if (args[k] !== undefined && !add(control, k, args[k])) omittedControls++;
  }
  function metadata(v: Obj, prefix = "", depth = 0) {
    for (const [k, value] of Object.entries(v)) {
      const key = `${prefix}${k}`;
      if (CONTROL.test(k)) {
        // Keep identifiers exact whenever they fit. Large lists stay in the artifact.
        const selected = value && typeof value === "object" && !Array.isArray(value) ? sample(value) : value;
        if (!add(control, key, selected)) {
          omittedControls++;
          if (Array.isArray(value)) add(control, key, sample(value));
        }
        if (Array.isArray(value)) add(counts, key, value.length);
      }
      if (LISTS.includes(k) && Array.isArray(value)) add(counts, key, value.length);
      if (/^(error|errors|warning|warnings|error_message|incomplete_details)$/.test(k) && value != null) {
        add(counts, key, Array.isArray(value) ? value.length : 1);
        pendingDiagnostics.push([key, value]);
      }
    }
    if (depth < 3) for (const k of ["run", "response", "status", "data"]) {
      if (v[k] && typeof v[k] === "object" && !Array.isArray(v[k])) metadata(object(v[k]), `${prefix}${k}.`, depth + 1);
    }
  }
  metadata(safe);
  // Diagnostics in streams must remain visible even in file mode.
  if (Array.isArray(safe.events)) {
    let errors = 0;
    for (const ev of safe.events) {
      const v = object(ev);
      for (const k of ["response", "run", "data"]) metadata(object(v[k]), `event.${k}.`);
      const run = object(v.run ?? v.data ?? v.response);
      if (v.error || v.error_message || run.error || run.status === "failed" || v.type === "error" || v.event_type === "error") {
        errors++;
        if (errors <= 2) pendingDiagnostics.push([`events.${errors}`, v.error ?? v.error_message ?? run.error ?? { type: v.type ?? v.event_type, status: run.status }]);
      }
    }
    add(counts, "event_errors", errors);
  }
  if (omittedControls) add(receipt, "omitted_control_fields", omittedControls);
  for (const [key, value] of pendingDiagnostics) {
    const errors = validationErrors(value);
    if (!errors.length) {
      add(diagnostics, key, sample(value));
      continue;
    }
    const diagnostic = { status: object(value).status, validation_errors: [] as Obj[] };
    if (add(diagnostics, key, diagnostic)) for (const error of errors) {
      diagnostic.validation_errors.push(error);
      if (!fits()) { diagnostic.validation_errors.pop(); break; }
    }
  }
  // After identifiers and diagnostics, before bodies: exact raw JSON lines of long text.
  if (artifact && map?.length) {
    const fields: Obj = Object.create(null);
    // Reserve the widest truncation notice first so it always fits.
    const fieldMap: Obj = {
      read: "Lines of the raw JSON artifact, 1-based, inclusive, split on \\n; read with offset=first line, limit=line count. chars are Unicode code points.",
      fields, omitted: map.length, next_line: map.at(-1)!.end,
    };
    if (add(receipt, "field_map", fieldMap)) {
      let shown = 0;
      for (const e of map) {
        fields[e.path] = `${e.start === e.end ? `line ${e.start}` : `lines ${e.start}-${e.end}`}; ${e.chars} chars${e.items ? `; ${e.items} item${e.items === 1 ? "" : "s"}` : ""}`;
        if (!fits() || JSON.stringify(fieldMap).length > MAP_LIMIT) { delete fields[e.path]; break; }
        shown++;
      }
      if (shown === map.length) { delete fieldMap.omitted; delete fieldMap.next_line; }
      else { fieldMap.omitted = map.length - shown; fieldMap.next_line = map[shown].start; }
    } else add(receipt, "field_map_omitted", map.length);
  }
  if (mode === "preview" && !saveError) {
    const selected: Obj = {};
    receipt.preview = selected;
    for (const key of LISTS) {
      if (!Array.isArray(safe[key])) continue;
      const items: unknown[] = [];
      selected[key] = items;
      for (let i = 0; i < safe[key].length; i++) {
        const item = object(record(safe[key][i]));
        items.push(item);
        if (fits()) continue;
        items.pop();
        // Keep source navigation and whole excerpts that fit, without a separate
        // excerpt-count or character cap. Large full bodies remain on disk.
        if (typeof item.url === "string") {
          const source: Obj = { url: item.url, title: item.title, publish_date: item.publish_date };
          const excerpts: unknown[] = [];
          if (Array.isArray(item.excerpts)) {
            source.excerpts = excerpts;
            source.excerpts_omitted = item.excerpts.length;
          }
          if (item.full_content !== undefined) source.full_content_omitted = true;
          items.push(source);
          if (fits()) {
            for (const excerpt of Array.isArray(item.excerpts) ? item.excerpts : []) {
              excerpts.push(excerpt);
              source.excerpts_omitted = (item.excerpts as unknown[]).length - excerpts.length;
              if (!source.excerpts_omitted) delete source.excerpts_omitted;
              if (!fits()) {
                excerpts.pop();
                source.excerpts_omitted = (item.excerpts as unknown[]).length - excerpts.length;
                break;
              }
            }
            continue;
          }
          items.pop();
        }
        selected[`${key}_omitted`] = safe[key].length - i;
        if (!fits()) delete selected[`${key}_omitted`];
        break;
      }
    }
    if (safe.output && !Array.isArray(safe.output)) addBody(selected, "output", safe.output);
    const response = object(safe.response ?? safe);
    if (Array.isArray(response.output)) {
      const actions = response.output.filter(o => object(o).type === "web_search_call");
      if (actions.length) add(selected, "search_trail", {
        searches: actions.filter(o => object(object(o).action).type === "search").length,
        page_read_attempts: actions.filter(o => object(object(o).action).type === "open_page").length,
        artifact_field: safe.response ? "response.output" : "output",
        notice: "Page-read events do not prove successful retrieval. Full actions are in the artifact.",
      });
      const blocks = response.output.flatMap(o => Array.isArray(object(o).content) ? object(o).content as unknown[] : []);
      const items: unknown[] = [];
      selected.answer = items;
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        items.push(citedFull(block));
        if (fits()) continue;
        items.pop();
        items.push(cited(block, remaining(300)));
        const partialFits = fits();
        if (!partialFits) items.pop();
        const omitted = blocks.length - i - (partialFits ? 1 : 0);
        if (omitted > 0) {
          selected.answer_omitted = omitted;
          if (!fits()) {
            delete selected.answer_omitted;
            let recovered = false;
            for (let j = items.length - 1; j >= 0 && !recovered; j--) {
              const previous = items[j];
              const previousSize = jsonSize(previous);
              for (const shrink of [80, 160, 320, 640, 1_000]) {
                items[j] = cited(blocks[j], Math.max(20, previousSize - shrink));
                selected.answer_omitted = omitted;
                if (fits()) { recovered = true; break; }
                delete selected.answer_omitted;
              }
              if (!recovered) items[j] = previous;
            }
            if (!recovered) {
              const kept = items.length;
              items.length = 0;
              selected.answer_omitted = omitted + kept;
              if (!fits()) delete selected.answer_omitted;
            }
          }
        }
        break;
      }
    } else if (typeof response.output_text === "string") {
      const answer: Obj = { content: response.output_text, citations: response.citations };
      if (!add(selected, "answer", answer)) {
        const content = clippedString(response.output_text, remaining(300));
        add(selected, "answer", { content: content.value, content_shortened: content.shortened, content_omitted: content.omitted, citations: response.citations });
      }
    }
    if (!Object.keys(selected).length) add(selected, "fields", fields(data));
    if (!fits()) delete receipt.preview;
  }
  // A filesystem path can itself exceed the ceiling (for example invalid user input).
  // Keep the response bounded even then; no file exists if path resolution failed.
  if (!fits()) {
    delete receipt.field_map;
    delete receipt.field_map_omitted;
    delete receipt.diagnostics;
    delete receipt.counts;
    delete receipt.control;
    receipt.notice = "Metadata exceeds preview limit. Use the artifact for complete diagnostics.";
  }
  return receipt;
}

export async function researchReceipt(operation: () => Promise<Receipt>, args: Obj, opts: OutputOptions = {}): Promise<Receipt> {
  getPreviewLimit(args);
  try {
    return await operation();
  } catch (err) {
    if (err instanceof ArtifactError) throw err;
    return researchFailure(err instanceof PartialResponseError ? err.response : { error: errorData(err) },
      { ...args, return_mode: "file" }, opts);
  }
}

function failureMessage(data: unknown): { message: string; status?: number } {
  const top = object(data);
  const error = top.error ?? data;
  if (typeof error === "string") return { message: error };
  const e = object(error);
  const nested = object(e.error);
  const inner = object(nested.error);
  const message = [inner.message, nested.message, e.message].find(m => typeof m === "string" && m) as string | undefined;
  return { message: message ?? "unknown error; see the artifact", status: typeof e.status === "number" ? e.status : undefined };
}

/** A failure notice that states what failed and whether a retry is safe. */
function failureNotice(data: unknown, control: Obj): string {
  const { message, status } = failureMessage(data);
  const short = message.length > 300 ? `${message.slice(0, 300)}…` : message;
  const existing = Object.keys(control).some(k => /(^|\.)(run_ids?|findall_id|monitor_id|taskgroup_id|response_id|creation_artifact)$/.test(k));
  if (existing) return `Request failed: ${short} The resource already exists. Do not create it again; continue with its ID.`;
  if (status === 408 || (status ?? 0) >= 500 || (status === undefined && /timed? ?out|abort/i.test(message))) {
    return `Request failed: ${short} Completion is uncertain. Check saved artifacts or existing IDs before a paid retry.`;
  }
  return `Request failed: ${short} Nothing was created. Fix the arguments or setup named in the error, then retry.`;
}

export async function researchFailure(data: unknown, args: Obj, opts: OutputOptions = {}): Promise<never> {
  const receipt = await researchOutput(data, args, opts);
  receipt.notice = failureNotice(data, object(receipt.control)) + (receipt.save_error ? " The artifact save also failed." : "");
  throw new ArtifactError(JSON.stringify(receipt, null, 2));
}

export async function researchOutput(data: unknown, args: Obj, opts: OutputOptions = {}): Promise<Receipt> {
  const previewLimit = getPreviewLimit(args);
  let artifact: string | null = null;
  const safe = redact(data);
  let text: string;
  try {
    const explicit = typeof args.output_path === "string" && args.output_path;
    if (!explicit && !opts.artifactDir) throw new Error("Research output needs an artifact directory from the host");
    const cwd = opts.cwd ?? process.cwd();
    const abs = resolve(cwd, explicit ? explicit.replace(/^@/, "") : resolve(opts.artifactDir!, `${artifactStem()}.json`));
    if (JSON.stringify(abs).length > previewLimit - 1000) throw new Error("Artifact path is too long for a bounded receipt");
    text = serialize(safe);
    await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
    if (explicit) {
      await writeFile(abs, text, { flag: args.overwrite === true ? "w" : "wx", mode: 0o600 });
      artifact = abs;
    } else {
      // Automatic names never overwrite, even with overwrite=true; retry a fresh stem.
      for (let attempt = 1; !artifact; attempt++) {
        const path = attempt === 1 ? abs : resolve(opts.artifactDir!, `${artifactStem()}.json`);
        try {
          await writeFile(path, text, { flag: "wx", mode: 0o600 });
          artifact = path;
        } catch (err) {
          if (!exists(err) || attempt >= NAME_ATTEMPTS) throw err;
        }
      }
    }
  } catch (err) {
    throw new ArtifactError(JSON.stringify(preview(data, null, args, err), null, 2));
  }
  // The map describes the bytes just written; drop it if the layout ever disagrees.
  const map = fieldEntries(safe);
  return preview(data, artifact, args, undefined, map.lines === lineCount(text) ? map.entries : undefined);
}
