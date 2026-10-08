/** Persisted research state. Remote identities never form the public tool interface. */
export type ResearchStatus =
  | "dispatching"
  | "pending"
  | "completed"
  | "failed"
  | "cancelled"
  | "action_required"
  | "uncertain";

export type Effort = "low" | "medium" | "high";

/** Local Pi identity. Search/Extract receive this same ID as contextual session_id. */
export type SessionRecord = {
  session_id: string;
  cwd: string;
  artifact_dir: string;
  created_at: number;
  updated_at: number;
};

/** Small terminal request log; full source text and payloads stay in artifact files. */
export type SearchActivity = {
  reference: string;
  session_id: string;
  kind: "search" | "extract" | "entity";
  query?: string;
  provider_ids?: Partial<Record<"session_id" | "search_id" | "extract_id" | "entity_set_id", string>>;
  status: "completed" | "partial" | "failed" | "uncertain";
  artifact?: string;
  created_at: number;
};

export type SessionGroup = {
  session_id: string;
  group_id?: string;
  status: "initializing" | "ready" | "uncertain";
  owner_pid: number;
  error?: string;
  created_at: number;
  updated_at: number;
  /** Resume position in the group's event stream. Advanced only after the events it covers are durable. */
  event_cursor?: string;
};

/** Synthetic outbound entries for one collector pass, plus an optional cursor to commit with them. */
export type OutboundInput = {
  session_id: string;
  events?: { webhook_id: string; resource_id: string; event_type: string; event: unknown }[];
  cursor?: string;
};

export type ResearchRecord = {
  reference: string;
  session_id: string;
  group_id: string;
  run_id?: string;
  /** Actual provider interaction, never inferred from the group or run ID. */
  interaction_id?: string;
  /** Explicit local research node selected as the parent for this submission. */
  parent?: string;
  query: string;
  effort: Effort;
  domains?: string[];
  status: ResearchStatus;
  artifact_dir: string;
  cwd?: string;
  artifact?: string;
  creation_artifact?: string;
  error?: string;
  created_at: number;
  updated_at: number;
};

export type ConversationRecord = {
  reference: string;
  session_id: string;
  response_id?: string;
  parent?: string;
  status: "completed" | "partial" | "uncertain";
  artifact?: string;
  error?: string;
  created_at: number;
};
