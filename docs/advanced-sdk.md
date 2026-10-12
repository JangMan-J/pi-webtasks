# Advanced Task submission

When the ordinary research tools cannot express the required Task options, use `webtasks_submit`.
Examples include a JSON output schema, structured input, exclusion filters, location, or an explicit processor.
Prefer `deep_search` for a cited report with ordinary effort and domain controls.

## Submit through codemode

This tool requires Pi 1.1 or later with codemode enabled.
It accepts one Task per call and returns text with a local `research_…` reference.
The tool uses the current Pi session and its Parallel credentials.
The Parallel API key is not a tool argument.

```js
text(await tools.webtasks_submit({
  label: "SQLite release facts",
  task: {
    input: "Find the latest stable SQLite release and its release date. Cite official sources.",
    processor: "core",
    task_spec: {
      output_schema: {
        type: "json",
        json_schema: {
          type: "object",
          properties: {
            version: { type: "string" },
            release_date: { type: "string" },
            report: { type: "string" }
          },
          required: ["version", "release_date", "report"],
          additionalProperties: false
        }
      }
    },
    source_policy: { include_domains: ["sqlite.org"] }
  }
}));
```

Retain the returned reference.
Continue other work until the completion notification arrives.
Then read the result without another submission:

```js
text(await tools.deep_search({ research: "research_<returned UUID>" }));
```

The saved artifact contains the complete output and citation basis.
The readable preview supports text and JSON content.
A result read does not generate a different output format.

## SDK fields

`task` follows `RunInput` from `parallel-web@1.3.3`.
`label` is a local description, not a substitute for `task.input`.

| Field | Contract |
| --- | --- |
| `input` | Nonblank text or a JSON object. |
| `processor` | An explicit processor name. The extension does not escalate or substitute it. |
| `task_spec` | Native input and output schemas. An omitted specification uses the provider default. |
| `source_policy` | Include/exclude domains and `after_date`. At most 200 domains in total. |
| `advanced_settings` | Native location settings. |
| `enable_events` | Provider progress recording. The extension still collects completion through group events. |
| `mcp_servers` | Native server definitions and tool allowlists. Use only endpoints appropriate for the task data. |
| `memory_scope_key` | Explicit provider memory scope. A session group does not imply memory isolation. |
| `previous_interaction_id` | Explicit provider context. This field takes a remote identity, not a local research reference. |
| `metadata` | User metadata. Keys are at most 16 characters. The `webtasks_` prefix is reserved. |
| `betas` | Top-level array beside `label` and `task`. It sets explicit Parallel beta headers. |

The extension validates field shapes and ownership restrictions before submission.
Parallel validates nested schema semantics and processor availability.
The extension controls the webhook, group, ownership metadata, and stream cursor.
It rejects `task.webhook`, unknown task fields, and reserved metadata.

Known processors `core`, `pro`, and `ultra2x` retain the ordinary local estimates.
Other processors mark the status subtotal with `+?`, which indicates an unknown additional amount.

## Completion and recovery

Both `deep_search` and `webtasks_submit` use `submitTrackedTask` in `src/research.ts`.
This helper records intent before the submission request.
It adds the Task to the session group and binds the returned run ID to the local reference.
It then wakes the existing collector.
The stream and snapshot recovery feed the existing inbox and notify only the owning session.

If the submission outcome is uncertain, retain the reference from the error.
Do not repeat that submission.
A later snapshot can recover the run through its ownership metadata.
Session shutdown cancels local waits, not the remote Task.
When the owning session starts again, collection resumes.
The optional webhook receiver can save results while Pi is closed.

## Direct SDK scripts

Standalone Node scripts do not attach to this session automatically.
They do not inherit Pi's stored login, local references, or completion notifications.
`PARALLEL_API_KEY` is the SDK environment variable.
Use the in-session `webtasks_submit` tool for tracked background Tasks.

This helper does not attach arbitrary existing runs or intercept SDK calls.
Synchronous Search/Extract calls, FindAll jobs, and Monitors remain outside this Task submission interface.
No new listener or daemon is required.

## References

- [Parallel TypeScript SDK](https://github.com/parallel-web/parallel-sdk-typescript)
- [Parallel API documentation](https://docs.parallel.ai)
- [Task Groups](https://docs.parallel.ai/task-api/group-api)
- [Local interface mapping](api-mapping.md)
- Installed SDK declarations: `parallel-web/resources/task-run` (`RunInput`, `TaskSpec`) and `parallel-web/resources/task-group` (`TaskGroupAddRunsParams`).
