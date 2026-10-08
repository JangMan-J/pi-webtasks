// Event-driven consumption of the durable webhook inbox.
//
// Result retrieval lives in src/webhook-worker.ts so a shared worker can save
// artifacts while the owning Pi session is closed. This class still owns
// session delivery and acknowledgement. It never imports Pi and never calls
// pi.sendMessage itself.
//
// recover() resolves entries this session owns (so Pi-only mode still fetches
// when the shared worker is not running), then returns unacknowledged
// notifications for this session. Foreign entries are not fetched or mutated.
// Unmatched callbacks stay pending; they are not expired. acknowledge() is the
// caller's ACK after a successful send.

import { watch, type FSWatcher } from "node:fs";
import type { Parallel } from "parallel-web";
import { WebhookInbox, reportedRunStatus, type ResourceKind } from "./webhook-inbox.ts";
import type { ResearchRecord } from "./research-types.ts";
import { processInbox } from "./webhook-worker.ts";

export { normalizeEvent } from "./webhook-worker.ts";
export type { ConsumerAction, NormalizedEvent } from "./webhook-worker.ts";

const WATCH_DEBOUNCE_MS = 250;

export type Delivery = {
  webhook_id: string;
  resource_id: string;
  kind: ResourceKind;
  event_type?: string;
  status: "done" | "failed";
  artifact?: string;
  error?: string;
  /** Local research reference when this delivery belongs to a deep-research record. */
  reference?: string;
  /** Local-reference notification text. Remote run ids are omitted. */
  text?: string;
};

export type RecoverOptions = {
  /** Retry entries whose previous one-shot GET failed. Default recover never retries them. */
  retryFailed?: boolean;
};

export type ConsumerOptions = {
  inbox: WebhookInbox;
  /** This session's stable identifier (ctx.sessionManager.getSessionId()). */
  sessionId: string;
  /** Lazy: only invoked when a fetch is actually about to happen. */
  getClient: () => Promise<Parallel>;
  artifactDir: string;
  cwd?: string;
  fetchTimeoutMs?: number;
  onLog?: (msg: string) => void;
};

/** Notification text for a deep-research record. Does not include the remote run id. */
export function researchNotice(research: ResearchRecord, entry: { result_artifact?: string; error?: string; resource_id?: string }): string {
  const outcome = research.status === "completed" ? "completed"
    : research.status === "cancelled" ? "cancelled"
    : research.status === "action_required" ? "needs action"
    : research.status === "failed" ? "failed"
    : research.status;
  const artifact = entry.result_artifact ?? research.artifact;
  const error = research.status === "completed" ? undefined : (entry.error ?? research.error);
  const parts = [`Research ${research.reference} ${outcome}.`];
  if (artifact) parts.push(`Saved: ${artifact}.`);
  if (error) parts.push(withoutRemote(error, research.run_id));
  parts.push("Read the saved research locally; do not repeat the request.");
  return parts.join(" ");
}

function withoutRemote(text: string, runId: string | undefined): string {
  if (!runId || runId.length < 4) return text;
  return text.split(runId).join("").replace(/[ \t]{2,}/g, " ").trim();
}

export class WebhookConsumer {
  readonly inbox: WebhookInbox;
  private readonly sessionId: string;
  private readonly getClient: () => Promise<Parallel>;
  private readonly artifactDir: string;
  private readonly cwd: string | undefined;
  private readonly fetchTimeoutMs: number;
  private readonly onLog: (msg: string) => void;
  private watcher: FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<{ processed: number; deliveries: Delivery[] }> | undefined;
  private fetchAbort: AbortController | undefined;
  private stopping = false;
  private rerun = false;

  constructor(options: ConsumerOptions) {
    this.inbox = options.inbox;
    this.sessionId = options.sessionId;
    this.getClient = options.getClient;
    this.artifactDir = options.artifactDir;
    this.cwd = options.cwd;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 45_000;
    this.onLog = options.onLog ?? (() => {});
  }

  /**
   * Resolve this session's due entries, then collect (without ACKing) its
   * notifications. A re-entrant call marks the in-flight pass to run again
   * instead of starting a second fetch. Default does not retry fetch_failed
   * entries.
   */
  async recover(options?: RecoverOptions): Promise<{ processed: number; deliveries: Delivery[] }> {
    if (this.inFlight) {
      this.rerun = true;
      return { processed: 0, deliveries: [] };
    }
    const run = this.runRecover(!!options?.retryFailed);
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
    }
  }

  private async runRecover(retryFailed: boolean): Promise<{ processed: number; deliveries: Delivery[] }> {
    let processed = 0;
    let deliveries: Delivery[] = [];
    do {
      this.rerun = false;
      processed += await this.processPending(retryFailed);
      deliveries = await this.collectDeliveries();
    } while (this.rerun && !this.stopping);
    return { processed, deliveries };
  }

  /** Caller ACK after an actual successful session notification. */
  async acknowledge(webhook_id: string): Promise<void> {
    await this.inbox.acknowledgeDelivery(webhook_id);
  }

  private async processPending(retryFailed: boolean): Promise<number> {
    return processInbox({
      inbox: this.inbox,
      getClient: this.getClient,
      artifactDir: this.artifactDir,
      cwd: this.cwd,
      fetchTimeoutMs: this.fetchTimeoutMs,
      onLog: this.onLog,
      sessionId: this.sessionId,
      retryFailed,
      isStopping: () => this.stopping,
      setFetchAbort: abort => { this.fetchAbort = abort; },
    });
  }

  private async collectDeliveries(): Promise<Delivery[]> {
    const deliveries: Delivery[] = [];
    // A run can be reported by both a signed callback and the outbound stream, possibly in different
    // processes and different batches. One notice per run and reported status: an outcome already
    // acknowledged (persistent) or already in this batch is acknowledged without a second notice.
    // A different status, such as completion after action_required, is its own notice.
    const inBatch = new Set<string>();
    for (const entry of await this.inbox.listHandledUnnotified()) {
      if (!entry.resource_id || !entry.kind) continue;
      const registration = await this.inbox.getRegistration(entry.resource_id);
      if (!registration || registration.session_id !== this.sessionId) continue;
      if (entry.kind === "task") {
        const status = reportedRunStatus(entry.event);
        const duplicate = status !== undefined && (inBatch.has(`${entry.resource_id}:${status}`) || await this.inbox.isRunStatusNotified(entry.resource_id, status));
        if (duplicate) {
          await this.inbox.markNotified(entry.webhook_id);
          continue;
        }
        if (status !== undefined) inBatch.add(`${entry.resource_id}:${status}`);
      }
      const research = entry.kind === "task" ? await this.inbox.researchForRun(entry.resource_id) : undefined;
      const delivery: Delivery = {
        webhook_id: entry.webhook_id,
        resource_id: entry.resource_id,
        kind: entry.kind,
        event_type: entry.event_type,
        status: entry.terminal_failure ? "failed" : "done",
        artifact: entry.result_artifact ?? research?.artifact,
        error: entry.error,
      };
      if (research) {
        delivery.reference = research.reference;
        delivery.text = researchNotice(research, entry);
        if (research.status === "completed") delivery.status = "done";
        else if (research.status === "failed" || research.status === "cancelled" || research.status === "action_required") delivery.status = "failed";
      }
      deliveries.push(delivery);
    }
    return deliveries;
  }

  /**
   * Event-driven, not polling: recomputes only when the shared inbox
   * directory changes. `onDue` should call recover() and deliver. Default
   * recover() must not pass retryFailed.
   */
  start(onDue: () => void): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.inbox.baseDir, { persistent: false }, () => {
        if (this.debounce) return;
        this.debounce = setTimeout(() => {
          this.debounce = undefined;
          onDue();
        }, WATCH_DEBOUNCE_MS);
      });
      this.watcher.on("error", err => this.onLog(`webhook consumer watcher error: ${err instanceof Error ? err.message : String(err)}`));
    } catch (err) {
      this.onLog(`webhook consumer: could not watch ${this.inbox.baseDir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Abort an in-flight fetch and wait for the current recover pass to finish. */
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
    this.fetchAbort?.abort(new Error("webhook consumer stopped"));
    const pending = this.inFlight;
    try {
      if (pending) await pending;
    } finally {
      this.stopping = false;
    }
  }
}
