/**
 * pi-webtasks: session-bound web research for Pi.
 *
 * The extension owns transport, the local evidence store, indexing, recovery,
 * and alert delivery. The model owns the research work: what to search, what to
 * read, and what to ask. Nothing here exposes SQL, provider ids, or file paths.
 *
 * Collection runs inside Pi. There is no webhook, no callback receiver, and no
 * artifact file: received evidence is committed to a local SQLite store owned by
 * the Pi session. If Pi closes, collection stops; the next session start
 * reconciles provider state where retention permits.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { formatError, researchClient, type StoredKey } from "./ops.ts";
import { PARALLEL_PROVIDER_ID, parallelProvider } from "./provider.ts";
import { ResearchStore } from "./store.ts";
import { createResearchService, type ResearchService } from "./research-service.ts";
import { createRecallService, type RecallService } from "./recall.ts";
import { createTaskService, type TaskService } from "./task-service.ts";
import { createAnswerService, type AnswerService } from "./answer-service.ts";
import { registerResearchTools, type ResearchServices } from "./research-tools.ts";
import { WebtasksStatus } from "./status.ts";

/** Optional explicit store directory. */
const WEBTASKS_DIR_ENV = "WEBTASKS_DIR";

/** Explicitly configured store directory. */
function configuredStoreDir(): string | undefined {
  const dir = process.env[WEBTASKS_DIR_ENV];
  return dir && dir.trim() ? dir : undefined;
}

/** Research evidence lives in WEBTASKS_DIR when set, else `<agent-dir>/webtasks`. */
function storeDirectory(): string {
  return configuredStoreDir() ?? join(getAgentDir(), "webtasks");
}

/** Everything owned by one started Pi session. A reload or session switch builds a new one. */
type Runtime = {
  sessionId: string;
  store: ResearchStore;
  research: ResearchService;
  recall: RecallService;
  task: TaskService;
  answer: AnswerService;
  /** Footer status (TUI only): web, answer, and research counts with estimated spend. */
  status?: WebtasksStatus;
  released: boolean;
  draining: boolean;
  /** An alert arrived while a drain was running; drain again before going idle. */
  redrain: boolean;
};

export default function piWebtasks(pi: ExtensionAPI) {
  let rt: Runtime | undefined;

  // Registered like any provider. /login lists it under "Sign in with an API key".
  pi.registerProvider(parallelProvider());

  async function stopRuntime(): Promise<void> {
    const outgoing = rt;
    if (!outgoing) return;
    // Mark the runtime unusable first: nothing may write to a store that is closing.
    outgoing.released = true;
    if (rt === outgoing) rt = undefined;
    outgoing.status?.close();
    await outgoing.task.stop().catch(() => undefined);
    await outgoing.store.close().catch(() => undefined);
  }

  function currentServices(): ResearchServices {
    if (!rt || rt.released) throw new Error("Research tools are unavailable: the session is not started");
    return { research: rt.research, recall: rt.recall, task: rt.task, answer: rt.answer, status: rt.status };
  }

  /**
   * Hand pending alerts to Pi as follow-ups. An idle session wakes; a busy one
   * receives them after its current work. Delivery is at-least-once: an alert
   * stays `delivered` until the agent reads the run, and a new runtime requeues
   * anything unacknowledged.
   */
  async function drainAlerts(ctx: ExtensionContext): Promise<void> {
    const owner = rt;
    if (!owner || owner.released) return;
    if (owner.draining) {
      // The running drain may already have seen an empty queue; make it look once more.
      owner.redrain = true;
      return;
    }
    owner.draining = true;
    try {
      for (let pass = 0; pass < 20; pass++) {
        if (!rt || rt !== owner || owner.released) return;
        owner.redrain = false;
        const alerts = await owner.store.claimAlerts(owner.sessionId, { limit: 5 });
        if (!alerts.length) {
          if (owner.redrain) continue;
          return;
        }
        for (const alert of alerts) {
          if (!rt || rt !== owner || owner.released) return;
          const text = [alert.headline, alert.body].filter((line): line is string => Boolean(line)).join("\n");
          try {
            if (ctx.hasUI) ctx.ui.notify(text, alert.kind === "completion" ? "info" : "warning");
            pi.sendMessage(
              { customType: "webtasks-research", content: text, display: true, details: { alert_id: alert.alert_id, reference: alert.reference, kind: alert.kind } },
              { deliverAs: "followUp", triggerTurn: true },
            );
          } catch (err) {
            // Not marked delivered: the next pass or runtime offers it again.
            if (ctx.hasUI) ctx.ui.notify(`pi-webtasks: alert delivery failed: ${formatError(err)}`, "warning");
            return;
          }
          await owner.store.markAlertDelivered(owner.sessionId, alert.alert_id).catch(() => undefined);
        }
      }
    } finally {
      owner.draining = false;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await stopRuntime();
    const sessionId = ctx.sessionManager.getSessionId();
    // The stored login for this provider, read on every request. Nothing about the key is cached here.
    const modelRegistry = ctx.modelRegistry;
    const storedKey: StoredKey = async () => (await modelRegistry?.getApiKeyForProvider(PARALLEL_PROVIDER_ID)) ?? undefined;

    let store: ResearchStore;
    try {
      store = await new ResearchStore(storeDirectory()).init();
    } catch (err) {
      if (ctx.hasUI) ctx.ui.notify(`pi-webtasks: research store unavailable: ${formatError(err)}`, "warning");
      return;
    }
    try {
      await store.registerSession(sessionId);
      // A request interrupted by a crash or a close has no recovery path here: mark it
      // uncertain instead of leaving it silently unfinished. Best effort.
      await store.reconcileInterrupted(sessionId).catch(() => undefined);
      // A new runtime owns delivery: previously handed-off but unacknowledged alerts
      // are offered again rather than lost with the old process.
      await store.requeueUnacknowledgedAlerts(sessionId).catch(() => undefined);
    } catch (err) {
      if (ctx.hasUI) ctx.ui.notify(`pi-webtasks: research store unavailable: ${formatError(err)}`, "warning");
      await store.close().catch(() => undefined);
      return;
    }

    const model = ctx.model as { provider?: string; id?: string } | undefined;
    const client = async () => await researchClient(storedKey);
    const runtime: Runtime = {
      sessionId,
      store,
      research: createResearchService({
        store,
        sessionId,
        client,
        clientModel: model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined,
      }),
      recall: createRecallService({ store, sessionId }),
      task: createTaskService({
        store,
        sessionId,
        client,
        onAlerts: () => {
          // Progress and completion change what the footer shows: runs in progress, sources, spend.
          void runtime.status?.refresh();
          void drainAlerts(ctx).catch(err => {
            if (ctx.hasUI) ctx.ui.notify(`pi-webtasks: alert delivery failed: ${formatError(err)}`, "warning");
          });
        },
        log: message => { if (ctx.hasUI) ctx.ui.notify(`pi-webtasks: ${message}`, "warning"); },
        // Testing aid: shorten the progress sweep without changing the default.
        ...(Number(process.env.WEBTASKS_SWEEP_MS) >= 500 ? { sweepMs: Number(process.env.WEBTASKS_SWEEP_MS) } : {}),
      }),
      answer: createAnswerService({ store, sessionId, client }),
      released: false,
      draining: false,
      redrain: false,
    };
    rt = runtime;
    if (ctx.hasUI && ctx.mode === "tui") {
      runtime.status = new WebtasksStatus(text => ctx.ui.setStatus("webtasks", text), () => store.runSummaries(sessionId));
      void runtime.status.refresh();
    }
    runtime.task.start();
    // A new runtime owns delivery: offer anything left unacknowledged right away.
    void drainAlerts(ctx).catch(() => undefined);
    // Reconcile in the background: a settled run must not delay session start.
    void runtime.task.reconcile().then(() => runtime.status?.refresh()).catch(err => {
      if (ctx.hasUI) ctx.ui.notify(`pi-webtasks: research reconciliation failed: ${formatError(err)}`, "warning");
    });
  });

  pi.on("session_shutdown", async () => {
    await stopRuntime();
  });

  // Discovery, reading, recall, background research, and answers resolve the store
  // through the current runtime, not a captured one.
  registerResearchTools(pi, currentServices);
}
