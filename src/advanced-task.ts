import { Type } from "typebox";
import { Check } from "typebox/value";
import { submitTrackedTask, type CallContext, type ResearchSession, type TrackedTask } from "./research.ts";

const jsonObject = Type.Record(Type.String(), Type.Unknown());
const nullableText = Type.Union([Type.String(), Type.Null()]);
const schema = Type.Union([Type.String(), jsonObject]);

/** Native RunInput fields; provider-specific nested schema semantics remain with the provider. */
export const ADVANCED_TASK_PARAMETERS = Type.Object({
  label: Type.String({ minLength: 1, pattern: "\\S", description: "Short task label saved with the local research reference." }),
  task: Type.Unsafe<TrackedTask["task"]>(Type.Object({
    input: Type.Union([Type.String({ minLength: 1, pattern: "\\S" }), jsonObject]),
    processor: Type.String({ minLength: 1, pattern: "^\\S+$" }),
    task_spec: Type.Optional(Type.Union([Type.Object({
      output_schema: schema,
      input_schema: Type.Optional(Type.Union([schema, Type.Null()])),
    }, { additionalProperties: false }), Type.Null()])),
    source_policy: Type.Optional(Type.Union([Type.Object({
      include_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
      exclude_domains: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
      after_date: Type.Optional(nullableText),
    }, { additionalProperties: false }), Type.Null()])),
    advanced_settings: Type.Optional(Type.Union([Type.Object({
      location: Type.Optional(nullableText),
    }, { additionalProperties: false }), Type.Null()])),
    enable_events: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
    mcp_servers: Type.Optional(Type.Union([Type.Array(Type.Object({
      name: Type.String(),
      url: Type.String(),
      type: Type.Optional(Type.Literal("url")),
      allowed_tools: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
      headers: Type.Optional(Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()])),
    }, { additionalProperties: false })), Type.Null()])),
    memory_scope_key: Type.Optional(nullableText),
    previous_interaction_id: Type.Optional(nullableText),
    metadata: Type.Optional(Type.Union([
      Type.Record(Type.String(), Type.Union([Type.String({ maxLength: 512 }), Type.Number(), Type.Boolean()])),
      Type.Null(),
    ])),
  }, { additionalProperties: false, description: "Parallel SDK RunInput. Supply input and processor. Webhooks and webtasks_* metadata belong to the extension." })),
  betas: Type.Optional(Type.Array(Type.String({ minLength: 1, pattern: "^[^\\r\\n,]+$" }), { description: "Explicit Parallel beta headers, when required by the selected SDK features." })),
}, { additionalProperties: false });

export async function advancedTask(ctx: CallContext, session: ResearchSession, args: Record<string, unknown>) {
  // The exported entry point has the same validation as calls through Pi.
  if (!Check(ADVANCED_TASK_PARAMETERS, args)) throw new Error("Invalid advanced task: provide label, task.input, task.processor, and supported SDK fields; task.webhook is not allowed");
  const { label, task, betas } = args;
  const policy = task.source_policy;
  if ((policy?.include_domains?.length ?? 0) + (policy?.exclude_domains?.length ?? 0) > 200) {
    throw new Error("source_policy supports at most 200 domains in total");
  }
  if (Object.keys(task.metadata ?? {}).some(key => key.length > 16)) throw new Error("Task metadata keys must be at most 16 characters");
  const result = await submitTrackedTask(ctx, session, { label, task, betas });
  if (result.state !== "accepted") {
    throw new Error(`Research: ${result.reference}\nSubmission ${result.state === "uncertain" ? "outcome uncertain; do not resubmit" : "not accepted"}.${result.error ? ` ${result.error}` : ""}`);
  }
  return {
    text: `Research: ${result.reference}\nAccepted. A notification arrives when the task completes. Continue other work; do not poll or resubmit.\nRead the result with deep_search { research: "${result.reference}" }.`,
    details: { research: result.reference, status: "pending" },
  };
}
