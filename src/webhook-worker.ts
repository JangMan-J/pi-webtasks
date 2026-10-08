// Shared result processing for verified webhook callbacks. Pi notification and
// acknowledgement stay in WebhookConsumer. This module never imports Pi.
//
// A callback is fetched only after ownership is established: an existing
// registration, or a Task callback whose signed metadata matches one persisted
// research record on all of webtasks_ref, webtasks_session, and webtasks_group.
// Anything else stays pending. Unmatched callbacks are not expired and are not
// fetched. The worker can resolve a registered owner while that Pi session is
// closed; it does not deliver or acknowledge notifications.

import { watch, type FSWatcher } from "node:fs";
import type { Parallel } from "parallel-web";
import { WebhookInbox, isTerminalResearch, type InboxEntry, type Registration, type ResourceKind } from "./webhook-inbox.ts";
import type { ResearchStatus } from "./research-types.ts";
import { researchOutput } from "./results.ts";
import { taskResultOnce, findallResultOnce, monitorEventGroupOnce, type CallOpts } from "./ops.ts";

const DEFAULT_FETCH_TIMEOUT_MS = 45_000;
const WATCH_DEBOUNCE_MS = 250;

const TASK_EVENT_TYPE = "task_run.status";
const TASK_FETCH_STATUSES = new Set(["completed"]);
const TASK_FAILURE_STATUSES = new Set(["failed", "cancelled"]);
const TASK_ACTION_REQUIRED = new Set(["action_required"]);

const FINDALL_FETCH_TYPES = new Set(["findall.run.completed"]);
const FINDALL_FAILURE_TYPES = new Set(["findall.run.failed", "findall.run.cancelled"]);
const FINDALL_NO_CHANGE_TYPES = new Set([
  "findall.candidate.generated",
  "findall.candidate.matched",
  "findall.candidate.enriched",
  "findall.candidate.unmatched",
  "findall.candidate.cancelled",
]);

const MONITOR_DETECTED = "monitor.event.detected";
const MONITOR_NO_CHANGE = "monitor.execution.completed";
const MONITOR_FAILURE = "monitor.execution.failed";

/** Signed TaskRun metadata. `webtasks_ref` stays within the 16-character key limit. */
export const TASK_META = {
  ref: "webtasks_ref",
  session: "webtasks_session",
  group: "webtasks_group",
} as const;

export type ConsumerAction = "fetch" | "failure" | "action_required" | "no_change" | "unrecognized";

export type NormalizedEvent = {
  resource_id?: string;
  kind?: ResourceKind;
  event_type?: string;
  /** Monitor `monitor.event.detected` only. */
  event_group_id?: string;
  action: ConsumerAction;
};

export type ProcessOptions = {
  inbox: WebhookInbox;
  getClient: () => Promise<Parallel>;
  artifactDir: string;
  cwd?: string;
  fetchTimeoutMs?: number;
  onLog?: (msg: string) => void;
  /** When set, only this session's registrations are mutated or fetched. */
  sessionId?: string;
  retryFailed?: boolean;
  isStopping?: () => boolean;
  setFetchAbort?: (abort: AbortController | undefined) => void;
};

type TaskIdentity = { reference: string; session: string; group: string; run_id: string };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
function firstOf(...vals: (string | undefined)[]): string | undefined {
  return vals.find(v => v !== undefined);
}
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string" && item) out[key] = item;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Strict envelope normalization against Parallel's documented webhook JSON.
 * Unknown event types and nonterminal task statuses never fetch and never
 * mark a resource terminal.
 */
export function normalizeEvent(event: unknown): NormalizedEvent {
  const e = asRecord(event);
  const type = str(e.type);
  const data = asRecord(e.data);
  const run = asRecord(data.run);
  const nestedEvent = asRecord(data.event);

  if (type === TASK_EVENT_TYPE) {
    const resource_id = firstOf(str(data.run_id), str(run.run_id));
    const status = firstOf(str(data.status), str(run.status));
    let action: ConsumerAction = "unrecognized";
    if (resource_id && status && TASK_FETCH_STATUSES.has(status)) action = "fetch";
    else if (resource_id && status && TASK_FAILURE_STATUSES.has(status)) action = "failure";
    else if (resource_id && status && TASK_ACTION_REQUIRED.has(status)) action = "action_required";
    return { resource_id, kind: "task", event_type: type, action };
  }

  if (type && (FINDALL_FETCH_TYPES.has(type) || FINDALL_FAILURE_TYPES.has(type) || FINDALL_NO_CHANGE_TYPES.has(type))) {
    const resource_id = firstOf(str(data.findall_id), str(run.findall_id));
    let action: ConsumerAction = "unrecognized";
    if (!resource_id) action = "unrecognized";
    else if (FINDALL_FETCH_TYPES.has(type)) action = "fetch";
    else if (FINDALL_FAILURE_TYPES.has(type)) action = "failure";
    else action = "no_change";
    return { resource_id, kind: "findall", event_type: type, action };
  }

  if (type === MONITOR_DETECTED || type === MONITOR_NO_CHANGE || type === MONITOR_FAILURE) {
    const resource_id = firstOf(str(data.monitor_id), str(run.monitor_id));
    const event_group_id = firstOf(str(data.event_group_id), str(nestedEvent.event_group_id), str(run.event_group_id));
    let action: ConsumerAction = "unrecognized";
    if (!resource_id) action = "unrecognized";
    else if (type === MONITOR_DETECTED) action = event_group_id ? "fetch" : "unrecognized";
    else if (type === MONITOR_NO_CHANGE) action = "no_change";
    else action = "failure";
    return { resource_id, kind: "monitor", event_type: type, event_group_id, action };
  }

  return { action: "unrecognized", event_type: type };
}

function taskRunStatus(event: unknown): string | undefined {
  const data = asRecord(asRecord(event).data);
  return firstOf(str(data.status), str(asRecord(data.run).status));
}

function describeFailure(event: unknown): string {
  const e = asRecord(event);
  const data = asRecord(e.data);
  const run = asRecord(data.run);
  const nestedEvent = asRecord(data.event);
  const errObj = asRecord(data.error);
  const statusObj = asRecord(data.status);
  return firstOf(
    str(errObj.message),
    str(nestedEvent.error),
    str(statusObj.termination_reason),
    str(data.error_message),
    str(run.error_message),
    typeof data.status === "string" ? str(data.status) : str(statusObj.status),
    str(run.status),
    str(e.type),
  ) ?? "webhook reported a failure/cancellation with no further detail";
}

function mergedMetadata(event: unknown): Record<string, string> | undefined {
  const data = asRecord(asRecord(event).data);
  const top = stringMap(data.metadata);
  const nested = stringMap(asRecord(data.run).metadata);
  if (top && nested) {
    for (const key of [TASK_META.ref, TASK_META.session, TASK_META.group]) {
      if (top[key] && nested[key] && top[key] !== nested[key]) return undefined;
    }
  }
  const merged = { ...nested, ...top };
  return Object.keys(merged).length ? merged : undefined;
}

/** All three metadata fields must be present. A partial or conflicting tag does not reconcile. */
export function taskIdentity(event: unknown, runId: string | undefined): TaskIdentity | undefined {
  if (!runId) return undefined;
  const meta = mergedMetadata(event);
  const reference = meta?.[TASK_META.ref];
  const session = meta?.[TASK_META.session];
  const group = meta?.[TASK_META.group];
  if (!reference || !session || !group) return undefined;
  return { reference, session, group, run_id: runId };
}

function idField(kind: ResourceKind): "run_id" | "findall_id" | "monitor_id" {
  return kind === "task" ? "run_id" : kind === "findall" ? "findall_id" : "monitor_id";
}

function researchOutcome(event: unknown, action: ConsumerAction): ResearchStatus | undefined {
  if (action === "action_required") return "action_required";
  if (action !== "failure") return undefined;
  return taskRunStatus(event) === "cancelled" ? "cancelled" : "failed";
}

async function fetchOnce(client: Parallel, kind: ResourceKind, resource_id: string, event_group_id: string | undefined, opts: CallOpts): Promise<unknown> {
  if (kind === "task") return taskResultOnce(client, resource_id, opts);
  if (kind === "findall") return findallResultOnce(client, resource_id, opts);
  if (!event_group_id) throw new Error("monitor.event.detected payload missing event_group_id");
  return monitorEventGroupOnce(client, resource_id, event_group_id, opts);
}

/** Actual provider interaction from a completed result. Never copied from run or group ids. */
export function providerInteractionId(data: unknown): string | undefined {
  const root = asRecord(data);
  const id = firstOf(
    str(asRecord(root.run).interaction_id),
    str(root.interaction_id),
    str(asRecord(asRecord(root.result).run).interaction_id),
  );
  if (!id || id.length > 1000) return undefined;
  return id;
}

async function syncResearch(inbox: WebhookInbox, runId: string, patch: { status: ResearchStatus; artifact?: string; error?: string; interaction_id?: string }): Promise<void> {
  const research = await inbox.researchForRun(runId);
  if (!research) return;
  if (isTerminalResearch(research.status) && patch.status !== research.status) return;
  const next: { status: ResearchStatus; artifact?: string; error?: string; interaction_id?: string } = { status: patch.status };
  if (patch.artifact !== undefined) next.artifact = patch.artifact;
  if (patch.error !== undefined) next.error = patch.error;
  if (patch.interaction_id && (!research.interaction_id || research.interaction_id === patch.interaction_id)) {
    next.interaction_id = patch.interaction_id;
  }
  await inbox.updateResearch(research.reference, next);
}

async function reconcile(inbox: WebhookInbox, entry: InboxEntry, norm: NormalizedEvent, sessionId: string | undefined, onLog: (msg: string) => void): Promise<Registration | undefined> {
  if (norm.kind !== "task" || !norm.resource_id) return undefined;
  const identity = taskIdentity(entry.event, norm.resource_id);
  if (!identity) return undefined;
  if (sessionId && identity.session !== sessionId) return undefined;
  const research = await inbox.getResearch(identity.reference);
  if (!research || research.session_id !== identity.session || research.group_id !== identity.group) return undefined;
  try {
    await inbox.acceptResearch(identity.reference, identity.run_id);
  } catch (err) {
    onLog(`webhook reconcile refused for ${identity.reference}: ${messageOf(err)}`);
    return undefined;
  }
  return inbox.getRegistration(identity.run_id);
}

async function claimHandled(inbox: WebhookInbox, entry: InboxEntry, patch: Partial<InboxEntry>, notify: boolean): Promise<boolean> {
  const claim = await inbox.claimEntry(entry.webhook_id);
  if (!claim) return false;
  try {
    await inbox.markHandled(entry.webhook_id, patch);
    if (notify) await inbox.markNotified(entry.webhook_id);
    return true;
  } finally {
    await claim.release();
  }
}

/**
 * Resolve due inbox entries. Does not collect or acknowledge notifications.
 * Returns the number of entries marked handled. A retained unmatched callback
 * is not a write and is not a fetch.
 */
export async function processInbox(options: ProcessOptions): Promise<number> {
  const onLog = options.onLog ?? (() => {});
  const stopping = options.isStopping ?? (() => false);
  let processed = 0;
  for (const entry of await options.inbox.listPending()) {
    if (stopping()) break;
    if (await processEntry(options, entry, onLog, stopping)) processed++;
  }
  return processed;
}

async function processEntry(options: ProcessOptions, entry: InboxEntry, onLog: (msg: string) => void, stopping: () => boolean): Promise<boolean> {
  const inbox = options.inbox;
  const norm = normalizeEvent(entry.event);
  if (!norm.resource_id || !norm.kind) {
    return claimHandled(inbox, entry, { terminal_failure: true, error: "no resource_id/kind derived from event shape" }, true)
      .then(ok => { if (ok) onLog(`webhook event ${entry.webhook_id} not routed: no resource_id/kind derived from event shape`); return ok; });
  }
  let registration = await inbox.getRegistration(norm.resource_id);
  if (!registration) {
    registration = await reconcile(inbox, entry, norm, options.sessionId, onLog);
  }
  // No ownership yet: retain for a later registration or a matching record. Do not fetch or expire.
  if (!registration) return false;
  if (options.sessionId && registration.session_id !== options.sessionId) return false;
  if (registration.kind !== norm.kind) {
    const error = `registration kind mismatch: registered as ${registration.kind}, event says ${norm.kind}`;
    return claimHandled(inbox, entry, { resource_id: norm.resource_id, kind: norm.kind, event_type: norm.event_type, terminal_failure: true, error }, true)
      .then(ok => { if (ok) onLog(`webhook event ${entry.webhook_id} not routed: ${error}`); return ok; });
  }
  if (entry.fetch_failed && !options.retryFailed) return false;
  if (norm.action === "no_change") {
    return claimHandled(inbox, entry, { resource_id: norm.resource_id, kind: norm.kind, event_type: norm.event_type }, true);
  }
  if (norm.action === "unrecognized") {
    const error = `unhandled event_type ${norm.event_type ?? "(none)"} status`;
    return claimHandled(inbox, entry, { resource_id: norm.resource_id, kind: norm.kind, event_type: norm.event_type, terminal_failure: true, error }, true)
      .then(ok => { if (ok) onLog(`webhook event ${entry.webhook_id} not routed: ${error}`); return ok; });
  }

  const claim = await inbox.claimEntry(entry.webhook_id);
  if (!claim) return false;
  try {
    if (norm.action === "failure" || norm.action === "action_required") {
      return await recordOutcome(options, entry, norm, registration, onLog);
    }
    if (registration.kind !== "monitor" && await inbox.isTerminal(norm.resource_id)) {
      if (!registration.result_artifact) {
        await inbox.recordFetchFailure(entry.webhook_id, registration.error ?? "previous result was not saved to an artifact");
        return false;
      }
      await inbox.markHandled(entry.webhook_id, {
        resource_id: norm.resource_id, kind: norm.kind, event_type: norm.event_type,
        result_artifact: registration.result_artifact,
      });
      await inbox.markNotified(entry.webhook_id);
      return true;
    }
    if (stopping()) return false;
    const client = await options.getClient();
    const abort = new AbortController();
    options.setFetchAbort?.(abort);
    if (stopping()) {
      abort.abort(new Error("webhook consumer stopped"));
      return false;
    }
    const timeout = setTimeout(() => abort.abort(new Error("webhook result fetch timed out")), options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
    let data: unknown;
    try {
      data = await fetchOnce(client, norm.kind, norm.resource_id, norm.event_group_id, { signal: abort.signal });
    } finally {
      clearTimeout(timeout);
      options.setFetchAbort?.(undefined);
    }
    if (stopping()) return false;
    const args: Record<string, unknown> = { return_mode: "file" };
    args[idField(norm.kind)] = norm.resource_id;
    if (norm.event_group_id) args.event_group_id = norm.event_group_id;
    const artifactDir = registration.artifact_dir || options.artifactDir;
    const cwd = registration.cwd || options.cwd;
    const receipt = await researchOutput(data, args, { cwd, artifactDir });
    if (!receipt.artifact || receipt.save_error) {
      const err = receipt.save_error ? `artifact save_error: ${JSON.stringify(receipt.save_error)}` : "researchOutput returned no artifact";
      await inbox.recordFetchFailure(entry.webhook_id, err);
      onLog(`webhook artifact missing for ${norm.kind} ${norm.resource_id}: ${err}`);
      return false;
    }
    if (norm.kind === "task") {
      const interaction_id = providerInteractionId(data);
      await syncResearch(inbox, norm.resource_id, {
        status: "completed", artifact: receipt.artifact, ...(interaction_id ? { interaction_id } : {}),
      });
    }
    await inbox.updateRegistration(norm.resource_id,
      registration.kind === "monitor" ? { result_artifact: receipt.artifact } : { status: "done", result_artifact: receipt.artifact });
    await inbox.markHandled(entry.webhook_id, { resource_id: norm.resource_id, kind: norm.kind, event_type: norm.event_type, result_artifact: receipt.artifact });
    return true;
  } catch (err) {
    if (stopping()) return false;
    const message = messageOf(err);
    await inbox.recordFetchFailure(entry.webhook_id, message);
    onLog(`webhook fetch failed for ${norm.kind} ${norm.resource_id}: ${message}`);
    return false;
  } finally {
    await claim.release();
  }
}

async function recordOutcome(options: ProcessOptions, entry: InboxEntry, norm: NormalizedEvent, registration: Registration, _onLog: (msg: string) => void): Promise<boolean> {
  const inbox = options.inbox;
  const outcome = researchOutcome(entry.event, norm.action);
  const error = describeFailure(entry.event);
  if (norm.action === "failure" && registration.kind !== "monitor" && registration.status === "failed") {
    await inbox.markHandled(entry.webhook_id, { resource_id: norm.resource_id, kind: norm.kind, event_type: norm.event_type, terminal_failure: true, error: registration.error ?? error });
    await inbox.markNotified(entry.webhook_id);
    return true;
  }
  if (norm.action === "action_required" && norm.resource_id) {
    const existing = await inbox.researchForRun(norm.resource_id);
    if (existing?.status === "action_required") {
      await inbox.markHandled(entry.webhook_id, { resource_id: norm.resource_id, kind: norm.kind, event_type: norm.event_type, terminal_failure: true, error });
      await inbox.markNotified(entry.webhook_id);
      return true;
    }
  }
  if (norm.kind === "task" && norm.resource_id && outcome) {
    await syncResearch(inbox, norm.resource_id, { status: outcome, error });
  }
  if (registration.kind !== "monitor" && norm.action === "failure" && norm.resource_id) {
    await inbox.updateRegistration(norm.resource_id, { status: "failed", error });
  }
  await inbox.markHandled(entry.webhook_id, {
    resource_id: norm.resource_id, kind: norm.kind, event_type: norm.event_type, terminal_failure: true, error,
  });
  return true;
}

export type WorkerOptions = {
  inbox: WebhookInbox;
  /** Invoked only when a routable completion is about to be fetched. */
  getClient: () => Promise<Parallel>;
  artifactDir: string;
  cwd?: string;
  fetchTimeoutMs?: number;
  onLog?: (msg: string) => void;
};

/** In-process result worker. Does not listen for HTTP and does not notify Pi. */
export class WebhookWorker {
  private readonly options: WorkerOptions;
  private readonly onLog: (msg: string) => void;
  private watcher: FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<number> | undefined;
  private rerun = false;
  private stopping = false;
  private fetchAbort: AbortController | undefined;

  constructor(options: WorkerOptions) {
    this.options = options;
    this.onLog = options.onLog ?? (() => {});
  }

  /** Wake after a durable inbox change. Safe before start(); does not fetch until a pass runs. */
  kick(): void {
    if (this.stopping) return;
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.recover();
    }, WATCH_DEBOUNCE_MS);
  }

  async start(): Promise<void> {
    await this.options.inbox.init();
    if (this.watcher || this.stopping) return;
    try {
      this.watcher = watch(this.options.inbox.baseDir, { persistent: false }, () => this.kick());
      this.watcher.on("error", err => this.onLog(`webhook worker watcher error: ${messageOf(err)}`));
    } catch (err) {
      this.onLog(`webhook worker: could not watch ${this.options.inbox.baseDir}: ${messageOf(err)}`);
    }
    void this.recover();
  }

  async recover(options?: { retryFailed?: boolean }): Promise<{ processed: number }> {
    if (this.stopping) return { processed: 0 };
    if (this.inFlight) {
      this.rerun = true;
      return { processed: 0 };
    }
    const run = this.runLoop(!!options?.retryFailed);
    this.inFlight = run;
    try {
      return { processed: await run };
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
    }
  }

  private async runLoop(retryFailed: boolean): Promise<number> {
    let processed = 0;
    do {
      this.rerun = false;
      processed += await processInbox({
        inbox: this.options.inbox,
        getClient: this.options.getClient,
        artifactDir: this.options.artifactDir,
        cwd: this.options.cwd,
        fetchTimeoutMs: this.options.fetchTimeoutMs,
        onLog: this.onLog,
        retryFailed,
        isStopping: () => this.stopping,
        setFetchAbort: abort => { this.fetchAbort = abort; },
      });
    } while (this.rerun && !this.stopping);
    return processed;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
    this.fetchAbort?.abort(new Error("webhook worker stopped"));
    const pending = this.inFlight;
    try {
      if (pending) await pending;
    } finally {
      this.stopping = false;
    }
  }
}
