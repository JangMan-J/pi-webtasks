---
type: glossary
created: 2026-10-28T12:14:36Z
created_by: claude-opus-5-5
created_session: 01a18261-fea9-75ce-b707-233506b1fdd2
updated: 2026-10-28T12:14:36Z
updated_by: claude-opus-5-5
updated_session: 01a18261-fea9-75ce-b707-233506b1fdd2
---

# pi-webtasks

A Pi extension that sends web research requests to Parallel and keeps what comes back in a session-owned local evidence store.

## Language

### Runs

**Run**:
One locally recorded request to Parallel, named by its reference.
_Example_: a `web_search` call recorded as `run_3f9a0c1d2e4b5a67`, kind `search`.
_Not_: a Parallel run id (`trun_…`), which stays inside the store.
_Avoid_: job, record, task (except for a run of kind `task`)
_Confirmed_: 2026-10-28, Jang.

**Recorded paid call**:
A run that is recorded before its request is sent, is sent once without retries, and is settled once.
_Example_: the `web_answer` request to `POST /v1/responses`, through `paid-call.ts`.
_Not_: a status read, a result fetch, or an event stream on an existing run.
_Confirmed_: 2026-10-28, Jang.

**Settle**:
Commit a run's terminal state together with its evidence and its alert.
_Example_: a Task run that Parallel reports `completed` is settled with its report, sources, citations, and one completion alert in one store transaction.
_Not_: binding a provider run id, or a move between non-terminal states.
_Confirmed_: 2026-10-28, Jang.

**Terminal state**:
A run state that nothing moves the run out of once it is committed: `completed`, `failed`, or `cancelled`.
_Example_: a late `running` event for a `completed` run changes nothing.
_Not_: `uncertain`, which is reconciled; `action_required`, which is alerted once and stays watched until Parallel reports a terminal status.
_Confirmed_: 2026-10-28, Jang.

**Uncertain**:
The state of a run that may have reached Parallel but that Parallel has not confirmed.
_Example_: a Task submission whose request timed out; once Parallel reports the run with any status, it is no longer uncertain.
_Not_: failed (a definite rejection, such as a 4xx or a missing key).
_Confirmed_: 2026-10-28, Jang.

**Task run lifecycle**:
The states of a run of kind `task` and the transitions that provider facts cause between them.
_Example_: Parallel reports `running` for an `accepted` run, which becomes `pending` and starts its progress timetable.
_Confirmed_: 2026-10-28, Jang.

**Progress timetable**:
The per-run schedule of progress alerts while a Task run is running, with an interval set by its processor.
_Example_: a `core` run alerts about every 100 seconds (`WEBTASKS_PROGRESS_MS` overrides it).
_Not_: a deadline or a completion percentage.
_Confirmed_: 2026-10-28, Jang.

### What the agent sees

**Receipt**:
The bounded text a tool returns to the agent for one call.
_Example_: the `web_search` result listing sources, their handles, and the context handle, kept under 4200 characters.
_Not_: an alert, which arrives later as a message.
_Confirmed_: 2026-10-28, Jang.

**Evidence**:
One stored item received from Parallel: a report, structured field, finding, source, or excerpt.
_Example_: one excerpt per source returned by a `web_search`.
_Confirmed_: 2026-10-28, Jang.

**Handle**:
The local id of one evidence item, which `web_recall` reads.
_Example_: `ev_9b2e41c07d5a3f18`.
_Not_: a reference, which names a run.
_Confirmed_: 2026-10-28, Jang.
