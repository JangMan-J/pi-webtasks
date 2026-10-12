// Durable authenticated inbox, dedup store, and local run/session registration
// for the minimal event-driven webhook integration (see
// docs/webhook-integration-review.md sections 4-5 and docs/webhook-integration.md).
//
// Backed by `node:sqlite` (Node >=22.17, well within this package's >=22.19.0
// floor) rather than a hand-rolled file-locking/rename scheme. An earlier
// version of this module implemented dedup and mutual exclusion with plain
// files (O_EXCL create + rename-based claim reclaim). Direct probing found
// two real defects in that approach: (1) reclaiming a dead owner's claim by
// renaming it away briefly vacated the canonical claim path, letting a
// second, unrelated claimEntry() call recreate it there and produce two
// simultaneous claims; (2) a writer that crashed between O_EXCL open() and a
// completed write left a corrupt/empty file that later callers treated as a
// silently-accepted "duplicate", permanently losing an authenticated
// delivery. Both are exactly the class of bug that transactional storage
// exists to rule out. SQLite's own crash-safe journal/WAL and cross-process
// file locking (`BEGIN IMMEDIATE`) are the actual proof for the properties
// this module claims, in place of a proof for a bespoke primitive:
//
//  - Dedup + durable ACK: `events.webhook_id` is a PRIMARY KEY; `INSERT OR
//    IGNORE` is a single atomic statement, so at most one concurrent insert
//    for a given webhook_id ever reports `duplicate: false`. With
//    `journal_mode=WAL` and `synchronous=FULL`, a committed insert is
//    fsynced before the call returns — "accepted" means durably on disk.
//    There is no window where a row can exist half-written: SQLite commits
//    are atomic, so the corrupt-partial-file failure mode above cannot occur.
//  - Registration creation is the same `INSERT OR IGNORE` primitive: a paid
//    creation ID and its receipt artifact are written at most once per
//    resource_id; a losing concurrent caller reads back the winner's row.
//  - Per-entry processing claims use `BEGIN IMMEDIATE`, which takes a real
//    write lock enforced by SQLite across connections and processes for the
//    whole transaction. There is no "vacate then recreate" step and thus no
//    window where the claim slot is briefly absent, so a genuinely
//    concurrent claimEntry() call cannot succeed while another call's
//    transaction (which decides whether to steal a dead owner's claim and
//    commits the new owner in the same transaction) is in flight.
//  - What this does NOT prove: exactly-once *processing* (fetch + notify)
//    across crash windows. A crash between "fetch succeeded" and "record
//    handled" can cause a rare duplicate fetch/notify on restart. This is
//    accepted because fetch and notify are idempotent, non-monetary,
//    read-only operations. What IS exactly-once, and proven above, is the
//    paid creation ID: `registrations.creation_artifact` is set once, at
//    insert time, and is never overwritten by a retried registration call.
//
// Resource-kind idempotency differs by kind: Task and FindAll runs are
// one-shot (a single terminal event), so `status` gates repeat fetches as a
// cheap optimization. Monitors are recurring: the same monitor_id legitimately
// produces many independent `event_group_id` detections over its lifetime, so
// monitor registrations never carry a fetch-blocking terminal `status`; the
// per-webhook-id dedup gate above is what prevents duplicate fetch of the
// *same* detected event, while a second, distinct detected event is a
// distinct webhook_id and is processed independently (see
// tests/webhook-inbox.test.ts for a direct regression fixture).

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import type { ConversationRecord, ResearchEffort, OutboundInput, ResearchRecord, ResearchStatus, SearchActivity, SessionGroup } from "./research-types.ts";

export type ResourceKind = "task" | "findall" | "monitor" | "agent-bus";

export type Registration = {
  resource_id: string;
  kind: ResourceKind;
  session_id: string;
  webhook_url?: string;
  registered_at: number;
  updated_at: number;
  /** task/findall: pending -> done|failed|orphaned once. monitor: always "pending" (= actively watched). */
  status: "pending" | "done" | "failed" | "orphaned";
  /** Receipt artifact from the paid creation call. Set once at registration; never recreated by a retry. */
  creation_artifact?: string;
  /** Most recent ordinary result artifact from a one-shot post-completion fetch. */
  result_artifact?: string;
  error?: string;
  /** Whether the owning session has been notified of the latest terminal/detected state. */
  delivered: boolean;
  /** Owner namespace for result artifacts. Null on legacy registrations. */
  artifact_dir?: string;
  cwd?: string;
};

export type InboxEntry = {
  webhook_id: string;
  received_at: number;
  event: unknown;
  resource_id?: string;
  kind?: ResourceKind;
  event_type?: string;
  handled: boolean;
  handled_at?: number;
  result_artifact?: string;
  error?: string;
  /** Failure/cancellation notifications: recorded, no success fetch performed. */
  terminal_failure?: boolean;
  /** One-shot result/event-group GET failed. Stays unhandled until an explicit
   *  `recover({retryFailed:true})`; watchers and default recover() must not retry it. */
  fetch_failed?: boolean;
  /** Set once the owning session has been sent a notification for this specific entry.
   *  Per-entry (not per-resource): a monitor's Nth distinct detected event is its own
   *  entry with its own notified state, so it is never suppressed by an earlier
   *  detection's delivery on the same monitor_id. See docs/webhook-integration.md. */
  notified?: boolean;
};

type EventRow = {
  webhook_id: string;
  received_at: number;
  event_json: string;
  resource_id: string | null;
  kind: string | null;
  event_type: string | null;
  handled: number;
  handled_at: number | null;
  result_artifact: string | null;
  error: string | null;
  terminal_failure: number;
  claimed_by: number | null;
  claimed_at: number | null;
  notified: number;
  fetch_failed: number;
};

type RegistrationRow = {
  resource_id: string;
  kind: string;
  session_id: string;
  webhook_url: string | null;
  registered_at: number;
  updated_at: number;
  status: string;
  creation_artifact: string | null;
  result_artifact: string | null;
  error: string | null;
  delivered: number;
  artifact_dir: string | null;
  cwd: string | null;
};

type SessionGroupRow = {
  session_id: string;
  group_id: string | null;
  status: string;
  owner_pid: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  event_cursor: string | null;
};

type ResearchRow = {
  reference: string;
  session_id: string;
  group_id: string;
  run_id: string | null;
  interaction_id: string | null;
  parent: string | null;
  query: string;
  effort: string;
  domains_json: string | null;
  status: string;
  artifact_dir: string;
  cwd: string | null;
  artifact: string | null;
  creation_artifact: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

type SearchActivityRow = {
  reference: string;
  session_id: string;
  kind: string;
  query: string | null;
  provider_ids_json: string | null;
  status: string;
  artifact: string | null;
  created_at: number;
};

type ConversationRow = {
  reference: string;
  session_id: string;
  response_id: string | null;
  parent: string | null;
  status: string;
  artifact: string | null;
  error: string | null;
  created_at: number;
};

export const DONE_RETENTION_MS = 72 * 60 * 60 * 1000; // 48h Parallel retry horizon + margin
const ORPHAN_GRACE_MS = 30 * 60 * 1000; // retained for compatibility; unmatched callbacks are not expired

function rowToEntry(row: EventRow): InboxEntry {
  return {
    webhook_id: row.webhook_id,
    received_at: row.received_at,
    event: JSON.parse(row.event_json),
    resource_id: row.resource_id ?? undefined,
    kind: (row.kind as ResourceKind | null) ?? undefined,
    event_type: row.event_type ?? undefined,
    handled: !!row.handled,
    handled_at: row.handled_at ?? undefined,
    result_artifact: row.result_artifact ?? undefined,
    error: row.error ?? undefined,
    terminal_failure: !!row.terminal_failure,
    fetch_failed: !!row.fetch_failed,
    notified: !!row.notified,
  };
}

function rowToRegistration(row: RegistrationRow): Registration {
  return {
    resource_id: row.resource_id,
    kind: row.kind as ResourceKind,
    session_id: row.session_id,
    webhook_url: row.webhook_url ?? undefined,
    registered_at: row.registered_at,
    updated_at: row.updated_at,
    status: row.status as Registration["status"],
    creation_artifact: row.creation_artifact ?? undefined,
    result_artifact: row.result_artifact ?? undefined,
    error: row.error ?? undefined,
    delivered: !!row.delivered,
    artifact_dir: row.artifact_dir ?? undefined,
    cwd: row.cwd ?? undefined,
  };
}

const RESEARCH_STATUSES = new Set<ResearchStatus>(["dispatching", "pending", "completed", "failed", "cancelled", "action_required", "uncertain"]);
const EFFORTS = new Set<ResearchEffort>(["low", "medium", "high", "custom"]);
const CONVERSATION_STATUSES = new Set<ConversationRecord["status"]>(["completed", "partial", "uncertain"]);
const FROZEN_RESEARCH = new Set<ResearchStatus>(["completed", "failed", "cancelled"]);
const IMMUTABLE_RESEARCH = ["reference", "session_id", "group_id", "query", "effort", "domains", "artifact_dir", "cwd", "created_at", "run_id", "parent"] as const;
const ACTIVITY_KINDS = new Set<SearchActivity["kind"]>(["search", "extract", "entity"]);
const ACTIVITY_STATUSES = new Set<SearchActivity["status"]>(["completed", "partial", "failed", "uncertain"]);
const PROVIDER_ID_KEYS = new Set(["session_id", "search_id", "extract_id", "entity_set_id"]);
const MAX_ACTIVITY_QUERY = 500;
const MAX_PROVIDER_ID = 1000;

function recordOf(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/** Reported task-run status of a stored event (signed callback or outbound synthetic). */
export function reportedRunStatus(event: unknown): string | undefined {
  const data = recordOf(recordOf(event).data);
  const run = recordOf(data.run);
  const pick = (v: unknown) => typeof v === "string" && v ? v : undefined;
  return pick(data.status) ?? pick(run.status);
}

export function isTerminalResearch(status: string): boolean {
  return FROZEN_RESEARCH.has(status as ResearchStatus);
}

function rowToSessionGroup(row: SessionGroupRow): SessionGroup {
  return {
    session_id: row.session_id,
    group_id: row.group_id ?? undefined,
    status: row.status as SessionGroup["status"],
    owner_pid: row.owner_pid,
    error: row.error ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    event_cursor: row.event_cursor ?? undefined,
  };
}

function decodeDomains(raw: string | null): string[] | undefined {
  if (raw == null) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string")) throw new Error("research domains are corrupt");
  return parsed;
}

function rowToResearch(row: ResearchRow): ResearchRecord {
  return {
    reference: row.reference,
    session_id: row.session_id,
    group_id: row.group_id,
    run_id: row.run_id ?? undefined,
    interaction_id: row.interaction_id ?? undefined,
    parent: row.parent ?? undefined,
    query: row.query,
    effort: row.effort as ResearchEffort,
    domains: decodeDomains(row.domains_json),
    status: row.status as ResearchStatus,
    artifact_dir: row.artifact_dir,
    cwd: row.cwd ?? undefined,
    artifact: row.artifact ?? undefined,
    creation_artifact: row.creation_artifact ?? undefined,
    error: row.error ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToConversation(row: ConversationRow): ConversationRecord {
  return {
    reference: row.reference,
    session_id: row.session_id,
    response_id: row.response_id ?? undefined,
    parent: row.parent ?? undefined,
    status: row.status as ConversationRecord["status"],
    artifact: row.artifact ?? undefined,
    error: row.error ?? undefined,
    created_at: row.created_at,
  };
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

function requireTime(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a timestamp`);
  return value;
}

function isUniqueConstraint(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e.code === "ERR_SQLITE_CONSTRAINT_UNIQUE" || e.code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/.test(e.message ?? "");
}

function boundedId(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_PROVIDER_ID) {
    throw new Error(`${name} must be a nonblank string of at most ${MAX_PROVIDER_ID} characters`);
  }
  return value;
}

function encodeProviderIds(ids: SearchActivity["provider_ids"]): string | null {
  if (ids === undefined) return null;
  if (!ids || typeof ids !== "object" || Array.isArray(ids)) throw new Error("provider_ids must be an object");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(ids)) {
    if (!PROVIDER_ID_KEYS.has(key)) throw new Error(`provider_ids key ${key} is not allowed`);
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_PROVIDER_ID) {
      throw new Error(`provider_ids.${key} must be a string of at most ${MAX_PROVIDER_ID} characters`);
    }
    out[key] = value;
  }
  return JSON.stringify(out);
}

function decodeProviderIds(raw: string | null): SearchActivity["provider_ids"] {
  if (raw == null) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("search activity provider ids are corrupt");
  const out: NonNullable<SearchActivity["provider_ids"]> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!PROVIDER_ID_KEYS.has(key) || typeof value !== "string") throw new Error("search activity provider ids are corrupt");
    out[key as keyof NonNullable<SearchActivity["provider_ids"]>] = value;
  }
  return out;
}


function rowToActivity(row: SearchActivityRow): SearchActivity {
  return {
    reference: row.reference,
    session_id: row.session_id,
    kind: row.kind as SearchActivity["kind"],
    query: row.query ?? undefined,
    provider_ids: decodeProviderIds(row.provider_ids_json),
    status: row.status as SearchActivity["status"],
    artifact: row.artifact ?? undefined,
    created_at: row.created_at,
  };
}

function isDeadPid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false; // alive, or alive-but-not-ours (EPERM)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export class WebhookInbox {
  readonly baseDir: string;
  private db: DatabaseSync | undefined;
  private stmts!: Record<string, StatementSync>;
  // Memoized in-flight init: without this, two concurrent init() callers
  // could both observe `this.db === undefined`, both await mkdir and open a
  // DatabaseSync, and leak a second connection. Every init() call (including
  // the first) awaits the same promise, so the open body runs exactly once
  // per instance regardless of call concurrency.
  private initPromise: Promise<void> | undefined;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  private dbPath(): string {
    return join(this.baseDir, "webtasks.sqlite");
  }

  async init(): Promise<void> {
    if (this.db) return;
    if (!this.initPromise) {
      this.initPromise = this.doInit().catch(err => { this.initPromise = undefined; throw err; });
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    if (this.db) return;
    await mkdir(dirname(this.dbPath()), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.dbPath());
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL"); // durable ACK: every commit is fsynced before returning
    db.exec("PRAGMA busy_timeout = 5000"); // wait for cross-process writers instead of failing immediately
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        webhook_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        resource_id TEXT,
        kind TEXT,
        event_type TEXT,
        handled INTEGER NOT NULL DEFAULT 0,
        handled_at INTEGER,
        result_artifact TEXT,
        error TEXT,
        terminal_failure INTEGER NOT NULL DEFAULT 0,
        claimed_by INTEGER,
        claimed_at INTEGER,
        notified INTEGER NOT NULL DEFAULT 0,
        fetch_failed INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS registrations (
        resource_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        session_id TEXT NOT NULL,
        webhook_url TEXT,
        registered_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        creation_artifact TEXT,
        result_artifact TEXT,
        error TEXT,
        delivered INTEGER NOT NULL DEFAULT 0,
        artifact_dir TEXT,
        cwd TEXT
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS events_handled ON events(handled)");
    // One row per run and reported status, written only when a notification is acknowledged after
    // delivery. It is the persistent guard against a second notice for the same outcome.
    db.exec(`
      CREATE TABLE IF NOT EXISTS run_notifications (
        resource_id TEXT NOT NULL,
        status TEXT NOT NULL,
        webhook_id TEXT NOT NULL,
        notified_at INTEGER NOT NULL,
        PRIMARY KEY (resource_id, status)
      )
    `);
    const eventCols = (db.prepare("PRAGMA table_info(events)").all() as { name: string }[]).map(c => c.name);
    if (!eventCols.includes("fetch_failed")) {
      db.exec("ALTER TABLE events ADD COLUMN fetch_failed INTEGER NOT NULL DEFAULT 0");
    }
    const regCols = (db.prepare("PRAGMA table_info(registrations)").all() as { name: string }[]).map(c => c.name);
    if (!regCols.includes("artifact_dir")) db.exec("ALTER TABLE registrations ADD COLUMN artifact_dir TEXT");
    if (!regCols.includes("cwd")) db.exec("ALTER TABLE registrations ADD COLUMN cwd TEXT");
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_groups (
        session_id TEXT PRIMARY KEY,
        group_id TEXT,
        status TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    const groupCols = (db.prepare("PRAGMA table_info(session_groups)").all() as { name: string }[]).map(c => c.name);
    if (!groupCols.includes("event_cursor")) db.exec("ALTER TABLE session_groups ADD COLUMN event_cursor TEXT");
    db.exec(`
      CREATE TABLE IF NOT EXISTS research (
        reference TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        run_id TEXT,
        interaction_id TEXT,
        parent TEXT,
        query TEXT NOT NULL,
        effort TEXT NOT NULL,
        domains_json TEXT,
        status TEXT NOT NULL,
        artifact_dir TEXT NOT NULL,
        cwd TEXT,
        artifact TEXT,
        creation_artifact TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS research_run_id ON research(run_id) WHERE run_id IS NOT NULL");
    const researchCols = (db.prepare("PRAGMA table_info(research)").all() as { name: string }[]).map(c => c.name);
    if (!researchCols.includes("interaction_id")) db.exec("ALTER TABLE research ADD COLUMN interaction_id TEXT");
    if (!researchCols.includes("parent")) db.exec("ALTER TABLE research ADD COLUMN parent TEXT");
    db.exec(`
      CREATE TABLE IF NOT EXISTS search_activity (
        reference TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        query TEXT,
        provider_ids_json TEXT,
        status TEXT NOT NULL,
        artifact TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS search_activity_session ON search_activity(session_id, created_at)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        reference TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        response_id TEXT,
        parent TEXT,
        status TEXT NOT NULL,
        artifact TEXT,
        error TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.db = db;
    this.stmts = {
      insertEvent: db.prepare(
        "INSERT OR IGNORE INTO events (webhook_id, received_at, event_json, resource_id, kind, event_type, handled) VALUES (?, ?, ?, ?, ?, ?, 0)",
      ),
      getEvent: db.prepare("SELECT * FROM events WHERE webhook_id = ?"),
      listPending: db.prepare("SELECT * FROM events WHERE handled = 0 ORDER BY received_at ASC"),
      listAll: db.prepare("SELECT * FROM events ORDER BY received_at ASC"),
      claimEvent: db.prepare("UPDATE events SET claimed_by = ?, claimed_at = ? WHERE webhook_id = ?"),
      // Owner-checked: never clears a claim that was reclaimed by someone else
      // after this caller's own claim (for example after a stale-claim sweep
      // decided this caller's process looked dead and reassigned it).
      releaseEventOwned: db.prepare("UPDATE events SET claimed_by = NULL, claimed_at = NULL WHERE webhook_id = ? AND claimed_by = ?"),
      clearClaimOwned: db.prepare("UPDATE events SET claimed_by = NULL, claimed_at = NULL WHERE webhook_id = ? AND claimed_by = ?"),
      // resource_id/kind/event_type are COALESCE-preserved so a consumer's
      // normalization result (derived from parsing entry.event, since the
      // shared receiver stores only {webhook_id, event} without routing
      // fields) is persisted once and reused by later notify passes instead
      // of re-parsing the event JSON on every watch tick.
      markHandled: db.prepare(
        "UPDATE events SET handled = 1, handled_at = ?, result_artifact = COALESCE(?, result_artifact), error = COALESCE(?, error), terminal_failure = ?, resource_id = COALESCE(?, resource_id), kind = COALESCE(?, kind), event_type = COALESCE(?, event_type), fetch_failed = 0 WHERE webhook_id = ?",
      ),
      recordFetchFailure: db.prepare(
        "UPDATE events SET fetch_failed = 1, error = ? WHERE webhook_id = ? AND handled = 0",
      ),
      markNotified: db.prepare("UPDATE events SET notified = 1 WHERE webhook_id = ?"),
      listHandledUnnotified: db.prepare("SELECT * FROM events WHERE handled = 1 AND notified = 0 ORDER BY handled_at ASC"),
      pruneHandled: db.prepare("DELETE FROM events WHERE handled = 1 AND notified = 1 AND handled_at < ?"),
      staleClaims: db.prepare("SELECT webhook_id, claimed_by FROM events WHERE claimed_by IS NOT NULL AND handled = 0"),

      insertRegistration: db.prepare(
        "INSERT OR IGNORE INTO registrations (resource_id, kind, session_id, webhook_url, registered_at, updated_at, status, creation_artifact, delivered) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0)",
      ),
      getRegistration: db.prepare("SELECT * FROM registrations WHERE resource_id = ?"),
      listRegistrations: db.prepare("SELECT * FROM registrations ORDER BY registered_at ASC"),
      getSessionGroup: db.prepare("SELECT * FROM session_groups WHERE session_id = ?"),
      insertSessionGroup: db.prepare(
        "INSERT OR IGNORE INTO session_groups (session_id, group_id, status, owner_pid, error, created_at, updated_at) VALUES (?, NULL, 'initializing', ?, NULL, ?, ?)",
      ),
      getResearch: db.prepare("SELECT * FROM research WHERE reference = ?"),
      getResearchByRun: db.prepare("SELECT * FROM research WHERE run_id = ?"),
      listResearchForSession: db.prepare("SELECT * FROM research WHERE session_id = ? ORDER BY created_at ASC"),
      insertResearch: db.prepare(
        "INSERT INTO research (reference, session_id, group_id, run_id, interaction_id, parent, query, effort, domains_json, status, artifact_dir, cwd, artifact, creation_artifact, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      insertActivity: db.prepare(
        "INSERT INTO search_activity (reference, session_id, kind, query, provider_ids_json, status, artifact, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      listActivity: db.prepare("SELECT * FROM search_activity WHERE session_id = ? ORDER BY created_at ASC, reference ASC"),
      getConversation: db.prepare("SELECT * FROM conversations WHERE reference = ?"),
      insertConversation: db.prepare(
        "INSERT INTO conversations (reference, session_id, response_id, parent, status, artifact, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ),
    };
  }

  private tx<T>(fn: () => T): T {
    const db = this.db!;
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* transaction may already be gone */
      }
      throw err;
    }
  }

  // --- Registration (session/resource ownership) ---

  /**
   * Insert-or-read: a losing concurrent caller reads back the winner's
   * record unmodified, as long as it agrees on kind and session_id (the same
   * tool call retried after a transient failure, reusing the same run_id).
   * A resource_id registered under a genuinely different kind or session is
   * rejected rather than silently accepted under new ownership \u2014 that would
   * misattribute delivery/notification for a resource this call did not
   * create.
   */
  async register(input: {
    resource_id: string;
    kind: ResourceKind;
    session_id: string;
    webhook_url?: string;
    creation_artifact?: string;
    artifact_dir?: string;
    cwd?: string;
  }): Promise<Registration> {
    await this.init();
    const now = Date.now();
    this.stmts.insertRegistration!.run(
      input.resource_id, input.kind, input.session_id, input.webhook_url ?? null, now, now, input.creation_artifact ?? null,
    );
    const row = this.stmts.getRegistration!.get(input.resource_id) as RegistrationRow | undefined;
    if (!row) throw new Error(`registration for ${input.resource_id} vanished after insert`);
    const existing = rowToRegistration(row);
    if (existing.kind !== input.kind || existing.session_id !== input.session_id) {
      throw new Error(
        `resource ${input.resource_id} is already registered as ${existing.kind}/${existing.session_id}; refusing to register it as ${input.kind}/${input.session_id}`,
      );
    }
    if ((input.artifact_dir && !existing.artifact_dir) || (input.cwd && !existing.cwd)) {
      this.db!.prepare(
        "UPDATE registrations SET artifact_dir = COALESCE(artifact_dir, ?), cwd = COALESCE(cwd, ?) WHERE resource_id = ?",
      ).run(input.artifact_dir ?? null, input.cwd ?? null, input.resource_id);
      existing.artifact_dir ??= input.artifact_dir;
      existing.cwd ??= input.cwd;
    }
    return existing;
  }

  async getRegistration(resource_id: string): Promise<Registration | undefined> {
    await this.init();
    const row = this.stmts.getRegistration!.get(resource_id) as RegistrationRow | undefined;
    return row ? rowToRegistration(row) : undefined;
  }

  async listRegistrations(): Promise<Registration[]> {
    await this.init();
    return (this.stmts.listRegistrations!.all() as RegistrationRow[]).map(rowToRegistration);
  }

  /**
   * task/findall only: true if this resource already reached a terminal
   * status, so a repeat fetch attempt should be skipped as a cheap
   * optimization. Monitors always return false (recurring; see module docs).
   */
  async isTerminal(resource_id: string): Promise<boolean> {
    const reg = await this.getRegistration(resource_id);
    return !!reg && reg.kind !== "monitor" && reg.status !== "pending";
  }

  async updateRegistration(resource_id: string, patch: Partial<Registration>): Promise<void> {
    await this.init();
    this.tx(() => {
      const row = this.stmts.getRegistration!.get(resource_id) as RegistrationRow | undefined;
      if (!row) return;
      const next = { ...rowToRegistration(row), ...patch, updated_at: Date.now() };
      this.db!.prepare(
        "UPDATE registrations SET status = ?, creation_artifact = ?, result_artifact = ?, error = ?, delivered = ?, updated_at = ?, webhook_url = COALESCE(?, webhook_url) WHERE resource_id = ?",
      ).run(next.status, next.creation_artifact ?? null, next.result_artifact ?? null, next.error ?? null, next.delivered ? 1 : 0, next.updated_at, next.webhook_url ?? null, resource_id);
    });
  }

  // --- Durable authenticated inbox + dedup ---

  /** Accepts an already-verified event. Durable and deduped before returning. */
  async put(entry: {
    webhook_id: string;
    event: unknown;
    resource_id?: string;
    kind?: ResourceKind;
    event_type?: string;
  }): Promise<{ accepted: boolean; duplicate: boolean }> {
    await this.init();
    const result = this.stmts.insertEvent!.run(
      entry.webhook_id, Date.now(), JSON.stringify(entry.event),
      entry.resource_id ?? null, entry.kind ?? null, entry.event_type ?? null,
    );
    return { accepted: true, duplicate: Number(result.changes) === 0 };
  }

  async listPending(): Promise<InboxEntry[]> {
    await this.init();
    return (this.stmts.listPending!.all() as EventRow[]).map(rowToEntry);
  }

  async listAll(): Promise<InboxEntry[]> {
    await this.init();
    return (this.stmts.listAll!.all() as EventRow[]).map(rowToEntry);
  }

  /**
   * `BEGIN IMMEDIATE` claims a real cross-process write lock for the whole
   * check-and-set: reading the current claim, deciding whether to steal a
   * dead owner's claim, and committing the new owner all happen inside one
   * transaction. No other connection's claimEntry() transaction for the same
   * database can interleave with it, so there is no window where the claim
   * slot is vacant and stealable by an unrelated caller.
   */
  async claimEntry(webhook_id: string): Promise<{ entry: InboxEntry; release: () => Promise<void> } | undefined> {
    await this.init();
    const claimed = this.tx(() => {
      const row = this.stmts.getEvent!.get(webhook_id) as EventRow | undefined;
      if (!row || row.handled) return undefined;
      if (row.claimed_by != null && !isDeadPid(row.claimed_by)) return undefined; // live owner: not claimable
      this.stmts.claimEvent!.run(process.pid, Date.now(), webhook_id);
      return row;
    });
    if (!claimed) return undefined;
    const owner = process.pid;
    return {
      entry: rowToEntry(claimed),
      release: async () => {
        await this.init();
        this.stmts.releaseEventOwned!.run(webhook_id, owner);
      },
    };
  }

  async markHandled(webhook_id: string, patch: Partial<InboxEntry>): Promise<void> {
    await this.init();
    this.stmts.markHandled!.run(
      Date.now(), patch.result_artifact ?? null, patch.error ?? null, patch.terminal_failure ? 1 : 0,
      patch.resource_id ?? null, patch.kind ?? null, patch.event_type ?? null, webhook_id,
    );
  }

  /** Persist a failed one-shot GET without marking the entry handled. */
  async recordFetchFailure(webhook_id: string, error: string): Promise<void> {
    await this.init();
    this.stmts.recordFetchFailure!.run(error, webhook_id);
  }

  /** Per-entry notify tracking, independent of `handled`/fetch state. See InboxEntry.notified. */
  async markNotified(webhook_id: string): Promise<void> {
    await this.init();
    this.stmts.markNotified!.run(webhook_id);
  }

  /**
   * Acknowledges a notification that was actually delivered to the owning session. For a task entry this
   * also records (run, reported status) so later entries with the same outcome are not announced again.
   */
  async acknowledgeDelivery(webhook_id: string): Promise<void> {
    await this.init();
    this.tx(() => {
      const row = this.stmts.getEvent!.get(webhook_id) as EventRow | undefined;
      this.stmts.markNotified!.run(webhook_id);
      if (!row || row.kind !== "task" || !row.resource_id) return;
      const status = reportedRunStatus(JSON.parse(row.event_json));
      if (!status) return;
      this.db!.prepare("INSERT OR IGNORE INTO run_notifications (resource_id, status, webhook_id, notified_at) VALUES (?, ?, ?, ?)")
        .run(row.resource_id, status, webhook_id, Date.now());
    });
  }

  /** True once a notification for this run and reported status has been acknowledged. */
  async isRunStatusNotified(resource_id: string, status: string): Promise<boolean> {
    await this.init();
    return !!this.db!.prepare("SELECT 1 FROM run_notifications WHERE resource_id = ? AND status = ?").get(resource_id, status);
  }

  /** Fetched/recorded entries awaiting delivery to their owning session. */
  async listHandledUnnotified(): Promise<InboxEntry[]> {
    await this.init();
    return (this.stmts.listHandledUnnotified!.all() as EventRow[]).map(rowToEntry);
  }

  /** Compatibility helper. Unmatched callbacks are retained, not finalized from this clock. */
  isOrphanExpired(entry: InboxEntry, now = Date.now()): boolean {
    return now - entry.received_at > ORPHAN_GRACE_MS;
  }

  /**
   * Removes acknowledged handled events older than the retention window and
   * clears claims held by dead processes. Unacknowledged notifications and
   * unmatched callbacks are never deleted. The sweep is one transaction so
   * claim reclaim cannot interleave with a stale clear.
   */
  async prune(maxAgeMs = DONE_RETENTION_MS): Promise<number> {
    await this.init();
    const cutoff = Date.now() - maxAgeMs;
    return this.tx(() => {
      const result = this.stmts.pruneHandled!.run(cutoff);
      for (const row of this.stmts.staleClaims!.all() as { webhook_id: string; claimed_by: number }[]) {
        if (isDeadPid(row.claimed_by)) this.stmts.clearClaimOwned!.run(row.webhook_id, row.claimed_by);
      }
      return Number(result.changes);
    });
  }

  // --- Session groups, research, and conversations ---
  // A group row exists only after the first deep submission calls beginSessionGroup.
  // getSessionGroup is lookup-only and never inserts.

  async getSessionGroup(sessionId: string): Promise<SessionGroup | undefined> {
    await this.init();
    const row = this.stmts.getSessionGroup!.get(sessionId) as SessionGroupRow | undefined;
    return row ? rowToSessionGroup(row) : undefined;
  }

  /** Atomic insert. An existing initializing, uncertain, or ready row is returned unchanged. */
  async beginSessionGroup(sessionId: string): Promise<{ created: boolean; record: SessionGroup }> {
    await this.init();
    requireText(sessionId, "session id");
    return this.tx(() => {
      const now = Date.now();
      const result = this.stmts.insertSessionGroup!.run(sessionId, process.pid, now, now);
      const row = this.stmts.getSessionGroup!.get(sessionId) as SessionGroupRow | undefined;
      if (!row) throw new Error(`session group for ${sessionId} vanished after insert`);
      return { created: Number(result.changes) === 1, record: rowToSessionGroup(row) };
    });
  }

  async completeSessionGroup(sessionId: string, groupId: string): Promise<void> {
    await this.init();
    requireText(sessionId, "session id");
    requireText(groupId, "group id");
    this.tx(() => {
      const row = this.stmts.getSessionGroup!.get(sessionId) as SessionGroupRow | undefined;
      if (!row) throw new Error(`session group for ${sessionId} not found`);
      if (row.group_id && row.group_id !== groupId) {
        throw new Error(`session ${sessionId} is already bound to ${row.group_id}; refusing ${groupId}`);
      }
      if (row.status === "ready" && row.group_id === groupId) return;
      this.db!.prepare(
        "UPDATE session_groups SET group_id = ?, status = 'ready', error = NULL, updated_at = ? WHERE session_id = ?",
      ).run(groupId, Date.now(), sessionId);
    });
  }

  /** Marks the existing row uncertain. Does not insert a replacement group. */
  async failSessionGroup(sessionId: string, error: string): Promise<void> {
    await this.init();
    requireText(sessionId, "session id");
    this.tx(() => {
      const row = this.stmts.getSessionGroup!.get(sessionId) as SessionGroupRow | undefined;
      if (!row) throw new Error(`session group for ${sessionId} not found`);
      const message = (error || "research setup failed").slice(0, 2000);
      this.db!.prepare(
        "UPDATE session_groups SET status = 'uncertain', error = ?, updated_at = ? WHERE session_id = ?",
      ).run(message, Date.now(), sessionId);
    });
  }

  async createResearch(record: ResearchRecord): Promise<void> {
    await this.init();
    const reference = requireText(record.reference, "reference");
    const session_id = requireText(record.session_id, "session_id");
    const group_id = requireText(record.group_id, "group_id");
    const query = requireText(record.query, "query");
    if (!EFFORTS.has(record.effort)) throw new Error(`invalid effort ${record.effort}`);
    if (!RESEARCH_STATUSES.has(record.status)) throw new Error(`invalid research status ${record.status}`);
    const artifact_dir = requireText(record.artifact_dir, "artifact_dir");
    const created_at = requireTime(record.created_at, "created_at");
    const updated_at = requireTime(record.updated_at, "updated_at");
    if (record.domains !== undefined && (!Array.isArray(record.domains) || record.domains.some(d => typeof d !== "string"))) {
      throw new Error("domains must be strings");
    }
    try {
      this.stmts.insertResearch!.run(
        reference, session_id, group_id, record.run_id ?? null, boundedId(record.interaction_id, "interaction_id") ?? null,
        boundedId(record.parent, "parent") ?? null, query, record.effort,
        record.domains === undefined ? null : JSON.stringify(record.domains),
        record.status, artifact_dir, record.cwd ?? null, record.artifact ?? null,
        record.creation_artifact ?? null, record.error ?? null, created_at, updated_at,
      );
    } catch (err) {
      if (isUniqueConstraint(err)) throw new Error(`research ${reference} already exists`);
      throw err;
    }
  }

  async getResearch(reference: string): Promise<ResearchRecord | undefined> {
    await this.init();
    const row = this.stmts.getResearch!.get(reference) as ResearchRow | undefined;
    return row ? rowToResearch(row) : undefined;
  }

  /** All research records of one session, oldest first. Lookup only. */
  async listResearchForSession(sessionId: string): Promise<ResearchRecord[]> {
    await this.init();
    return (this.stmts.listResearchForSession!.all(sessionId) as ResearchRow[]).map(rowToResearch);
  }

  /**
   * Durably records synthetic outbound entries and, in the same transaction, optionally advances
   * the session's event-stream cursor. The cursor therefore never moves past an event whose effect
   * is not on disk. Duplicate entry IDs are ignored; returns how many entries were newly inserted.
   */
  async recordOutbound(input: OutboundInput): Promise<number> {
    await this.init();
    requireText(input.session_id, "session id");
    return this.tx(() => {
      let inserted = 0;
      for (const entry of input.events ?? []) {
        const result = this.stmts.insertEvent!.run(
          entry.webhook_id, Date.now(), JSON.stringify(entry.event), entry.resource_id, "task", entry.event_type,
        );
        inserted += Number(result.changes);
      }
      if (input.cursor !== undefined) {
        requireText(input.cursor, "cursor");
        this.db!.prepare("UPDATE session_groups SET event_cursor = ? WHERE session_id = ?").run(input.cursor, input.session_id);
      }
      return inserted;
    });
  }

  /**
   * Adopts an addRuns event cursor for a group's first tracked run only, and only while no cursor is
   * stored. An existing cursor is never moved, so older pending runs cannot be skipped.
   */
  async adoptEventCursor(reference: string, cursor: string): Promise<boolean> {
    await this.init();
    if (!cursor) return false;
    return this.tx(() => {
      const row = this.stmts.getResearch!.get(reference) as ResearchRow | undefined;
      if (!row) return false;
      const group = this.stmts.getSessionGroup!.get(row.session_id) as SessionGroupRow | undefined;
      if (!group || group.group_id !== row.group_id || group.event_cursor != null) return false;
      const others = this.db!.prepare(
        "SELECT COUNT(*) AS n FROM research WHERE session_id = ? AND group_id = ? AND run_id IS NOT NULL AND reference != ?",
      ).get(row.session_id, row.group_id, reference) as { n: number };
      if (others.n > 0) return false;
      this.db!.prepare("UPDATE session_groups SET event_cursor = ? WHERE session_id = ?").run(cursor, row.session_id);
      return true;
    });
  }

  async researchForRun(runId: string): Promise<ResearchRecord | undefined> {
    await this.init();
    if (!runId) return undefined;
    const row = this.stmts.getResearchByRun!.get(runId) as ResearchRow | undefined;
    return row ? rowToResearch(row) : undefined;
  }

  /**
   * Applies status, artifact, creation_artifact, error, updated_at, and a first
   * or identical interaction_id. Parent, identity, query, group, and run id cannot
   * be reassigned. Frozen terminal statuses are not downgraded.
   */
  async updateResearch(reference: string, patch: Partial<ResearchRecord>): Promise<void> {
    await this.init();
    this.tx(() => {
      const row = this.stmts.getResearch!.get(reference) as ResearchRow | undefined;
      if (!row) throw new Error(`research ${reference} not found`);
      const current = rowToResearch(row);
      for (const key of IMMUTABLE_RESEARCH) {
        if (!Object.hasOwn(patch, key) || patch[key] === undefined) continue;
        if (key === "run_id") {
          if (patch.run_id !== current.run_id) throw new Error(`research ${reference} run id is bound only by acceptResearch`);
          continue;
        }
        if (JSON.stringify(patch[key]) !== JSON.stringify(current[key])) {
          throw new Error(`research ${reference} field ${key} cannot be reassigned`);
        }
      }
      let interaction = current.interaction_id;
      if (patch.interaction_id !== undefined) {
        const learned = boundedId(patch.interaction_id, "interaction_id");
        if (current.interaction_id && learned !== current.interaction_id) {
          throw new Error(`research ${reference} interaction id cannot be reassigned`);
        }
        interaction = current.interaction_id ?? learned;
      }
      let status = current.status;
      if (patch.status !== undefined) {
        if (!RESEARCH_STATUSES.has(patch.status)) throw new Error(`invalid research status ${patch.status}`);
        if (isTerminalResearch(current.status) && patch.status !== current.status) {
          throw new Error(`research ${reference} is ${current.status}; refusing to change it to ${patch.status}`);
        }
        status = patch.status;
      }
      const artifact = patch.artifact !== undefined ? patch.artifact : current.artifact;
      const creation = patch.creation_artifact !== undefined ? (current.creation_artifact ?? patch.creation_artifact) : current.creation_artifact;
      const error = patch.error !== undefined ? patch.error : current.error;
      const updated = typeof patch.updated_at === "number" && Number.isFinite(patch.updated_at) ? patch.updated_at : Date.now();
      this.db!.prepare(
        "UPDATE research SET status = ?, artifact = ?, creation_artifact = ?, error = ?, interaction_id = ?, updated_at = ? WHERE reference = ?",
      ).run(status, artifact ?? null, creation ?? null, error ?? null, interaction ?? null, updated, reference);
    });
  }

  /**
   * Binds a run id and registers the task owner in one transaction. Same identity
   * is idempotent and does not downgrade a terminal callback-before-response state.
   * A different run id or a registration owned by another session is rejected.
   */
  async acceptResearch(reference: string, runId: string, creationArtifact?: string): Promise<void> {
    await this.init();
    requireText(reference, "reference");
    requireText(runId, "run id");
    this.tx(() => {
      const row = this.stmts.getResearch!.get(reference) as ResearchRow | undefined;
      if (!row) throw new Error(`research ${reference} not found`);
      const current = rowToResearch(row);
      if (current.run_id && current.run_id !== runId) {
        throw new Error(`research ${reference} is already bound to ${current.run_id}; refusing ${runId}`);
      }
      const taken = this.stmts.getResearchByRun!.get(runId) as ResearchRow | undefined;
      if (taken && taken.reference !== reference) throw new Error(`run ${runId} is already bound to ${taken.reference}`);
      const now = Date.now();
      const frozen = isTerminalResearch(current.status);
      this.db!.prepare(
        "UPDATE research SET run_id = ?, status = ?, error = ?, creation_artifact = COALESCE(creation_artifact, ?), updated_at = ? WHERE reference = ?",
      ).run(runId, frozen ? current.status : "pending", frozen ? (current.error ?? null) : null, creationArtifact ?? null, now, reference);
      this.db!.prepare(
        "INSERT OR IGNORE INTO registrations (resource_id, kind, session_id, webhook_url, registered_at, updated_at, status, creation_artifact, delivered, artifact_dir, cwd) VALUES (?, 'task', ?, NULL, ?, ?, 'pending', ?, 0, ?, ?)",
      ).run(runId, current.session_id, now, now, creationArtifact ?? current.creation_artifact ?? null, current.artifact_dir, current.cwd ?? null);
      const reg = this.stmts.getRegistration!.get(runId) as RegistrationRow | undefined;
      if (!reg) throw new Error(`registration for ${runId} vanished after insert`);
      if (reg.kind !== "task" || reg.session_id !== current.session_id) {
        throw new Error(`resource ${runId} is already registered as ${reg.kind}/${reg.session_id}; refusing to register it as task/${current.session_id}`);
      }
      this.db!.prepare(
        "UPDATE registrations SET artifact_dir = COALESCE(artifact_dir, ?), cwd = COALESCE(cwd, ?), creation_artifact = COALESCE(creation_artifact, ?), updated_at = ? WHERE resource_id = ?",
      ).run(current.artifact_dir, current.cwd ?? null, creationArtifact ?? current.creation_artifact ?? null, now, runId);
    });
  }

  async saveConversation(record: ConversationRecord): Promise<void> {
    await this.init();
    const reference = requireText(record.reference, "reference");
    const session_id = requireText(record.session_id, "session_id");
    if (!CONVERSATION_STATUSES.has(record.status)) throw new Error(`invalid conversation status ${record.status}`);
    const created_at = requireTime(record.created_at, "created_at");
    try {
      this.stmts.insertConversation!.run(
        reference, session_id, record.response_id ?? null, record.parent ?? null, record.status,
        record.artifact ?? null, record.error ?? null, created_at,
      );
    } catch (err) {
      if (isUniqueConstraint(err)) throw new Error(`conversation ${reference} already exists`);
      throw err;
    }
  }

  async getConversation(reference: string): Promise<ConversationRecord | undefined> {
    await this.init();
    const row = this.stmts.getConversation!.get(reference) as ConversationRow | undefined;
    return row ? rowToConversation(row) : undefined;
  }

  async saveSearchActivity(record: SearchActivity): Promise<void> {
    await this.init();
    const reference = requireText(record.reference, "reference");
    const session_id = requireText(record.session_id, "session_id");
    if (!ACTIVITY_KINDS.has(record.kind)) throw new Error(`invalid search activity kind ${record.kind}`);
    if (!ACTIVITY_STATUSES.has(record.status)) throw new Error(`invalid search activity status ${record.status}`);
    if (record.query !== undefined && (typeof record.query !== "string" || record.query.length > MAX_ACTIVITY_QUERY)) {
      throw new Error(`query summary must be at most ${MAX_ACTIVITY_QUERY} characters`);
    }
    const created_at = requireTime(record.created_at, "created_at");
    try {
      this.stmts.insertActivity!.run(
        reference, session_id, record.kind, record.query ?? null, encodeProviderIds(record.provider_ids),
        record.status, record.artifact ?? null, created_at,
      );
    } catch (err) {
      if (isUniqueConstraint(err)) throw new Error(`search activity ${reference} already exists`);
      throw err;
    }
  }

  async activitiesForSession(sessionId: string): Promise<SearchActivity[]> {
    await this.init();
    return (this.stmts.listActivity!.all(sessionId) as SearchActivityRow[]).map(rowToActivity);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }
}
