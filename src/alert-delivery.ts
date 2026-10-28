/**
 * Alert delivery: hands the session's stored alerts to the agent, at least once.
 *
 * Alerts are written by the store: a completion commits its alert in the same
 * transaction as its evidence, and progress alerts are queued on their
 * schedule. This module owns everything after that:
 *
 *  - Draining: claim waiting alerts (failures and attention first, then
 *    completions, then progress), hand each to the sink, mark it delivered.
 *    Wake-ups coalesce: one drain runs at a time, and a wake-up during a drain
 *    makes it look again before it goes idle.
 *  - A failed hand-off is not delivery: the alert stays claimed and the next
 *    wake-up offers it again.
 *  - Delivered is not received: an alert stays open until the agent reads its
 *    run (`received`), and a new runtime offers every unacknowledged alert
 *    again (`start`). Duplicates are possible; silence is not.
 *  - Nothing is handed over before `start` or after `stop`, and `stop` waits
 *    for a running drain, so the store is never closed under it.
 */

import type { AlertRecord, ResearchStore } from "./store.ts";

/** Hands one alert to the agent. Throwing means it was not handed over. */
export type AlertSink = (alert: AlertRecord) => void | Promise<void>;

type Options = {
  store: ResearchStore;
  sessionId: string;
  deliver: AlertSink;
  /** Reports a failed hand-off or an unavailable store. Delivery itself never throws. */
  onError?: (err: unknown) => void;
};

/** Alerts claimed per pass. */
const BATCH = 5;
/** Passes per drain; anything left waits for the next wake-up. */
const MAX_PASSES = 20;

export function createAlertDelivery(options: Options) {
  const { store, sessionId, deliver } = options;
  const report = options.onError ?? (() => undefined);
  /** The takeover and first drain; set once by `start`. */
  let startup: Promise<void> | undefined;
  let started = false;
  let stopped = false;
  let draining = false;
  /** A wake-up arrived during the running drain: look once more before going idle. */
  let again = false;
  let current: Promise<void> = Promise.resolve();

  async function drain(): Promise<void> {
    try {
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        if (stopped) return;
        again = false;
        const batch = await store.claimAlerts(sessionId, { limit: BATCH });
        if (!batch.length) {
          if (again) continue;
          return;
        }
        for (const alert of batch) {
          if (stopped) return;
          try {
            await deliver(alert);
          } catch (err) {
            // Not marked delivered: the alert stays claimed and the next wake-up offers it again.
            report(err);
            return;
          }
          // Unmarked, it is offered again: a duplicate, never a loss.
          await store.markAlertDelivered(sessionId, alert.alert_id).catch(() => undefined);
        }
      }
    } catch (err) {
      report(err);
    } finally {
      // Cleared in the same step as the last check of `again`, so no wake-up falls between them.
      draining = false;
    }
  }

  /**
   * Something may be waiting: drain it, or make the running drain look again.
   * Resolves when that drain is idle. Never rejects.
   */
  function wake(): Promise<void> {
    if (!started || stopped) return current;
    if (draining) {
      again = true;
      return current;
    }
    draining = true;
    current = drain();
    return current;
  }

  /**
   * Take over delivery for this session: what an earlier runtime handed over
   * but never saw read is offered again, then everything waiting is drained.
   * Wake-ups before this are covered by its drain.
   */
  function start(): Promise<void> {
    if (stopped) return Promise.resolve();
    startup ??= (async () => {
      await store.requeueUnacknowledgedAlerts(sessionId).catch(report);
      if (stopped) return;
      started = true;
      await wake();
    })();
    return startup;
  }

  /** The agent read this run's evidence: its alerts were received and are not offered again. */
  async function received(reference: string): Promise<void> {
    await store.acknowledgeRunAlerts(sessionId, reference).catch(() => undefined);
  }

  /** Hand nothing more over, and wait for a running takeover or drain to finish. */
  async function stop(): Promise<void> {
    stopped = true;
    await startup;
    await current;
  }

  return { start, wake, received, stop };
}

export type AlertDelivery = ReturnType<typeof createAlertDelivery>;
