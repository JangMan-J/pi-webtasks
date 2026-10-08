// bench/score.ts — scoring preparation and validation for the E-vs-C benchmark.
//
// Scope (plan §8 and work package): gold-packet normalization from
// bench/gold.json, tool-name neutralization for visible event records,
// structured two-rater output validation against actual event IDs (aggregate
// and per-criterion), explicit missing scores, and the disagreement queue.
// This module never calls a model grader or a paid API; the live judge runner
// is built elsewhere and consumes these helpers.
//
// Disagreements on judgments are never silently averaged: differing rater
// scores produce an operator adjudication queue entry carrying both full
// judgments. Different but individually valid citation sets are preserved
// separately and do not by themselves require adjudication.

import type { RunEvent, RunRecord, RunScore } from "./report.ts";

// ---------------------------------------------------------------------------
// Tool-name neutralization (blinding support, with stated limits)
// ---------------------------------------------------------------------------

/**
 * Default product/tool name -> neutral capability label map. Covers the nine
 * pinned extension tools, the CLI executable, the Responses helper, and the
 * credential/base-URL variables visible in events. Shared resources (find-docs,
 * Context7) are identical in both arms and need no label.
 */
export const DEFAULT_CAPABILITY_LABELS: Record<string, string> = {
  parallel_search: "capability_web_search",
  parallel_extract: "capability_url_extract",
  parallel_responses: "capability_synthesis",
  parallel_task: "capability_deep_research",
  parallel_group: "capability_batch_research",
  parallel_findall: "capability_entity_search",
  parallel_monitor: "capability_monitor_admin",
  parallel_memory: "capability_memory_admin",
  parallel_account: "capability_account_admin",
  "parallel-cli": "capability_research_cli",
  "parallel-research": "capability_research_helper",
  PARALLEL_API_KEY: "RESEARCH_API_KEY",
  PARALLEL_API_URL: "RESEARCH_BASE_URL",
  PARALLEL_BASE_URL: "RESEARCH_BASE_URL",
  PIPARA_API_KEY: "RESEARCH_API_KEY",
};

/** Ordinary Pi tools available identically in both arms; never flagged. */
export const COMMON_PI_TOOLS = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "fabric_exec",
]);

export const BLINDING_NOTE =
  "Neutralization substitutes known product and tool names with capability labels. Output formats, CLI idioms, or unmapped names may still reveal the treatment, so ratings are not claimed fully blind.";

export interface NeutralizationResult {
  events: RunEvent[];
  replacements: number;
  /** Tool-like names seen in events with no configured label: blinding may leak. */
  unmappedToolNames: string[];
}

function replaceAll(
  text: string,
  keys: string[],
  map: Record<string, string>,
): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const k of keys) {
    if (out.includes(k)) {
      const parts = out.split(k);
      count += parts.length - 1;
      out = parts.join(map[k]);
    }
  }
  return { text: out, count };
}

function walkStrings(
  value: unknown,
  keys: string[],
  map: Record<string, string>,
): { value: unknown; count: number } {
  if (typeof value === "string") {
    const r = replaceAll(value, keys, map);
    return { value: r.text, count: r.count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const items = value.map((v) => {
      const r = walkStrings(v, keys, map);
      count += r.count;
      return r.value;
    });
    return { value: items, count };
  }
  if (value !== null && typeof value === "object") {
    let count = 0;
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = walkStrings(v, keys, map);
      count += r.count;
      obj[k] = r.value;
    }
    return { value: obj, count };
  }
  return { value, count: 0 };
}

const TOOL_NAME_FIELDS = ["tool", "toolName", "name"];
const TOOL_NAME_SHAPE = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/**
 * Neutralize tool names in visible event records. Substitution only rewrites
 * name occurrences inside string values; no event, field, or error is removed
 * or truncated, so errors and extra steps survive for the raters. Events are
 * deep-copied; the input records are not mutated.
 */
export function neutralizeEvents(
  events: RunEvent[],
  extraLabels: Record<string, string> = {},
): NeutralizationResult {
  const map = { ...DEFAULT_CAPABILITY_LABELS, ...extraLabels };
  const keys = Object.keys(map).sort((a, b) => b.length - a.length); // longest first
  const labelValues = new Set(Object.values(map));
  const unmapped = new Set<string>();
  let replacements = 0;
  const out: RunEvent[] = events.map((e) => {
    for (const field of TOOL_NAME_FIELDS) {
      const v = e[field];
      if (
        typeof v === "string" &&
        !(v in map) &&
        !labelValues.has(v) &&
        !COMMON_PI_TOOLS.has(v) &&
        TOOL_NAME_SHAPE.test(v)
      ) {
        unmapped.add(v);
      }
    }
    const r = walkStrings(e, keys, map);
    replacements += r.count;
    return r.value as RunEvent;
  });
  return { events: out, replacements, unmappedToolNames: [...unmapped].sort() };
}

// ---------------------------------------------------------------------------
// Gold packets: normalize the on-disk bench/gold.json schema
// ---------------------------------------------------------------------------

/** One required claim as frozen by the curator. */
export interface GoldClaim {
  id: string;
  text: string;
  /** Provenance references into sources[] ids or fixture paths. */
  sourceIds: string[];
}

/** One frozen evidence source; sha256/file/bytes stay evaluator-side. */
export interface GoldSource {
  id: string;
  kind: string;
  url: string | null;
  retrievedUtc: string | null;
  evidencePassages: string[];
}

/** Normalized per-case gold packet (from bench/gold.json `cases`). */
export interface GoldPacket {
  caseId: string;
  sourceFamily: string;
  rubric: string;
  requiredClaims: GoldClaim[];
  sources: GoldSource[];
  /** Upper bound for supportedClaims validation. */
  claimCount: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function needString(v: unknown, where: string): string {
  if (typeof v !== "string" || v.length === 0) throw new Error(`gold ${where}: expected non-empty string`);
  return v;
}

/**
 * Normalize one case out of the raw bench/gold.json document. Throws on any
 * malformed required field: a missing gold packet is a curator defect, never
 * permission to invent an answer. Evaluator-only fields (file, sha256, bytes,
 * workspace_files) are deliberately dropped from the rater-facing packet.
 */
export function normalizeGold(goldFile: unknown, caseId: string): GoldPacket {
  if (!isRecord(goldFile) || !isRecord(goldFile.cases)) {
    throw new Error("gold file: expected an object with a cases map");
  }
  const raw = goldFile.cases[caseId];
  if (!isRecord(raw)) throw new Error(`gold file: no packet for case ${caseId}`);
  if (!Array.isArray(raw.requiredClaims) || raw.requiredClaims.length === 0) {
    throw new Error(`gold ${caseId}: requiredClaims must be a non-empty array`);
  }
  const requiredClaims: GoldClaim[] = raw.requiredClaims.map((c, i) => {
    if (!isRecord(c)) throw new Error(`gold ${caseId}: claim ${i} is not an object`);
    return {
      id: needString(c.id, `${caseId} claim ${i} id`),
      text: needString(c.text, `${caseId} claim ${i} text`),
      sourceIds: Array.isArray(c.sourceIds) ? c.sourceIds.map((s) => needString(s, `${caseId} claim sourceId`)) : [],
    };
  });
  const sources: GoldSource[] = (Array.isArray(raw.sources) ? raw.sources : []).map((s, i) => {
    if (!isRecord(s)) throw new Error(`gold ${caseId}: source ${i} is not an object`);
    if (!Array.isArray(s.evidence_passages) || s.evidence_passages.some((p) => typeof p !== "string")) {
      throw new Error(`gold ${caseId}: source ${i} evidence_passages must be a string array`);
    }
    return {
      id: needString(s.id, `${caseId} source ${i} id`),
      kind: typeof s.kind === "string" ? s.kind : "unknown",
      url: typeof s.url === "string" ? s.url : null,
      retrievedUtc: typeof s.retrieved_utc === "string" ? s.retrieved_utc : null,
      evidencePassages: s.evidence_passages as string[],
    };
  });
  return {
    caseId,
    sourceFamily: typeof raw.sourceFamily === "string" ? raw.sourceFamily : caseId,
    rubric: needString(raw.rubric, `${caseId} rubric`),
    requiredClaims,
    sources,
    claimCount: requiredClaims.length,
  };
}

// ---------------------------------------------------------------------------
// Structured rater input
// ---------------------------------------------------------------------------

export interface RaterInput {
  caseId: string;
  runId: string;
  prompt: string | null;
  answer: string;
  events: RunEvent[];
  gold: {
    rubric: string;
    requiredClaims: GoldClaim[];
    sources: GoldSource[];
  };
  outputSchema: "bench/scoring-schema.json";
  blinding: {
    neutralizedToolNames: boolean;
    unmappedToolNames: string[];
    limitation: string;
  };
}

/**
 * Build the structured input for one rater. The arm, model route, token usage,
 * and timing are deliberately absent: raters label from the answer and the
 * neutralized observable events, not from treatment-identifying metadata.
 * Raters must cite evidence-event IDs for every penalty and every awarded
 * evidence point, per-criterion in metadata.evidence.
 */
export function buildRaterInput(
  run: RunRecord,
  gold: GoldPacket,
  opts: { prompt?: string; extraLabels?: Record<string, string> } = {},
): RaterInput {
  if (gold.caseId !== run.caseId) {
    throw new Error(`gold packet ${gold.caseId} does not match run case ${run.caseId}`);
  }
  const neutral = neutralizeEvents(run.events, opts.extraLabels);
  return {
    caseId: run.caseId,
    runId: run.runId,
    prompt: opts.prompt ?? null,
    answer: run.answer,
    events: neutral.events,
    gold: {
      rubric: gold.rubric,
      requiredClaims: gold.requiredClaims,
      sources: gold.sources,
    },
    outputSchema: "bench/scoring-schema.json",
    blinding: {
      neutralizedToolNames: true,
      unmappedToolNames: neutral.unmappedToolNames,
      limitation: BLINDING_NOTE,
    },
  };
}

// ---------------------------------------------------------------------------
// Structured output validation (references actual event IDs)
// ---------------------------------------------------------------------------

/**
 * Per-criterion evidence entry carried in score metadata. Recommended
 * criterion names: "retrieval", "quality.conclusion", "quality.coverage",
 * "quality.support", "quality.uncertainty", "criticalViolation",
 * "materialWrong", "fabricatedCitation". Plan §8: raters cite evidence-event
 * IDs for every penalty and every awarded evidence point.
 */
export interface CriterionEvidence {
  criterion: string;
  outcome: "awarded" | "penalty";
  eventIds: string[];
  note?: string;
}

const SCORE_KEYS = new Set([
  "runId",
  "retrieval",
  "quality",
  "criticalViolation",
  "materialWrong",
  "fabricatedCitation",
  "evidenceEventIds",
  "supportedClaims",
  "notes",
  "metadata",
]);

function isIntIn(v: unknown, lo: number, hi: number): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
}

function parseCriterionEvidence(
  raw: unknown,
  known: ReadonlySet<string>,
  errors: string[],
): CriterionEvidence[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push("metadata.evidence must be an array of per-criterion entries");
    return [];
  }
  const out: CriterionEvidence[] = [];
  raw.forEach((e, i) => {
    const where = `metadata.evidence[${i}]`;
    if (!isRecord(e)) {
      errors.push(`${where} must be an object`);
      return;
    }
    if (typeof e.criterion !== "string" || e.criterion.length === 0) {
      errors.push(`${where}.criterion must be a non-empty string`);
    }
    if (e.outcome !== "awarded" && e.outcome !== "penalty") {
      errors.push(`${where}.outcome must be "awarded" or "penalty"`);
    }
    if (!Array.isArray(e.eventIds) || e.eventIds.length === 0 || e.eventIds.some((x) => typeof x !== "string")) {
      errors.push(`${where}.eventIds must be a non-empty array of strings`);
      return;
    }
    for (const id of e.eventIds as string[]) {
      if (!known.has(id)) errors.push(`${where}.eventIds references unknown event ${JSON.stringify(id)}`);
    }
    if (typeof e.criterion === "string" && (e.outcome === "awarded" || e.outcome === "penalty")) {
      out.push({
        criterion: e.criterion,
        outcome: e.outcome,
        eventIds: e.eventIds as string[],
        ...(typeof e.note === "string" ? { note: e.note } : {}),
      });
    }
  });
  return out;
}

export interface ValidateScoreOptions {
  /** When supplied, supportedClaims is bounded by the gold claim count. */
  gold?: GoldPacket;
}

/**
 * Validate one rater's structured output against bench/scoring-schema.json
 * semantics plus the run's actual events. Returns a list of errors; an empty
 * list means the score is usable. Per plan §8, every penalty and every awarded
 * evidence point needs event-level citations: aggregate evidenceEventIds plus
 * per-criterion entries in metadata.evidence, all referencing real event IDs.
 * Runs with no citable events are exempt from citation coverage, but notes
 * must then explain the basis of the judgment.
 */
export function validateScore(score: unknown, run: RunRecord, opts: ValidateScoreOptions = {}): string[] {
  const errors: string[] = [];
  if (!isRecord(score)) return ["score must be an object"];
  const s = score;
  for (const k of Object.keys(s)) {
    if (!SCORE_KEYS.has(k)) errors.push(`unknown key: ${k}`);
  }
  if (s.runId !== run.runId) {
    errors.push(`runId ${JSON.stringify(s.runId)} does not match run ${run.runId}`);
  }
  if (!isIntIn(s.retrieval, 0, 2)) errors.push("retrieval must be an integer in 0..2");
  if (!isIntIn(s.quality, 0, 4)) errors.push("quality must be an integer in 0..4");
  for (const f of ["criticalViolation", "materialWrong", "fabricatedCitation"] as const) {
    if (typeof s[f] !== "boolean") errors.push(`${f} must be a boolean`);
  }
  if (!(typeof s.supportedClaims === "number" && Number.isInteger(s.supportedClaims) && s.supportedClaims >= 0)) {
    errors.push("supportedClaims must be a non-negative integer");
  } else if (opts.gold) {
    if (opts.gold.caseId !== run.caseId) {
      errors.push(`gold packet ${opts.gold.caseId} does not match run case ${run.caseId}`);
    } else if ((s.supportedClaims as number) > opts.gold.claimCount) {
      errors.push(
        `supportedClaims ${s.supportedClaims} exceeds the gold claim count ${opts.gold.claimCount} for case ${run.caseId}`,
      );
    }
  }
  if (typeof s.notes !== "string") errors.push("notes must be a string");
  if (s.metadata !== undefined && !isRecord(s.metadata)) {
    errors.push("metadata must be an object when present");
  }

  const known = new Set(run.events.map((e) => e.id));
  if (!Array.isArray(s.evidenceEventIds) || s.evidenceEventIds.some((x) => typeof x !== "string")) {
    errors.push("evidenceEventIds must be an array of strings");
  } else {
    for (const id of s.evidenceEventIds as string[]) {
      if (!known.has(id)) errors.push(`evidenceEventIds references unknown event ${JSON.stringify(id)} for run ${run.runId}`);
    }
  }
  const metadata = isRecord(s.metadata) ? s.metadata : {};
  const criterionEvidence = parseCriterionEvidence(metadata.evidence, known, errors);

  if (run.events.length > 0) {
    if (Array.isArray(s.evidenceEventIds) && (s.evidenceEventIds as string[]).length === 0) {
      errors.push("evidenceEventIds must cite at least one event: every penalty and every awarded evidence point requires an event reference");
    }
    // Per-criterion coverage of every penalty and every awarded evidence point.
    const has = (criterionPrefix: string, outcome: CriterionEvidence["outcome"]) =>
      criterionEvidence.some((e) => e.outcome === outcome && e.criterion.startsWith(criterionPrefix));
    for (const f of ["criticalViolation", "materialWrong", "fabricatedCitation"] as const) {
      if (s[f] === true && !has(f, "penalty")) {
        errors.push(`${f}=true requires a metadata.evidence penalty entry with criterion "${f}"`);
      }
    }
    if (isIntIn(s.retrieval, 0, 2) && (s.retrieval as number) < 2 && !has("retrieval", "penalty")) {
      errors.push("retrieval < 2 requires a metadata.evidence penalty entry for the retrieval criterion");
    }
    if (isIntIn(s.quality, 0, 4)) {
      if ((s.quality as number) < 4 && !has("quality", "penalty")) {
        errors.push("quality < 4 requires metadata.evidence penalty entries for each unawarded quality point");
      }
      if ((s.quality as number) >= 3 && !criterionEvidence.some((e) => e.outcome === "awarded")) {
        errors.push("quality >= 3 awards the support point and requires a metadata.evidence awarded entry");
      }
    }
  } else if (
    Array.isArray(s.evidenceEventIds) &&
    (s.evidenceEventIds as string[]).length === 0 &&
    (typeof s.notes !== "string" || s.notes.trim() === "")
  ) {
    errors.push("run has no citable events; notes must explain the basis of the judgment");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Two-rater comparison: judgment disagreements queued, citations preserved
// ---------------------------------------------------------------------------

/**
 * The substantive judgments two raters can disagree on. Citation sets are
 * compared separately: different but individually valid event choices are
 * preserved for the record and do not by themselves require adjudication.
 */
export const COMPARED_FIELDS = [
  "retrieval",
  "quality",
  "criticalViolation",
  "materialWrong",
  "fabricatedCitation",
  "supportedClaims",
] as const;
export type ComparedField = (typeof COMPARED_FIELDS)[number];

export interface FieldDisagreement {
  field: (typeof COMPARED_FIELDS)[number];
  raterA: unknown;
  raterB: unknown;
}

export function compareScores(a: RunScore, b: RunScore): FieldDisagreement[] {
  if (a.runId !== b.runId) throw new Error(`cannot compare scores for ${a.runId} and ${b.runId}`);
  const diffs: FieldDisagreement[] = [];
  for (const f of COMPARED_FIELDS) {
    if (a[f] !== b[f]) diffs.push({ field: f, raterA: a[f], raterB: b[f] });
  }
  return diffs;
}

function sameCitationSet(a: string[], b: string[]): boolean {
  return [...a].sort().join("") === [...b].sort().join("");
}

export interface AdjudicationItem {
  runId: string;
  fields: FieldDisagreement[];
  /** Both full judgments travel with the item; nothing is merged or averaged. */
  raterA: RunScore;
  raterB: RunScore;
  /** Distinct citation sets, preserved for the operator and the report. */
  citationSets: { raterA: string[]; raterB: string[] };
  status: "awaiting_operator";
}

export interface AdjudicationResult {
  queue: AdjudicationItem[];
  agreedRunIds: string[];
  /**
   * Runs where the judgments agree but the cited event sets differ.
   * Informational only: these do not require operator adjudication.
   */
  citationOnlyDifferences: { runId: string; raterA: string[]; raterB: string[] }[];
  agreementRate: number | null; // null when no pairs supplied
}

/**
 * Emit the operator adjudication queue for judgment disagreements. Both full
 * judgments travel with each item; no merged or averaged score is ever
 * produced here. Citation-only differences are recorded separately and kept
 * out of the queue.
 */
export function buildAdjudicationQueue(pairs: { a: RunScore; b: RunScore }[]): AdjudicationResult {
  const queue: AdjudicationItem[] = [];
  const agreed: string[] = [];
  const citationOnly: AdjudicationResult["citationOnlyDifferences"] = [];
  for (const { a, b } of pairs) {
    const diffs = compareScores(a, b);
    const citationsDiffer = !sameCitationSet(a.evidenceEventIds, b.evidenceEventIds);
    if (diffs.length === 0) {
      agreed.push(a.runId);
      if (citationsDiffer) {
        citationOnly.push({ runId: a.runId, raterA: a.evidenceEventIds, raterB: b.evidenceEventIds });
      }
    } else {
      queue.push({
        runId: a.runId,
        fields: diffs,
        raterA: a,
        raterB: b,
        citationSets: { raterA: a.evidenceEventIds, raterB: b.evidenceEventIds },
        status: "awaiting_operator",
      });
    }
  }
  const total = pairs.length;
  return {
    queue,
    agreedRunIds: agreed,
    citationOnlyDifferences: citationOnly,
    agreementRate: total ? agreed.length / total : null,
  };
}

// ---------------------------------------------------------------------------
// Explicit missing scores
// ---------------------------------------------------------------------------

export interface MissingScore {
  runId: string;
  caseId: string;
  arm: RunRecord["arm"];
  status: RunRecord["status"];
  reason: "missing_score";
}

/** Every run without a score is listed explicitly; nothing is zero-filled here. */
export function missingScores(runs: RunRecord[], scores: RunScore[]): MissingScore[] {
  const have = new Set(scores.map((s) => s.runId));
  return runs
    .filter((r) => !have.has(r.runId))
    .map((r) => ({ runId: r.runId, caseId: r.caseId, arm: r.arm, status: r.status, reason: "missing_score" as const }));
}

/** Index scores by run, surfacing duplicates instead of overwriting silently. */
export function scoresByRun(scores: RunScore[]): { map: Map<string, RunScore>; duplicateRunIds: string[] } {
  const map = new Map<string, RunScore>();
  const dupes: string[] = [];
  for (const s of scores) {
    if (map.has(s.runId)) dupes.push(s.runId);
    else map.set(s.runId, s);
  }
  return { map, duplicateRunIds: dupes };
}

// ---------------------------------------------------------------------------
// Final overlay: copy disputed fields from a named original rater. Never average,
// never invent a value neither rater assigned, never mutate the queue items.
// A Grok overlay pass is not a third independent model and is not rater consensus.
// ---------------------------------------------------------------------------

export interface FinalFieldDecision {
  field: ComparedField;
  value: RunScore[ComparedField];
  /** Which original rater already assigned this value. */
  source: "raterA" | "raterB";
  rubricClause: string;
  evidenceEventIds: string[];
  rationale: string;
}

export interface FinalAdjudicationRecord {
  runId: string;
  adjudicator: string;
  independentThirdModel: false;
  sameFamilyAs: string;
  notRaterConsensus: true;
  provenance: {
    goldCaseId: string;
    goldRubric: string;
    runPath: string;
    raterAPath: string;
    raterBPath: string;
    originalQueuePath: string;
  };
  rationale: string;
  fields: FinalFieldDecision[];
  evidenceEventIds: string[];
  notes: string;
}

export interface FinalAdjudicationFile {
  kind: "final_adjudication_overlay";
  independentThirdModel: false;
  description: string;
  records: FinalAdjudicationRecord[];
}

export interface AppliedAdjudications {
  /** Agreed scores plus overlays; original rater objects are not in this list as mutated copies. */
  scores: RunScore[];
  remaining: AdjudicationItem[];
  applied: RunScore[];
}

function cloneScore(s: RunScore): RunScore {
  return structuredClone(s);
}

export function overlayFinalScore(item: AdjudicationItem, rec: FinalAdjudicationRecord): RunScore {
  if (rec.runId !== item.runId) throw new Error(`overlay runId ${rec.runId} does not match queue item ${item.runId}`);
  if (rec.independentThirdModel !== false) throw new Error("final overlay must not claim a third independent model");
  if (rec.notRaterConsensus !== true) throw new Error("final overlay must not be labeled rater consensus");
  const disputed = new Map(item.fields.map((f) => [f.field, f]));
  if (rec.fields.length !== item.fields.length) {
    throw new Error(`${item.runId}: overlay must decide every disputed field exactly once`);
  }
  const seen = new Set<ComparedField>();
  const out = cloneScore(item.raterA);
  for (const f of rec.fields) {
    if (seen.has(f.field)) throw new Error(`${item.runId}: duplicate overlay field ${f.field}`);
    seen.add(f.field);
    const d = disputed.get(f.field);
    if (!d) throw new Error(`${item.runId}: overlay of undisputed field ${f.field}`);
    const expected = f.source === "raterA" ? item.raterA[f.field] : item.raterB[f.field];
    if (f.value !== expected) {
      throw new Error(
        `${item.runId}: overlay ${f.field}=${JSON.stringify(f.value)} is not ${f.source}'s ${JSON.stringify(expected)}; invented scores are forbidden`,
      );
    }
    (out as unknown as Record<ComparedField, RunScore[ComparedField]>)[f.field] = f.value;
  }
  for (const field of disputed.keys()) {
    if (!seen.has(field)) throw new Error(`${item.runId}: missing overlay for ${field}`);
  }
  out.notes = rec.notes;
  out.evidenceEventIds = [...rec.evidenceEventIds];
  out.metadata = {
    ...(out.metadata ?? {}),
    finalAdjudication: {
      adjudicator: rec.adjudicator,
      independentThirdModel: false,
      sameFamilyAs: rec.sameFamilyAs,
      notRaterConsensus: true,
      fieldSources: rec.fields.map((f) => ({ field: f.field, source: f.source, value: f.value })),
    },
  };
  return out;
}

/**
 * Apply final overlays onto the agreed set. Queue items and original rater
 * scores are left unchanged. Unresolved items stay in `remaining`.
 */
export function applyFinalAdjudications(
  agreed: RunScore[],
  queue: AdjudicationItem[],
  records: FinalAdjudicationRecord[],
): AppliedAdjudications {
  const byRun = new Map<string, FinalAdjudicationRecord>();
  for (const rec of records) {
    if (byRun.has(rec.runId)) throw new Error(`duplicate final adjudication for ${rec.runId}`);
    byRun.set(rec.runId, rec);
  }
  const queueIds = new Set(queue.map((q) => q.runId));
  for (const rec of records) {
    if (!queueIds.has(rec.runId)) throw new Error(`final adjudication for unknown queue run ${rec.runId}`);
  }
  const remaining: AdjudicationItem[] = [];
  const applied: RunScore[] = [];
  for (const item of queue) {
    const rec = byRun.get(item.runId);
    if (!rec) {
      remaining.push(item);
      continue;
    }
    applied.push(overlayFinalScore(item, rec));
  }
  return { scores: [...agreed.map(cloneScore), ...applied], remaining, applied };
}
