/**
 * Session-bound research store.
 *
 * Owns the durable evidence the extension receives from Parallel: submission
 * intent, provider identities, observations, result payloads, searchable
 * evidence, citation links, and pending alerts.
 *
 * Invariants this module is responsible for:
 *
 *  - Session ownership is an authorization rule, not a tag. Every read and
 *    write takes the caller's Pi session id and rows are filtered by it. A
 *    handle owned by another session behaves exactly like a missing handle, so
 *    cross-session probing learns nothing.
 *  - A paid submission is recorded before the network call (`beginRun`), keyed
 *    by the Pi tool invocation. A replay of the same invocation returns the
 *    existing run instead of submitting again. Different invocations remain
 *    separate investigations even when their text is identical.
 *  - Completion is one transaction: provider payload, evidence projections,
 *    citation links, run state, and the pending completion alert commit
 *    together or not at all. A failure leaves the run exactly as it was, so a
 *    storage or indexing failure can never look like a completed result.
 *  - Provider status, local evidence availability, and alert delivery are
 *    three separate facts (`runs.state`, `evidence` rows, `alerts.state`).
 *  - Alerts are persisted before delivery. Claiming an alert is not proof of
 *    delivery, and acknowledging one is not proof that a crash cannot replay
 *    it: the delivery path is at-least-once, never claimed to be exactly-once.
 *  - Search results are bounded and stable across pages. A page pins a snapshot
 *    of the highest evidence id, so evidence arriving mid-pagination cannot
 *    shift or repeat rows. A cursor also carries its own filters, so it alone
 *    continues the search it came from.
 *
 * Fresh start: this store opens `<base>/research.sqlite`. It never opens,
 * migrates, or deletes the legacy `webtasks.sqlite`.
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const SCHEMA_VERSION = 2;

export type RunState =
  | "intent"
  | "submitting"
  | "accepted"
  | "pending"
  | "completed"
  | "failed"
  | "cancelled"
  | "action_required"
  | "uncertain";

/**
 * The run state vocabulary. Every list of states in this file's SQL and in its
 * callers is one of these sets; nothing spells a state list inline.
 *
 *  - Terminal: settlement commits it and nothing moves a run out of it.
 *    `uncertain` is not terminal (it is reconciled), and neither is
 *    `action_required` (it is alerted once and stays watched).
 *  - Open: every other state. A Task run in an open state is reconciled at
 *    session start and counted as research in progress.
 *  - Unconfirmed: Parallel has not confirmed the run exists. Any provider fact
 *    about a bound run confirms it, which makes it `accepted`.
 *  - In flight: recorded, and possibly sent, but never answered.
 */
export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>(["completed", "failed", "cancelled"]);
export const OPEN_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>(
  ["intent", "submitting", "accepted", "pending", "action_required", "uncertain"],
);
export const UNCONFIRMED_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>(["intent", "submitting", "uncertain"]);
export const IN_FLIGHT_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>(["intent", "submitting"]);

/** A state set as an SQL list. The values are the fixed literals above, never input. */
function sqlStates(states: ReadonlySet<RunState>): string {
  return [...states].map(state => `'${state}'`).join(",");
}

/**
 * What kind of received item this is. `report` and `structured` are provider
 * outputs, `finding` is an intermediate progress result, `source` and `excerpt`
 * are source text. The untouched provider payload lives on the run, not here.
 */
export const EVIDENCE_KIND_NAMES = ["report", "structured", "finding", "source", "excerpt"] as const;
export type EvidenceKind = (typeof EVIDENCE_KIND_NAMES)[number];

/**
 * Where the text came from, so a search hit can be read correctly:
 * a provider claim is not the same thing as source text.
 */
export type EvidenceOrigin = "provider_report" | "provider_structured" | "provider_finding" | "provider_source";

export type AlertKind = "progress" | "finding" | "completion" | "failure" | "action_required";
export type AlertState = "pending" | "claimed" | "delivered" | "acknowledged";

export type StoreErrorCode = "not_found" | "conflict" | "invalid" | "closed";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export type RunKind = "task" | "search" | "extract" | "answer";

export type RunRecord = {
  reference: string;
  session_id: string;
  kind: RunKind;
  group_id?: string;
  provider_run_id?: string;
  /** Provider-side research context (Search/Extract `session_id`), distinct from the Pi session. */
  provider_session_id?: string;
  /** Provider interaction id, for continuing a Task or Responses conversation. */
  provider_interaction_id?: string;
  parent?: string;
  intent_key: string;
  state: RunState;
  processor?: string;
  intent: unknown;
  summary?: string;
  error?: string;
  created_at: number;
  updated_at: number;
  terminal_at?: number;
  /** When the provider reported the run as running; start of the progress timetable. */
  running_at?: number;
  /** Next scheduled progress update, in epoch milliseconds. */
  next_alert_at?: number;
  /** Progress interval derived from published processor latency. */
  alert_interval_ms?: number;
};

export type EvidenceInput = {
  kind: EvidenceKind;
  origin: EvidenceOrigin;
  body: string;
  /**
   * Local alias, unique within one completion batch, so citations can point at
   * evidence inserted by the same transaction before handles are known. Never
   * persisted and never exposed to another session.
   */
  ref?: string;
  title?: string;
  url?: string;
  /** Provider location of this item, e.g. `output.content` or `output.sources[4]`. */
  pointer?: string;
  /** Untouched provider object for this item, preserved verbatim. */
  payload?: unknown;
  created_at?: number;
};

export type CitationInput = {
  /** Stored evidence handle, or a batch alias from this completion's evidence. */
  evidence: string;
  /** Stored evidence handle or batch alias for the source, when it is stored locally. */
  source?: string;
  claim?: string;
  url?: string;
  title?: string;
};

export type AlertInput = {
  kind: AlertKind;
  headline: string;
  body?: string;
  /** Stable coalescing key: one pending row per (session, key). */
  dedup_key: string;
};

export type AlertRecord = {
  alert_id: string;
  reference: string;
  kind: AlertKind;
  headline: string;
  body?: string;
  state: AlertState;
  attempts: number;
  created_at: number;
  updated_at: number;
};

export type SearchHit = {
  handle: string;
  reference: string;
  kind: EvidenceKind;
  origin: EvidenceOrigin;
  title?: string;
  url?: string;
  pointer?: string;
  /** Bounded highlight around the match; empty when browsing. */
  snippet: string;
  /** UTF-16 length of the stored body. Read the body with `readEvidence`. */
  chars: number;
  created_at: number;
};

export type SearchPage = {
  hits: SearchHit[];
  /** Highest evidence id covered by this page; new evidence is excluded until a new search. */
  snapshot: number;
  /** True when more rows exist beyond this page. */
  more: boolean;
  next_cursor?: string;
};

export type EvidenceSlice = {
  handle: string;
  reference: string;
  kind: EvidenceKind;
  origin: EvidenceOrigin;
  title?: string;
  url?: string;
  pointer?: string;
  /** UTF-16 offset of the first returned character. */
  offset: number;
  text: string;
  total_chars: number;
  truncated_before: boolean;
  truncated_after: boolean;
  /** Offset to pass for the next slice, or absent when the body ended. */
  next_offset?: number;
  created_at: number;
};

export type StoreStats = {
  evidence: number;
  chars: number;
  runs: Partial<Record<RunState, number>>;
  alerts: Partial<Record<AlertState, number>>;
};

export type StoreOptions = { now?: () => number };

const EVIDENCE_KINDS: ReadonlySet<string> = new Set<EvidenceKind>(EVIDENCE_KIND_NAMES);

/**
 * Additive migrations for stores created by earlier builds of this store.
 * A column must exist before the base schema runs, because the schema creates
 * indexes that reference it. A genuinely fresh store has no tables yet and is
 * created complete by the schema itself, so nothing is added here.
 *
 * Only additive changes belong here: the store never rewrites or drops data.
 */
const COLUMN_MIGRATIONS: Record<string, Record<string, string>> = {
  runs: {
    kind: "TEXT NOT NULL DEFAULT 'task'",
    provider_session_id: "TEXT",
    provider_interaction_id: "TEXT",
    running_at: "INTEGER",
    next_alert_at: "INTEGER",
    alert_interval_ms: "INTEGER",
  },
};

function migrateColumns(db: DatabaseSync): void {
  for (const [table, columns] of Object.entries(COLUMN_MIGRATIONS)) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!existing.length) continue;
    const names = new Set(existing.map(column => column.name));
    for (const [name, definition] of Object.entries(columns)) {
      if (!names.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_groups (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  group_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','ready','uncertain')),
  event_cursor TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  reference TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','search','extract','answer')),
  group_id TEXT,
  provider_run_id TEXT,
  provider_session_id TEXT,
  parent TEXT REFERENCES runs(reference),
  intent_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('intent','submitting','accepted','pending','completed','failed','cancelled','action_required','uncertain')),
  processor TEXT,
  intent TEXT NOT NULL,
  summary TEXT,
  raw_result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  terminal_at INTEGER,
  provider_interaction_id TEXT,
  running_at INTEGER,
  next_alert_at INTEGER,
  alert_interval_ms INTEGER
);
CREATE INDEX IF NOT EXISTS runs_context ON runs(session_id, provider_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS runs_intent ON runs(session_id, intent_key);
CREATE UNIQUE INDEX IF NOT EXISTS runs_provider ON runs(session_id, provider_run_id) WHERE provider_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_session_state ON runs(session_id, state, created_at);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  reference TEXT NOT NULL REFERENCES runs(reference) ON DELETE CASCADE,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  provider_event_id TEXT,
  dedup_key TEXT,
  received_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS observations_dedup ON observations(reference, dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS observations_run ON observations(reference, id);

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  reference TEXT NOT NULL REFERENCES runs(reference) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  title TEXT,
  url TEXT,
  pointer TEXT,
  body TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_session ON evidence(session_id, id);
CREATE INDEX IF NOT EXISTS evidence_run ON evidence(reference, id);
CREATE INDEX IF NOT EXISTS evidence_kind ON evidence(session_id, kind, id);
CREATE INDEX IF NOT EXISTS evidence_url ON evidence(session_id, url) WHERE url IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
  title,
  body,
  content='evidence',
  content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS citations (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  evidence_id INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  source_id INTEGER REFERENCES evidence(id) ON DELETE SET NULL,
  claim TEXT,
  url TEXT,
  title TEXT
);
CREATE INDEX IF NOT EXISTS citations_evidence ON citations(evidence_id);
CREATE INDEX IF NOT EXISTS citations_source ON citations(source_id);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  reference TEXT NOT NULL REFERENCES runs(reference) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  headline TEXT NOT NULL,
  body TEXT,
  dedup_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','claimed','delivered','acknowledged')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_dedup ON alerts(session_id, dedup_key);
CREATE INDEX IF NOT EXISTS alerts_open ON alerts(session_id, state, created_at);
`;

/**
 * Switch to WAL. The switch needs an exclusive lock, and SQLite may refuse it
 * with SQLITE_BUSY without consulting the busy handler, so concurrent first
 * opens retry here. WAL persists in the file: only a brand-new store ever waits.
 */
async function enableWal(db: DatabaseSync): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (let delay = 5; ; delay = Math.min(delay * 2, 200)) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (err) {
      if (!/locked|busy/i.test((err as Error).message) || Date.now() + delay > deadline) throw err;
      await new Promise(resolveWait => setTimeout(resolveWait, delay));
    }
  }
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function nullable(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

/**
 * Turn free text into a forgiving FTS5 query: every word becomes a quoted term,
 * any of which may match. Never throws a syntax error on punctuation.
 */
function ftsQuery(text: string): string | undefined {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens?.length) return undefined;
  return tokens.slice(0, 32).map(token => `"${token}"`).join(" OR ");
}

/** A page cursor carries the search it continues, so a cursor alone is enough to fetch the next page. */
type CursorState = { v: 2; snapshot: number; offset: number; query?: string; reference?: string; kinds?: EvidenceKind[] };

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new StoreError("invalid", "Malformed search cursor");
  }
  const value = parsed as Partial<CursorState> | null;
  if (
    !value || value.v !== 2 || !Number.isSafeInteger(value.snapshot) || !Number.isSafeInteger(value.offset) || value.snapshot! < 0 || value.offset! < 0 ||
    (value.query !== undefined && typeof value.query !== "string") ||
    (value.reference !== undefined && typeof value.reference !== "string") ||
    (value.kinds !== undefined && (!Array.isArray(value.kinds) || !value.kinds.every(kind => EVIDENCE_KINDS.has(kind))))
  ) {
    throw new StoreError("invalid", "Malformed search cursor");
  }
  return value as CursorState;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export class ResearchStore {
  private readonly dir: string;
  /** The store's clock: the only clock for run timestamps and the progress timetable. */
  readonly now: () => number;
  private db?: DatabaseSync;
  private opening?: Promise<DatabaseSync>;
  private statements = new Map<string, StatementSync>();

  constructor(baseDir: string, options: StoreOptions = {}) {
    this.dir = resolve(baseDir);
    this.now = options.now ?? Date.now;
  }

  /** The fresh store's database file. The legacy `webtasks.sqlite` is never touched. */
  get path(): string {
    return join(this.dir, "research.sqlite");
  }

  async init(): Promise<this> {
    await this.connect();
    return this;
  }

  async close(): Promise<void> {
    const db = this.db;
    this.db = undefined;
    this.statements.clear();
    this.opening = undefined;
    if (db) db.close();
  }

  private async connect(): Promise<DatabaseSync> {
    if (this.db) return this.db;
    if (!this.opening) {
      this.opening = (async () => {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const db = new DatabaseSync(this.path);
        try {
          // First, so every later statement waits for a concurrent opener.
          db.exec("PRAGMA busy_timeout = 5000");
          await enableWal(db);
          db.exec("PRAGMA synchronous = FULL"); // a committed row is on disk before we report it
          db.exec("PRAGMA foreign_keys = ON");
          const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
          if (version > SCHEMA_VERSION) {
            throw new StoreError("conflict", `research store schema ${version} is newer than this build (${SCHEMA_VERSION})`);
          }
          // A missing FTS table means the index was lost (crash, corruption, manual drop).
          // Rebuilding it after creation keeps stored evidence searchable instead of
          // silently invisible; it is a no-op cost on a genuinely fresh store.
          const hadIndex = db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE name = 'evidence_fts'`).get() !== undefined;
          db.exec("BEGIN IMMEDIATE");
          try {
            migrateColumns(db);
            db.exec(SCHEMA);
            if (!hadIndex) db.exec(`INSERT INTO evidence_fts (evidence_fts) VALUES ('rebuild')`);
            db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
            db.exec("COMMIT");
          } catch (err) {
            try { db.exec("ROLLBACK"); } catch { /* the open fails below */ }
            throw err;
          }
        } catch (err) {
          db.close();
          throw err;
        }
        this.db = db;
        // Private result content: the directory already restricts access; keep the file itself closed.
        await chmod(this.path, 0o600).catch(() => undefined);
        return db;
      })().catch(err => {
        this.opening = undefined;
        throw err;
      });
    }
    return this.opening;
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new StoreError("closed", "Stored research evidence is unavailable right now; the session may be restarting");
    return this.db;
  }

  private stmt(sql: string): StatementSync {
    const db = this.requireDb();
    let cached = this.statements.get(sql);
    if (!cached) {
      cached = db.prepare(sql);
      this.statements.set(sql, cached);
    }
    return cached;
  }

  private tx<T>(fn: () => T): T {
    const db = this.requireDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* the original error is the useful one */ }
      throw err;
    }
  }

  private touchSession(sessionId: string, now: number): void {
    this.stmt(
      `INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run(sessionId, now, now);
  }

  // ---------------------------------------------------------------- sessions

  /** Record that this Pi session uses the store. Lookup-only callers may skip it. */
  async registerSession(sessionId: string): Promise<void> {
    await this.connect();
    this.tx(() => this.touchSession(sessionId, this.now()));
  }

  /** Bind (or replace) this session's Parallel Task Group. */
  async bindGroup(sessionId: string, groupId: string | undefined, state: "pending" | "ready" | "uncertain", error?: string): Promise<void> {
    await this.connect();
    const now = this.now();
    this.tx(() => {
      this.touchSession(sessionId, now);
      this.stmt(
        `INSERT INTO task_groups (session_id, group_id, state, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           group_id = COALESCE(excluded.group_id, task_groups.group_id),
           state = excluded.state,
           error = excluded.error,
           updated_at = excluded.updated_at`,
      ).run(sessionId, groupId ?? null, state, error ?? null, now, now);
    });
  }

  async groupForSession(sessionId: string): Promise<{ group_id?: string; state: string; event_cursor?: string; error?: string } | undefined> {
    await this.connect();
    const row = this.stmt(`SELECT group_id, state, event_cursor, error FROM task_groups WHERE session_id = ?`).get(sessionId) as
      | { group_id: string | null; state: string; event_cursor: string | null; error: string | null }
      | undefined;
    if (!row) return undefined;
    return { group_id: nullable(row.group_id), state: row.state, event_cursor: nullable(row.event_cursor), error: nullable(row.error) };
  }

  /**
   * Advance the group event cursor. Callers must commit this only after the
   * events it covers are durable, which is why it is a separate call.
   */
  async setGroupCursor(sessionId: string, cursor: string | undefined): Promise<void> {
    await this.connect();
    this.stmt(`UPDATE task_groups SET event_cursor = ?, updated_at = ? WHERE session_id = ?`).run(cursor ?? null, this.now(), sessionId);
  }

  // -------------------------------------------------------------------- runs

  /**
   * Persist submission intent before any paid call.
   *
   * `intentKey` is the Pi tool invocation id. Replaying the same invocation
   * returns the existing run with `created: false`, so a crash or retry cannot
   * silently buy a second Task API run.
   */
  async beginRun(input: {
    sessionId: string;
    intentKey: string;
    intent: unknown;
    kind?: RunKind;
    processor?: string;
    parent?: string;
    groupId?: string;
    state?: "intent" | "submitting";
  }): Promise<{ reference: string; created: boolean }> {
    await this.connect();
    if (!input.intentKey) throw new StoreError("invalid", "A run needs an intent key");
    const now = this.now();
    return this.tx(() => {
      this.touchSession(input.sessionId, now);
      if (input.parent) {
        const parent = this.stmt(`SELECT session_id FROM runs WHERE reference = ?`).get(input.parent) as { session_id: string } | undefined;
        if (!parent || parent.session_id !== input.sessionId) {
          throw new StoreError("invalid", `No research record ${input.parent} in this session`);
        }
      }
      const existing = this.stmt(`SELECT reference FROM runs WHERE session_id = ? AND intent_key = ?`).get(input.sessionId, input.intentKey) as
        | { reference: string }
        | undefined;
      if (existing) return { reference: existing.reference, created: false };

      const reference = newId("run");
      this.stmt(
        `INSERT INTO runs (reference, session_id, kind, group_id, parent, intent_key, state, processor, intent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        reference, input.sessionId, input.kind ?? "task", input.groupId ?? null, input.parent ?? null, input.intentKey,
        input.state ?? "intent", input.processor ?? null, JSON.stringify(input.intent ?? null), now, now,
      );
      return { reference, created: true };
    });
  }

  /**
   * Bind the provider run id that Parallel confirmed for this run. Idempotent
   * for the same run.
   *
   * Confirmation is a fact about existence: an unconfirmed run becomes
   * `accepted`, and any other state is kept. A terminal run is never reopened.
   */
  async bindProviderRun(input: {
    sessionId: string;
    reference: string;
    providerRunId: string;
    providerSessionId?: string;
    interactionId?: string;
    groupId?: string;
  }): Promise<void> {
    await this.connect();
    const now = this.now();
    this.tx(() => {
      const run = this.requireRun(input.sessionId, input.reference);
      if (run.provider_run_id && run.provider_run_id !== input.providerRunId) {
        throw new StoreError("conflict", `Run ${input.reference} is already bound to a different provider run`);
      }
      this.stmt(
        `UPDATE runs SET provider_run_id = ?, provider_session_id = COALESCE(?, provider_session_id),
                         provider_interaction_id = COALESCE(?, provider_interaction_id),
                         group_id = COALESCE(?, group_id),
                         state = CASE WHEN state IN (${sqlStates(UNCONFIRMED_RUN_STATES)}) THEN 'accepted' ELSE state END,
                         updated_at = ? WHERE reference = ?`,
      ).run(
        input.providerRunId, input.providerSessionId ?? null, input.interactionId ?? null,
        input.groupId ?? null, now, input.reference,
      );
    });
  }

  /**
   * A Task run is running: it becomes `pending` and its progress timetable runs.
   * The first call starts the timetable with `intervalMs`; a run that comes back
   * from `action_required` restarts its next alert one interval from now. The
   * interval is guidance from published processor latency, never a deadline.
   *
   * A late "running" observation never reopens a terminal run. Returns whether
   * the run changed.
   */
  async markRunning(sessionId: string, reference: string, intervalMs: number): Promise<boolean> {
    await this.connect();
    const now = this.now();
    return this.tx(() => {
      this.requireRun(sessionId, reference);
      const info = this.stmt(
        `UPDATE runs SET running_at = COALESCE(running_at, ?),
                         alert_interval_ms = COALESCE(alert_interval_ms, ?),
                         next_alert_at = CASE WHEN running_at IS NULL OR next_alert_at IS NULL OR state = 'action_required'
                                              THEN ? + COALESCE(alert_interval_ms, ?) ELSE next_alert_at END,
                         state = 'pending', terminal_at = NULL, updated_at = ?
         WHERE reference = ? AND session_id = ? AND state IN (${sqlStates(OPEN_RUN_STATES)})
           AND NOT (state = 'pending' AND running_at IS NOT NULL)`,
      ).run(now, intervalMs, now, intervalMs, now, reference, sessionId);
      return Number(info.changes) > 0;
    });
  }

  /**
   * Move an open run between open states, and queue its alert in the same
   * transaction. Nothing changes unless the run is in one of `from`, so a
   * repeated observation neither repeats the move nor the alert. Returns whether
   * the run moved.
   */
  async transitionRun(input: {
    sessionId: string;
    reference: string;
    from: ReadonlySet<RunState>;
    to: RunState;
    error?: string;
    alert?: AlertInput;
  }): Promise<boolean> {
    if (TERMINAL_RUN_STATES.has(input.to)) throw new StoreError("invalid", "A terminal state is committed by completeRun");
    await this.connect();
    const now = this.now();
    return this.tx(() => {
      const run = this.requireRun(input.sessionId, input.reference);
      if (!input.from.has(run.state) || TERMINAL_RUN_STATES.has(run.state)) return false;
      this.applyRunState(input.reference, input.to, now, undefined, input.error);
      if (input.alert) this.upsertAlert(input.sessionId, input.reference, input.alert, now);
      return true;
    });
  }

  /** Running Task runs whose next progress alert is due by the store's clock. */
  async runsNeedingProgress(sessionId: string): Promise<RunRecord[]> {
    await this.connect();
    const rows = this.stmt(
      `SELECT * FROM runs WHERE session_id = ? AND kind = 'task' AND state = 'pending'
         AND next_alert_at IS NOT NULL AND next_alert_at <= ? ORDER BY next_alert_at LIMIT 50`,
    ).all(sessionId, this.now()) as Record<string, unknown>[];
    return rows.map(row => this.toRun(row));
  }

  /**
   * Queue one progress alert and advance the run's timetable by one interval,
   * in one transaction: a failure leaves both undone, so the alert is neither
   * lost nor queued twice. Returns false when the run is no longer running.
   */
  async queueProgress(sessionId: string, reference: string, alert: AlertInput): Promise<boolean> {
    await this.connect();
    const now = this.now();
    return this.tx(() => {
      const run = this.requireRun(sessionId, reference);
      if (run.state !== "pending" || run.alert_interval_ms === undefined) return false;
      this.upsertAlert(sessionId, reference, alert, now);
      this.stmt(`UPDATE runs SET next_alert_at = ? WHERE reference = ?`).run(now + run.alert_interval_ms, reference);
      return true;
    });
  }

  /** Reading a run's evidence is real evidence that its alerts were received. */
  async acknowledgeRunAlerts(sessionId: string, reference: string): Promise<number> {
    await this.connect();
    const info = this.stmt(
      `UPDATE alerts SET state = 'acknowledged', updated_at = ? WHERE session_id = ? AND reference = ? AND state IN ('claimed','delivered')`,
    ).run(this.now(), sessionId, reference);
    return Number(info.changes);
  }

  /**
   * Resolve a local Search/Extract receipt to its provider research context.
   * Returns undefined when the run carries no provider session (for example a
   * Task run), so a caller can never smuggle a foreign provider id in by hand.
   */
  async providerContext(sessionId: string, reference: string): Promise<string | undefined> {
    await this.connect();
    const row = this.stmt(`SELECT provider_session_id FROM runs WHERE reference = ? AND session_id = ?`).get(reference, sessionId) as
      | { provider_session_id: string | null }
      | undefined;
    if (!row) throw new StoreError("not_found", `No research record ${reference} in this session`);
    return nullable(row.provider_session_id);
  }

  /**
   * Move a run to a new state. Terminal states are final: a completed run
   * cannot be silently rewritten by a later, weaker event.
   */
  async setRunState(input: { sessionId: string; reference: string; state: RunState; summary?: string; error?: string }): Promise<void> {
    await this.connect();
    const now = this.now();
    this.tx(() => {
      const run = this.requireRun(input.sessionId, input.reference);
      if (run.state === input.state) return;
      if (TERMINAL_RUN_STATES.has(run.state)) {
        throw new StoreError("conflict", `Run ${input.reference} is already ${run.state}`);
      }
      this.applyRunState(input.reference, input.state, now, input.summary, input.error);
    });
  }

  private applyRunState(reference: string, state: RunState, now: number, summary?: string, error?: string): void {
    this.stmt(
      `UPDATE runs SET state = ?, summary = COALESCE(?, summary), error = ?, updated_at = ?, terminal_at = ? WHERE reference = ?`,
    ).run(state, summary ?? null, error ?? null, now, TERMINAL_RUN_STATES.has(state) ? now : null, reference);
  }

  private requireRun(sessionId: string, reference: string): RunRecord {
    const row = this.stmt(`SELECT * FROM runs WHERE reference = ? AND session_id = ?`).get(reference, sessionId) as Record<string, unknown> | undefined;
    if (!row) throw new StoreError("not_found", `No research run ${reference} in this session`);
    return this.toRun(row);
  }

  private toRun(row: Record<string, unknown>): RunRecord {
    return {
      reference: row.reference as string,
      session_id: row.session_id as string,
      kind: (row.kind as RunKind) ?? "task",
      group_id: nullable(row.group_id as string | null),
      provider_run_id: nullable(row.provider_run_id as string | null),
      provider_session_id: nullable(row.provider_session_id as string | null),
      parent: nullable(row.parent as string | null),
      intent_key: row.intent_key as string,
      state: row.state as RunState,
      processor: nullable(row.processor as string | null),
      intent: JSON.parse(row.intent as string),
      summary: nullable(row.summary as string | null),
      error: nullable(row.error as string | null),
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
      terminal_at: row.terminal_at === null ? undefined : (row.terminal_at as number),
      provider_interaction_id: nullable(row.provider_interaction_id as string | null),
      running_at: row.running_at === null ? undefined : (row.running_at as number),
      next_alert_at: row.next_alert_at === null ? undefined : (row.next_alert_at as number),
      alert_interval_ms: row.alert_interval_ms === null ? undefined : (row.alert_interval_ms as number),
    };
  }

  async run(sessionId: string, reference: string): Promise<RunRecord | undefined> {
    await this.connect();
    const row = this.stmt(`SELECT * FROM runs WHERE reference = ? AND session_id = ?`).get(reference, sessionId) as Record<string, unknown> | undefined;
    return row ? this.toRun(row) : undefined;
  }

  async runByProviderId(sessionId: string, providerRunId: string): Promise<RunRecord | undefined> {
    await this.connect();
    const row = this.stmt(`SELECT * FROM runs WHERE provider_run_id = ? AND session_id = ?`).get(providerRunId, sessionId) as Record<string, unknown> | undefined;
    return row ? this.toRun(row) : undefined;
  }

  async listRuns(sessionId: string, options: { states?: RunState[]; limit?: number } = {}): Promise<RunRecord[]> {
    await this.connect();
    const limit = clamp(options.limit, 50, 1, 500);
    const states = options.states?.length ? options.states : undefined;
    const rows = states
      ? this.stmt(
        `SELECT * FROM runs WHERE session_id = ? AND state IN (${states.map(() => "?").join(",")}) ORDER BY created_at DESC, reference LIMIT ?`,
      ).all(sessionId, ...states, limit)
      : this.stmt(`SELECT * FROM runs WHERE session_id = ? ORDER BY created_at DESC, reference LIMIT ?`).all(sessionId, limit);
    return (rows as Record<string, unknown>[]).map(row => this.toRun(row));
  }

  /**
   * Mark synchronous requests that were interrupted before their result was
   * stored. A Search/Extract row left in `intent`/`submitting` cannot be
   * trusted either way, so it becomes `uncertain` instead of looking unfinished
   * forever. Nothing is resubmitted here; the agent sees the honest state.
   *
   * Task runs are excluded: their recovery is a provider reconciliation, not a
   * local guess, and that is handled separately.
   */
  async reconcileInterrupted(sessionId: string, options: { olderThanMs?: number } = {}): Promise<number> {
    await this.connect();
    const now = this.now();
    const cutoff = now - Math.max(0, options.olderThanMs ?? 60_000);
    const info = this.stmt(
      `UPDATE runs SET state = 'uncertain', error = COALESCE(error, 'interrupted before the result was stored'), updated_at = ?
       WHERE session_id = ? AND state IN (${sqlStates(IN_FLIGHT_RUN_STATES)})
         AND kind IN ('search','extract','answer') AND updated_at <= ?`,
    ).run(now, sessionId, cutoff);
    return Number(info.changes);
  }

  // ------------------------------------------------------------ observations

  /**
   * Store one received progress or provider event verbatim.
   *
   * `dedupKey` collapses a replay of the same event (reconnects replay recorded
   * progress). Callers must derive it from stable provider data — run, type,
   * timestamp, payload — and must not derive it from message text alone, which
   * would merge genuinely distinct events.
   */
  async appendObservation(input: {
    sessionId: string;
    reference: string;
    source: string;
    eventType: string;
    providerEventId?: string;
    dedupKey?: string;
    /** Replace the stored payload of a repeated key (latest-snapshot events such as statistics). */
    replaceIfExists?: boolean;
    payload: unknown;
  }): Promise<{ id: number; duplicate: boolean }> {
    await this.connect();
    const now = this.now();
    return this.tx(() => {
      this.requireRun(input.sessionId, input.reference);
      const info = this.stmt(
        `INSERT OR IGNORE INTO observations (session_id, reference, source, event_type, provider_event_id, dedup_key, received_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.sessionId, input.reference, input.source, input.eventType,
        input.providerEventId ?? null, input.dedupKey ?? null, now, JSON.stringify(input.payload ?? null),
      );
      if (Number(info.changes) === 1) return { id: Number(info.lastInsertRowid), duplicate: false };
      if (input.dedupKey === undefined) throw new StoreError("conflict", "Observation insert was ignored without a dedup key");
      const existing = this.stmt(`SELECT id FROM observations WHERE reference = ? AND dedup_key = ?`).get(input.reference, input.dedupKey) as
        | { id: number }
        | undefined;
      if (existing && input.replaceIfExists) {
        this.stmt(`UPDATE observations SET payload = ?, received_at = ? WHERE id = ?`).run(JSON.stringify(input.payload ?? null), now, existing.id);
      }
      return { id: existing?.id ?? 0, duplicate: true };
    });
  }

  /** Store one piece of evidence outside a completion (for example an intermediate finding). */
  async appendEvidence(sessionId: string, reference: string, input: EvidenceInput): Promise<{ handle: string }> {
    await this.connect();
    const now = this.now();
    return this.tx(() => {
      this.requireRun(sessionId, reference);
      return { handle: this.insertEvidence(sessionId, reference, input, now).handle };
    });
  }

  async observations(sessionId: string, reference: string, options: { afterId?: number; limit?: number } = {}): Promise<
    { id: number; source: string; eventType: string; providerEventId?: string; receivedAt: number; payload: unknown }[]
  > {
    await this.connect();
    this.requireRun(sessionId, reference);
    const limit = clamp(options.limit, 50, 1, 500);
    const rows = this.stmt(
      `SELECT id, source, event_type, provider_event_id, received_at, payload FROM observations
       WHERE reference = ? AND session_id = ? AND id > ? ORDER BY id LIMIT ?`,
    ).all(reference, sessionId, options.afterId ?? 0, limit) as Record<string, unknown>[];
    return rows.map(row => ({
      id: row.id as number,
      source: row.source as string,
      eventType: row.event_type as string,
      providerEventId: nullable(row.provider_event_id as string | null),
      receivedAt: row.received_at as number,
      payload: JSON.parse(row.payload as string),
    }));
  }

  /** The newest observations of one run, newest first, optionally of one event type. */
  async latestObservations(sessionId: string, reference: string, options: { eventType?: string; limit?: number } = {}): Promise<
    { id: number; eventType: string; payload: unknown }[]
  > {
    await this.connect();
    const limit = clamp(options.limit, 50, 1, 500);
    const rows = (options.eventType === undefined
      ? this.stmt(`SELECT id, event_type, payload FROM observations WHERE reference = ? AND session_id = ? ORDER BY id DESC LIMIT ?`)
        .all(reference, sessionId, limit)
      : this.stmt(`SELECT id, event_type, payload FROM observations WHERE reference = ? AND session_id = ? AND event_type = ? ORDER BY id DESC LIMIT ?`)
        .all(reference, sessionId, options.eventType, limit)) as Record<string, unknown>[];
    return rows.map(row => ({ id: row.id as number, eventType: row.event_type as string, payload: JSON.parse(row.payload as string) }));
  }

  // --------------------------------------------------------------- evidence

  private insertEvidence(sessionId: string, reference: string, input: EvidenceInput, now: number): { id: number; handle: string } {
    if (!input.body) throw new StoreError("invalid", "Evidence needs a body");
    if (!EVIDENCE_KINDS.has(input.kind)) throw new StoreError("invalid", `Unknown evidence kind ${input.kind}`);
    const createdAt = input.created_at ?? now;
    for (let attempt = 0; attempt < 5; attempt++) {
      const handle = newId("ev");
      try {
        const info = this.stmt(
          `INSERT INTO evidence (handle, session_id, reference, kind, origin, title, url, pointer, body, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          handle, sessionId, reference, input.kind, input.origin, input.title ?? null, input.url ?? null,
          input.pointer ?? null, input.body, input.payload === undefined ? null : JSON.stringify(input.payload), createdAt,
        );
        const id = Number(info.lastInsertRowid);
        // Same transaction as the row: a body is never searchable before it is stored, or vice versa.
        this.stmt(`INSERT INTO evidence_fts (rowid, title, body) VALUES (?, ?, ?)`).run(id, input.title ?? "", input.body);
        return { id, handle };
      } catch (err) {
        if (String((err as { message?: string }).message).includes("UNIQUE") && attempt < 4) continue;
        throw err;
      }
    }
    throw new StoreError("conflict", "Could not allocate an evidence handle");
  }

  private evidenceIdByHandle(sessionId: string, handle: string): number {
    const row = this.stmt(`SELECT id FROM evidence WHERE handle = ? AND session_id = ?`).get(handle, sessionId) as { id: number } | undefined;
    if (!row) throw new StoreError("not_found", `No evidence ${handle} in this session`);
    return row.id;
  }

  /** Column names of one table, for migration checks and diagnostics. */
  async schemaColumns(table: "runs" | "evidence" | "alerts" | "observations" | "citations" | "task_groups" | "sessions"): Promise<string[]> {
    await this.connect();
    return (this.stmt(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name);
  }

  /** The store's schema version on disk. */
  async schemaVersion(): Promise<number> {
    await this.connect();
    return Number((this.stmt("PRAGMA user_version").get() as { user_version: number }).user_version);
  }

  /**
   * Commit a terminal result: payload, evidence, citations, run state, and
   * pending alerts in one transaction.
   *
   * Returning `changed: false` means the same terminal state was already
   * committed, so a duplicated completion event is harmless. A different
   * terminal state is a conflict rather than a silent overwrite.
   */
  async completeRun(input: {
    sessionId: string;
    reference: string;
    state: "completed" | "failed" | "cancelled";
    evidence?: EvidenceInput[];
    citations?: CitationInput[];
    alerts?: AlertInput[];
    summary?: string;
    error?: string;
    /** Provider operation id for this request (run id, search id, extract id). */
    providerRunId?: string;
    /** Provider research context (Search/Extract session id). */
    providerSessionId?: string;
    /** Provider interaction id, for later continuation. */
    providerInteractionId?: string;
    /** Untouched provider result object, stored verbatim for later re-reading. */
    rawResult?: unknown;
  }): Promise<{ changed: boolean; evidence: { handle: string; kind: EvidenceKind; title?: string }[]; alertIds: string[] }> {
    await this.connect();
    const now = this.now();
    return this.tx(() => {
      const run = this.requireRun(input.sessionId, input.reference);
      if (TERMINAL_RUN_STATES.has(run.state)) {
        if (run.state === input.state) return { changed: false, evidence: [], alertIds: [] };
        throw new StoreError("conflict", `Run ${input.reference} is already ${run.state}`);
      }
      if (input.state === "completed" && !(input.evidence ?? []).length && input.rawResult === undefined) {
        throw new StoreError("invalid", "A completed run needs evidence or a provider payload");
      }

      const handles: { id: number; handle: string; kind: EvidenceKind; title?: string }[] = [];
      const aliases = new Map<string, number>();
      for (const item of input.evidence ?? []) {
        const stored = this.insertEvidence(input.sessionId, input.reference, item, now);
        if (item.ref !== undefined) {
          if (aliases.has(item.ref)) throw new StoreError("invalid", `Duplicate evidence alias ${item.ref}`);
          aliases.set(item.ref, stored.id);
        }
        handles.push({ ...stored, kind: item.kind, title: item.title });
      }
      const resolve = (handleOrAlias: string): number => aliases.get(handleOrAlias) ?? this.evidenceIdByHandle(input.sessionId, handleOrAlias);
      for (const citation of input.citations ?? []) {
        const evidenceId = resolve(citation.evidence);
        const sourceId = citation.source === undefined ? undefined : resolve(citation.source);
        this.stmt(
          `INSERT INTO citations (session_id, evidence_id, source_id, claim, url, title) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(input.sessionId, evidenceId, sourceId ?? null, citation.claim ?? null, citation.url ?? null, citation.title ?? null);
      }

      this.stmt(
        `UPDATE runs SET raw_result = COALESCE(?, raw_result),
                         provider_run_id = COALESCE(?, provider_run_id),
                         provider_session_id = COALESCE(?, provider_session_id),
                         provider_interaction_id = COALESCE(?, provider_interaction_id)
         WHERE reference = ?`,
      ).run(
        input.rawResult === undefined ? null : JSON.stringify(input.rawResult),
        input.providerRunId ?? null, input.providerSessionId ?? null, input.providerInteractionId ?? null, input.reference,
      );
      this.applyRunState(input.reference, input.state, now, input.summary, input.error);

      const alertIds = (input.alerts ?? []).map(alert => this.upsertAlert(input.sessionId, input.reference, alert, now));
      return {
        changed: true,
        evidence: handles.map(({ handle, kind, title }) => ({ handle, kind, title })),
        alertIds,
      };
    });
  }

  async rawResult(sessionId: string, reference: string): Promise<unknown> {
    await this.connect();
    const row = this.stmt(`SELECT raw_result FROM runs WHERE reference = ? AND session_id = ?`).get(reference, sessionId) as
      | { raw_result: string | null }
      | undefined;
    if (!row) throw new StoreError("not_found", `No research run ${reference} in this session`);
    return row.raw_result === null ? undefined : JSON.parse(row.raw_result);
  }

  async citations(sessionId: string, evidenceHandle: string): Promise<{ claim?: string; url?: string; title?: string; sourceHandle?: string }[]> {
    await this.connect();
    const evidenceId = this.evidenceIdByHandle(sessionId, evidenceHandle);
    const rows = this.stmt(
      `SELECT c.claim, c.url, c.title, s.handle AS source_handle
       FROM citations c LEFT JOIN evidence s ON s.id = c.source_id
       WHERE c.evidence_id = ? AND c.session_id = ? ORDER BY c.id`,
    ).all(evidenceId, sessionId) as Record<string, unknown>[];
    return rows.map(row => ({
      claim: nullable(row.claim as string | null),
      url: nullable(row.url as string | null),
      title: nullable(row.title as string | null),
      sourceHandle: nullable(row.source_handle as string | null),
    }));
  }

  // ----------------------------------------------------------------- search

  /**
   * Bounded evidence search. With `query`, ranks by FTS5 bm25; without it,
   * lists newest evidence first (used for a run's completion index).
   *
   * A page pins a snapshot of the highest evidence id. Evidence stored after
   * the first page cannot change that page sequence, so a cursor never repeats
   * or skips rows; a fresh search is the way to see new material.
   */
  async search(sessionId: string, options: { query?: string; reference?: string; kinds?: EvidenceKind[]; limit?: number; cursor?: string } = {}): Promise<SearchPage> {
    await this.connect();
    const limit = clamp(options.limit, 10, 1, 50);
    const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
    // A cursor continues exactly the search that produced it; its filters win over anything passed beside it.
    const text = cursor ? cursor.query : options.query?.trim() || undefined;
    const reference = cursor ? cursor.reference : options.reference || undefined;
    let kinds: EvidenceKind[] | undefined = cursor ? cursor.kinds : undefined;
    if (!cursor && options.kinds?.length) {
      kinds = options.kinds.filter(kind => EVIDENCE_KINDS.has(kind));
      if (!kinds.length) throw new StoreError("invalid", "No known evidence kinds requested");
    }
    const snapshot = cursor?.snapshot ?? Number(
      (this.stmt(`SELECT COALESCE(MAX(id), 0) AS max FROM evidence WHERE session_id = ?`).get(sessionId) as { max: number }).max,
    );
    const offset = cursor?.offset ?? 0;

    const filters: string[] = ["e.session_id = ?", "e.id <= ?"];
    const params: (string | number)[] = [sessionId, snapshot];
    if (reference) {
      filters.push("e.reference = ?");
      params.push(reference);
    }
    if (kinds?.length) {
      filters.push(`e.kind IN (${kinds.map(() => "?").join(",")})`);
      params.push(...kinds);
    }

    const query = text ? ftsQuery(text) : undefined;
    if (text && !query) return { hits: [], snapshot, more: false };

    let rows: Record<string, unknown>[];
    if (query) {
      rows = this.stmt(
        `SELECT e.id, e.handle, e.reference, e.kind, e.origin, e.title, e.url, e.pointer, LENGTH(e.body) AS chars, e.created_at,
                snippet(evidence_fts, 1, '[', ']', '…', 12) AS snippet, bm25(evidence_fts) AS score
         FROM evidence_fts JOIN evidence e ON e.id = evidence_fts.rowid
         WHERE evidence_fts MATCH ? AND ${filters.join(" AND ")}
         ORDER BY score ASC, e.id ASC LIMIT ? OFFSET ?`,
      ).all(query, ...params, limit + 1, offset) as Record<string, unknown>[];
    } else {
      rows = this.stmt(
        `SELECT e.id, e.handle, e.reference, e.kind, e.origin, e.title, e.url, e.pointer, LENGTH(e.body) AS chars, e.created_at,
                '' AS snippet
         FROM evidence e WHERE ${filters.join(" AND ")}
         ORDER BY e.id DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit + 1, offset) as Record<string, unknown>[];
    }

    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      hits: page.map(row => ({
        handle: row.handle as string,
        reference: row.reference as string,
        kind: row.kind as EvidenceKind,
        origin: row.origin as EvidenceOrigin,
        title: nullable(row.title as string | null),
        url: nullable(row.url as string | null),
        pointer: nullable(row.pointer as string | null),
        snippet: (row.snippet as string) ?? "",
        chars: row.chars as number,
        created_at: row.created_at as number,
      })),
      snapshot,
      more,
      next_cursor: more ? encodeCursor({ v: 2, snapshot, offset: offset + limit, query: text, reference, kinds }) : undefined,
    };
  }

  /**
   * Read one stored body by handle, in bounded slices.
   *
   * Offsets and lengths are UTF-16 code units, matching JavaScript string
   * indexing; a slice never splits a surrogate pair.
   */
  async readEvidence(sessionId: string, handle: string, options: { offset?: number; limit?: number } = {}): Promise<EvidenceSlice> {
    await this.connect();
    const row = this.stmt(
      `SELECT handle, reference, kind, origin, title, url, pointer, body, created_at
       FROM evidence WHERE handle = ? AND session_id = ?`,
    ).get(handle, sessionId) as Record<string, unknown> | undefined;
    if (!row) throw new StoreError("not_found", `No evidence ${handle} in this session`);

    const body = row.body as string;
    const total = body.length;
    let start = clamp(options.offset, 0, 0, total);
    // An offset between the halves of a pair backs up to include the pair whole.
    if (start > 0 && start < total && isLowSurrogate(body.charCodeAt(start)) && isHighSurrogate(body.charCodeAt(start - 1))) start -= 1;
    let end = Math.min(total, start + clamp(options.limit, 4000, 1, 20000));
    if (end < total && isLowSurrogate(body.charCodeAt(end)) && isHighSurrogate(body.charCodeAt(end - 1))) end += 1;

    const text = body.slice(start, end);
    const truncatedAfter = end < total;
    return {
      handle: row.handle as string,
      reference: row.reference as string,
      kind: row.kind as EvidenceKind,
      origin: row.origin as EvidenceOrigin,
      title: nullable(row.title as string | null),
      url: nullable(row.url as string | null),
      pointer: nullable(row.pointer as string | null),
      offset: start,
      text,
      total_chars: total,
      truncated_before: start > 0,
      truncated_after: truncatedAfter,
      next_offset: truncatedAfter ? end : undefined,
      created_at: row.created_at as number,
    };
  }

  // ----------------------------------------------------------------- alerts

  private upsertAlert(sessionId: string, reference: string, alert: AlertInput, now: number): string {
    if (!alert.dedup_key) throw new StoreError("invalid", "An alert needs a dedup key");
    const existing = this.stmt(`SELECT alert_id, state FROM alerts WHERE session_id = ? AND dedup_key = ?`).get(sessionId, alert.dedup_key) as
      | { alert_id: string; state: AlertState }
      | undefined;
    if (existing) {
      // Coalesce: refresh the content of an open alert, leave an acknowledged one alone.
      if (existing.state !== "acknowledged") {
        this.stmt(`UPDATE alerts SET kind = ?, headline = ?, body = ?, state = 'pending', updated_at = ? WHERE alert_id = ?`).run(
          alert.kind, alert.headline, alert.body ?? null, now, existing.alert_id,
        );
      }
      return existing.alert_id;
    }
    const alertId = newId("alert");
    this.stmt(
      `INSERT INTO alerts (alert_id, session_id, reference, kind, headline, body, dedup_key, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    ).run(alertId, sessionId, reference, alert.kind, alert.headline, alert.body ?? null, alert.dedup_key, now, now);
    return alertId;
  }

  /** Add or coalesce an alert outside a completion (progress updates). */
  async enqueueAlert(sessionId: string, reference: string, alert: AlertInput): Promise<string> {
    await this.connect();
    const now = this.now();
    return this.tx(() => {
      this.requireRun(sessionId, reference);
      return this.upsertAlert(sessionId, reference, alert, now);
    });
  }

  /**
   * Take the next alerts to hand to Pi. Rows left `claimed` by a crash are
   * picked up again; each claim bumps `attempts`.
   *
   * Terminal alerts come first. `delivered` rows are not claimed here: a live
   * runtime may still hold that follow-up. Call `requeueUnacknowledged` when a
   * new runtime takes over the session.
   */
  async claimAlerts(sessionId: string, options: { limit?: number } = {}): Promise<AlertRecord[]> {
    await this.connect();
    const limit = clamp(options.limit, 5, 1, 50);
    const now = this.now();
    return this.tx(() => {
      const rows = this.stmt(
        `SELECT * FROM alerts WHERE session_id = ? AND state IN ('pending','claimed')
         ORDER BY CASE kind WHEN 'failure' THEN 0 WHEN 'action_required' THEN 0 WHEN 'completion' THEN 1 ELSE 2 END,
                  created_at ASC, alert_id ASC
         LIMIT ?`,
      ).all(sessionId, limit) as Record<string, unknown>[];
      for (const row of rows) {
        this.stmt(`UPDATE alerts SET state = 'claimed', attempts = attempts + 1, updated_at = ? WHERE alert_id = ?`).run(now, row.alert_id as string);
      }
      return rows.map(row => this.toAlert({ ...row, state: "claimed", attempts: Number(row.attempts) + 1, updated_at: now }));
    });
  }

  /** Record that a handoff was attempted. Not proof of delivery; keep the row open. */
  async markAlertDelivered(sessionId: string, alertId: string): Promise<void> {
    await this.connect();
    this.stmt(
      `UPDATE alerts SET state = 'delivered', updated_at = ? WHERE alert_id = ? AND session_id = ? AND state = 'claimed'`,
    ).run(this.now(), alertId, sessionId);
  }

  /** Clear an alert only after the delivery has been confirmed durable. */
  async acknowledgeAlert(sessionId: string, alertId: string): Promise<void> {
    await this.connect();
    this.stmt(
      `UPDATE alerts SET state = 'acknowledged', updated_at = ? WHERE alert_id = ? AND session_id = ? AND state IN ('claimed','delivered')`,
    ).run(this.now(), alertId, sessionId);
  }

  /**
   * New runtime, same session: unacknowledged handoffs from the previous
   * runtime are eligible for delivery again. Duplicates are possible; silence
   * is not.
   */
  async requeueUnacknowledgedAlerts(sessionId: string): Promise<number> {
    await this.connect();
    const info = this.stmt(
      `UPDATE alerts SET state = 'pending', updated_at = ? WHERE session_id = ? AND state IN ('claimed','delivered')`,
    ).run(this.now(), sessionId);
    return Number(info.changes);
  }

  async alerts(sessionId: string, options: { reference?: string; states?: AlertState[]; limit?: number } = {}): Promise<AlertRecord[]> {
    await this.connect();
    const limit = clamp(options.limit, 50, 1, 200);
    const filters = ["session_id = ?"];
    const params: (string | number)[] = [sessionId];
    if (options.reference) {
      filters.push("reference = ?");
      params.push(options.reference);
    }
    if (options.states?.length) {
      filters.push(`state IN (${options.states.map(() => "?").join(",")})`);
      params.push(...options.states);
    }
    const rows = this.stmt(
      `SELECT * FROM alerts WHERE ${filters.join(" AND ")} ORDER BY created_at DESC, alert_id LIMIT ?`,
    ).all(...params, limit) as Record<string, unknown>[];
    return rows.map(row => this.toAlert(row));
  }

  private toAlert(row: Record<string, unknown>): AlertRecord {
    return {
      alert_id: row.alert_id as string,
      reference: row.reference as string,
      kind: row.kind as AlertKind,
      headline: row.headline as string,
      body: nullable(row.body as string | null),
      state: row.state as AlertState,
      attempts: Number(row.attempts),
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
    };
  }

  // ------------------------------------------------------------------ misc

  /**
   * One row per run of this session, with the number of sources it stored. Feeds
   * the footer status, so its counts survive a reload of the extension.
   */
  async runSummaries(sessionId: string): Promise<{ kind: RunKind; state: RunState; processor?: string; intent: unknown; sources: number }[]> {
    await this.connect();
    const rows = this.stmt(
      `SELECT r.kind, r.state, r.processor, r.intent,
              (SELECT COUNT(*) FROM evidence e WHERE e.reference = r.reference AND e.kind IN ('source','excerpt')) AS sources
       FROM runs r WHERE r.session_id = ?`,
    ).all(sessionId) as { kind: RunKind; state: RunState; processor: string | null; intent: string; sources: number }[];
    return rows.map(row => ({
      kind: row.kind,
      state: row.state,
      processor: nullable(row.processor),
      intent: JSON.parse(row.intent),
      sources: Number(row.sources),
    }));
  }

  async stats(sessionId: string): Promise<StoreStats> {
    await this.connect();
    const evidence = this.stmt(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS chars FROM evidence WHERE session_id = ?`).get(sessionId) as
      | { n: number; chars: number }
      | undefined;
    const runs: Partial<Record<RunState, number>> = {};
    for (const row of this.stmt(`SELECT state, COUNT(*) AS n FROM runs WHERE session_id = ? GROUP BY state`).all(sessionId) as { state: RunState; n: number }[]) {
      runs[row.state] = row.n;
    }
    const alerts: Partial<Record<AlertState, number>> = {};
    for (const row of this.stmt(`SELECT state, COUNT(*) AS n FROM alerts WHERE session_id = ? GROUP BY state`).all(sessionId) as { state: AlertState; n: number }[]) {
      alerts[row.state] = row.n;
    }
    return { evidence: evidence?.n ?? 0, chars: evidence?.chars ?? 0, runs, alerts };
  }

  /**
   * Delete one run and everything derived from it, keeping the search index in
   * step. Retention policy is still undecided; this exists so a later policy
   * has a correct primitive instead of ad-hoc SQL.
   */
  async deleteRun(sessionId: string, reference: string): Promise<{ evidence: number }> {
    await this.connect();
    return this.tx(() => {
      this.requireRun(sessionId, reference);
      const rows = this.stmt(`SELECT id, title, body FROM evidence WHERE reference = ? AND session_id = ?`).all(reference, sessionId) as
        { id: number; title: string | null; body: string }[];
      for (const row of rows) {
        this.stmt(`INSERT INTO evidence_fts (evidence_fts, rowid, title, body) VALUES ('delete', ?, ?, ?)`).run(row.id, row.title ?? "", row.body);
      }
      // Continuations of this run keep their own evidence; only the link to the deleted parent goes.
      this.stmt(`UPDATE runs SET parent = NULL WHERE parent = ? AND session_id = ?`).run(reference, sessionId);
      this.stmt(`DELETE FROM evidence WHERE reference = ? AND session_id = ?`).run(reference, sessionId);
      this.stmt(`DELETE FROM observations WHERE reference = ? AND session_id = ?`).run(reference, sessionId);
      this.stmt(`DELETE FROM alerts WHERE reference = ? AND session_id = ?`).run(reference, sessionId);
      this.stmt(`DELETE FROM runs WHERE reference = ? AND session_id = ?`).run(reference, sessionId);
      return { evidence: rows.length };
    });
  }
}
