// Outbound completion for one Pi session. While the runtime is live, the owning session follows its own
// Task Group's event stream and records each settled run as a synthetic entry in the existing inbox
// events table. The shared processing path then fetches the result and notifies only the owning session.
// Nothing runs when Pi is closed: there is no daemon.
//
// Each pass opens the event stream from the stored cursor, then takes a snapshot of the group's runs,
// then consumes the stream. A transition is therefore either in the snapshot or in the stream, and the
// snapshot is the fallback whenever streaming fails. Entry IDs are deterministic, so replays and snapshot
// repeats are ignored. The cursor moves only in the same transaction that records the events it covers.
//
// Two client-side deadlines bound wall-clock time, because the SDK timeout covers only the time until
// response headers arrive (node_modules/parallel-web/client.js fetchWithTimeout clears its timer once fetch
// resolves): one per events connection (10 minutes), and one per snapshot covering open and body (60 s).

import type Parallel from "parallel-web";
import { setTimeout as delay } from "node:timers/promises";
import { formatError } from "./ops.ts";
import type { ResearchSession } from "./research.ts";
import type { ResearchRecord } from "./research-types.ts";

/** Shared backoff and deadlines. Values are milliseconds. */
export const OUTBOUND_BACKOFF = {
  baseMs: 5_000,
  capMs: 300_000,
  /** Upper bound for a server Retry-After hint on 429 or 503. */
  retryAfterCapMs: 900_000,
  /** A connection that stayed open this long, measured from a successful open, counts as healthy. */
  healthyLifeMs: 60_000,
  /** Pause after a healthy end of stream before the next pass. */
  healthyEofMs: 1_000,
  /** Wall-clock bound on one events connection, open and body. Expiry is a healthy end. */
  connectionMs: 600_000,
  /** Wall-clock bound on one snapshot, open and body. Expiry is a failure. */
  snapshotMs: 60_000,
} as const;

/** SDK timeout for the events and snapshot requests. It bounds time to headers only. */
const REQUEST_TIMEOUT_MS = 60_000;
const RECORDED = new Set(["completed", "failed", "cancelled", "action_required"]);
const SETTLED = new Set(["completed", "failed", "cancelled"]);
const WATCHED = new Set(["pending", "action_required"]);
const TASK_EVENT = "task_run.status";

type RunLike = {
  run_id: string;
  status: string;
  metadata?: Record<string, string | number | boolean> | null;
  error?: { ref_id: string; message: string } | null;
  interaction_id?: string;
};

type Entry = { webhook_id: string; resource_id: string; event_type: string; event: unknown };

export type OutboundOptions = {
  session: ResearchSession;
  /** Runs after new entries are durably recorded, so the consumer can process them promptly. */
  onRecorded?: () => void;
  onLog?: (msg: string) => void;
  /** Dispatch records older than this cannot be in flight in this runtime. Default: construction time. */
  startedAt?: number;
  /** Overrides for OUTBOUND_BACKOFF deadlines (tests). */
  deadlines?: Partial<Pick<typeof OUTBOUND_BACKOFF, "connectionMs" | "snapshotMs">>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
};

/** Both requests of one pass can fail; each cause keeps its own Retry-After hint. */
class PassFailure extends Error {
  readonly causes: unknown[];
  constructor(causes: unknown[]) {
    super(causes.map(c => formatError(c)).join("; ").slice(0, 300));
    this.causes = causes;
  }
}

type Deadline = { signal: AbortSignal; expired: () => boolean; clear: () => void };

/** A signal that aborts when the parent aborts or after `ms`, and records which of the two happened. */
function deadlineFor(parent: AbortSignal, ms: number): Deadline {
  const own = new AbortController();
  let fired = false;
  const timer = setTimeout(() => { fired = true; own.abort(new Error("deadline exceeded")); }, ms);
  const forward = () => own.abort(parent.reason);
  if (parent.aborted) forward();
  else parent.addEventListener("abort", forward, { once: true });
  return {
    signal: own.signal,
    expired: () => fired,
    clear: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", forward);
    },
  };
}

export function outboundEntryId(runId: string, status: string): string {
  return `outbound:${runId}:${status}`;
}

/** Server hint from Retry-After headers, present only on 429 and 503. */
export function retryAfterMs(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | undefined)?.status;
  if (status !== 429 && status !== 503) return undefined;
  const headers = (err as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") return undefined;
  const read = (name: string): string | null => {
    if (headers instanceof Headers) return headers.get(name);
    const value = (headers as Record<string, unknown>)[name];
    return typeof value === "string" ? value : null;
  };
  const ms = read("retry-after-ms");
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const seconds = read("retry-after");
  if (seconds) {
    if (Number.isFinite(Number(seconds))) return Number(seconds) * 1000;
    const date = Date.parse(seconds);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return undefined;
}

const defaultSleep = async (ms: number, signal: AbortSignal): Promise<void> => {
  await delay(ms, undefined, { signal }).catch(() => undefined);
};

function entryFor(run: RunLike): Entry {
  const data: Record<string, unknown> = { run_id: run.run_id, status: run.status };
  if (run.metadata) data.metadata = run.metadata;
  if (run.error) data.error = run.error;
  if (run.interaction_id) data.interaction_id = run.interaction_id;
  return {
    webhook_id: outboundEntryId(run.run_id, run.status),
    resource_id: run.run_id,
    event_type: TASK_EVENT,
    event: { type: TASK_EVENT, source: "outbound", data },
  };
}

export class OutboundCollector {
  private readonly session: ResearchSession;
  private readonly onRecorded: () => void;
  private readonly onLog: (msg: string) => void;
  private readonly startedAt: number;
  private readonly deadlines: { connectionMs: number; snapshotMs: number };
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly abort = new AbortController();
  /** Unbound records already covered by a snapshot pass, keyed by reference and status. */
  private readonly tried = new Set<string>();
  private loop: Promise<void> | undefined;
  private stopped = false;
  private woken = false;
  private wakeIdle: (() => void) | undefined;
  private failures = 0;
  private reported = false;

  constructor(options: OutboundOptions) {
    this.session = options.session;
    this.onRecorded = options.onRecorded ?? (() => {});
    this.onLog = options.onLog ?? (() => {});
    this.startedAt = options.startedAt ?? Date.now();
    this.deadlines = { connectionMs: options.deadlines?.connectionMs ?? OUTBOUND_BACKOFF.connectionMs, snapshotMs: options.deadlines?.snapshotMs ?? OUTBOUND_BACKOFF.snapshotMs };
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  /** Idempotent. Work starts only when a pending, action-required, or unbound record exists for the session's group. */
  start(): void {
    if (this.loop || this.stopped) return;
    this.loop = this.run();
  }

  /** Re-check for work now, for example after a deep submission. Never starts a request by itself. */
  wake(): void {
    this.woken = true;
    this.wakeIdle?.();
  }

  /** Aborts the stream, snapshot and any backoff sleep, then waits until the loop has finished. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort(new Error("Outbound collector stopped"));
    this.wakeIdle?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      let wait: number;
      try {
        if (!(await this.hasWork())) {
          await this.idle();
          continue;
        }
        const pass = await this.pass();
        if (this.stopped) break;
        if (pass === "idle") continue;
        if (pass.healthy) {
          this.failures = 0;
          this.reported = false;
          wait = OUTBOUND_BACKOFF.healthyEofMs;
        } else {
          wait = this.failed([]);
        }
      } catch (err) {
        if (this.stopped) break;
        wait = this.failed(err instanceof PassFailure ? err.causes : [err]);
      }
      await this.sleep(wait, this.abort.signal);
    }
  }

  /**
   * Exponential backoff with jitter (75–100% of the step). The largest Retry-After hint among the
   * causes raises the wait, capped at retryAfterCapMs.
   */
  private failed(causes: unknown[]): number {
    this.failures++;
    const step = Math.min(OUTBOUND_BACKOFF.capMs, OUTBOUND_BACKOFF.baseMs * 2 ** (this.failures - 1));
    let wait = step * (0.75 + 0.25 * this.random());
    const hints = causes.map(retryAfterMs).filter((hint): hint is number => hint !== undefined);
    if (hints.length) wait = Math.max(wait, Math.min(Math.max(...hints), OUTBOUND_BACKOFF.retryAfterCapMs));
    if (causes.length && !this.reported) {
      this.reported = true;
      this.onLog(`Research completion stream unavailable; retrying in the background: ${formatError(new PassFailure(causes)).slice(0, 300)}`);
    }
    return Math.round(wait);
  }

  private async idle(): Promise<void> {
    // An abort that already happened must not leave the loop waiting for a listener that never fires.
    if (!this.woken && !this.stopped) {
      await new Promise<void>(resolve => {
        const done = () => {
          this.wakeIdle = undefined;
          this.abort.signal.removeEventListener("abort", done);
          resolve();
        };
        this.wakeIdle = done;
        this.abort.signal.addEventListener("abort", done, { once: true });
      });
    }
    this.woken = false;
  }

  private candidate(record: ResearchRecord): boolean {
    if (record.run_id) return false;
    return record.status === "uncertain" || (record.status === "dispatching" && record.created_at < this.startedAt);
  }

  private trackKey(record: ResearchRecord): string {
    return `${record.reference}:${record.status}`;
  }

  /** A bound pending or action-required run, or an unbound uncertain submission no snapshot has covered yet. */
  private async hasWork(): Promise<boolean> {
    const group = this.session.group;
    if (!group || this.stopped || this.session.stopped) return false;
    const store = await this.session.config.getStore();
    for (const record of await store.listResearchForSession(this.session.sessionId)) {
      if (record.group_id !== group) continue;
      if (record.run_id && WATCHED.has(record.status)) return true;
      if (this.candidate(record) && !this.tried.has(this.trackKey(record))) return true;
    }
    return false;
  }

  /**
   * One pass: open the events stream from the stored cursor, take the snapshot, then consume the stream.
   * Failures from the open and from the snapshot are both reported, so both Retry-After hints count.
   */
  private async pass(): Promise<"idle" | { healthy: boolean }> {
    const group = this.session.group!;
    const store = await this.session.config.getStore();
    const client = await this.session.config.getClient();
    const connection = deadlineFor(this.abort.signal, this.deadlines.connectionMs);
    try {
      const resumeFrom = (await store.getSessionGroup(this.session.sessionId))?.event_cursor;
      let stream: AsyncIterable<unknown> | undefined;
      let openError: unknown;
      let openedAt = 0;
      try {
        stream = await client.taskGroup.events(group, { last_event_id: resumeFrom ?? undefined }, { maxRetries: 0, timeout: REQUEST_TIMEOUT_MS, signal: connection.signal });
        openedAt = Date.now(); // the healthy-lifetime clock starts only once the stream is open
      } catch (err) {
        openError = err;
      }
      // A failed open does not skip the snapshot, which is the polling fallback.
      let snapshotError: unknown;
      try {
        await this.reconcile(client, group);
      } catch (err) {
        snapshotError = err;
      }
      if (this.stopped) return "idle";
      if (snapshotError === undefined && !(await this.hasWork())) return "idle";
      const causes = [openError, snapshotError].filter(cause => cause !== undefined);
      if (causes.length) throw new PassFailure(causes);

      let runEvents = 0;
      try {
        for await (const raw of stream!) {
          if (this.stopped) break;
          const event = raw as { type?: string; event_id?: string | null; run?: RunLike; error?: { message?: string } };
          if (event.type === "error") throw new Error(`Task group event stream error: ${event.error?.message ?? "unknown"}`);
          if (event.type === "task_group_status") {
            if (typeof event.event_id === "string") await store.recordOutbound({ session_id: this.session.sessionId, cursor: event.event_id });
            continue;
          }
          if (event.type !== "task_run.state" || !event.run) continue;
          runEvents++;
          const entry = await this.observe(event.run, group);
          const eventCursor = typeof event.event_id === "string" && event.event_id ? event.event_id : undefined;
          if (!entry && eventCursor === undefined) continue;
          const inserted = await store.recordOutbound({
            session_id: this.session.sessionId,
            ...(entry ? { events: [entry] } : {}),
            ...(eventCursor !== undefined ? { cursor: eventCursor } : {}),
          });
          if (inserted) this.onRecorded();
        }
      } catch (err) {
        // Our own connection deadline ends the body abruptly; that is a healthy end, not an error.
        if (!connection.expired() || this.stopped) throw err;
      }
      if (this.stopped) return "idle";
      const lifeMs = Date.now() - openedAt;
      return { healthy: runEvents > 0 || lifeMs >= OUTBOUND_BACKOFF.healthyLifeMs || connection.expired() };
    } finally {
      connection.clear(); // releases the HTTP stream on every exit path
    }
  }

  /** Snapshot of all runs in the group, under its own deadline. Records settled runs of this session; never moves the cursor. */
  private async reconcile(client: Parallel, group: string): Promise<void> {
    const store = await this.session.config.getStore();
    const covered = (await store.listResearchForSession(this.session.sessionId)).filter(r => r.group_id === group && this.candidate(r)).map(r => this.trackKey(r));
    const snap = deadlineFor(this.abort.signal, this.deadlines.snapshotMs);
    try {
      const snapshot = await client.taskGroup.getRuns(group, {}, { maxRetries: 0, timeout: REQUEST_TIMEOUT_MS, signal: snap.signal });
      let recorded = 0;
      for await (const raw of snapshot) {
        if (this.stopped) return;
        const item = raw as { type?: string; error?: { message?: string }; run?: RunLike };
        if (item.type === "error") throw new Error(`Task group snapshot error: ${item.error?.message ?? "unknown"}`);
        if (!item.run) continue;
        const entry = await this.observe(item.run, group);
        if (entry && (await store.recordOutbound({ session_id: this.session.sessionId, events: [entry] }))) recorded++;
      }
      // A body cut short by the deadline ends without an error; it must not count as a complete snapshot.
      if (snap.expired()) throw new Error("Task group snapshot timed out");
      for (const key of covered) this.tried.add(key);
      if (recorded) this.onRecorded();
    } catch (err) {
      if (snap.expired() && !this.stopped) throw new Error("Task group snapshot timed out", { cause: err });
      throw err;
    } finally {
      snap.clear();
    }
  }

  /** Returns the synthetic entry for a settled run of this session that is not yet settled locally. */
  private async observe(run: RunLike, group: string): Promise<Entry | undefined> {
    const store = await this.session.config.getStore();
    const record = (await store.researchForRun(run.run_id)) ?? (await this.bindByMetadata(run, group));
    if (!record || record.session_id !== this.session.sessionId || record.group_id !== group) return undefined;
    if (!RECORDED.has(run.status) || SETTLED.has(record.status)) return undefined;
    return entryFor(run);
  }

  /** Binds an unbound uncertain submission to the run its metadata identifies. Never rebinds. */
  private async bindByMetadata(run: RunLike, group: string): Promise<ResearchRecord | undefined> {
    const meta = run.metadata ?? {};
    const reference = meta.webtasks_ref;
    if (typeof reference !== "string" || meta.webtasks_session !== this.session.sessionId || meta.webtasks_group !== group) return undefined;
    const store = await this.session.config.getStore();
    const candidate = await store.getResearch(reference);
    if (!candidate || candidate.run_id || candidate.session_id !== this.session.sessionId || candidate.group_id !== group) return undefined;
    if (!this.candidate(candidate)) return undefined;
    try {
      await store.acceptResearch(reference, run.run_id);
    } catch (err) {
      this.onLog(`Research ${reference} could not be bound to its run: ${formatError(err).slice(0, 200)}`);
      return undefined;
    }
    return store.researchForRun(run.run_id);
  }
}
