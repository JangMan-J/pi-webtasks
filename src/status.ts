/**
 * Footer status for the web tools, shown through `ctx.ui.setStatus("webtasks", ...)`.
 * Footer extensions (zentui, starship, powerline) render extension statuses, so this is
 * the whole integration. It is for the user, never the agent.
 *
 * Four lanes, each a Nerd Font icon and a count; a spinner frame follows a lane while it
 * works:
 *   web sources (web_search, web_fetch) · answers (web_answer) ·
 *   research sources (web_research, spinning while a run is in progress) ·
 *   estimated spend at published list prices.
 *
 * Counts come from the session's stored runs, so they survive a reload. The spend is an
 * estimate, not a bill: credits and negotiated rates are not deducted, and a run whose
 * outcome is unknown is shown as "+?".
 */

import { OPEN_RUN_STATES, type RunKind, type RunState } from "./store.ts";

export type StatusLane = "web" | "answer" | "research";

export type RunSummary = { kind: RunKind; state: RunState; processor?: string; intent: unknown; sources: number };

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ICON = { web: "\u{F002}", answer: "\u{F27A}", research: "\u{F02D}", spend: "\u{F0D6}" };
const COLOR = { web: 39, answer: 141, research: 214, spend: 82 };
const color = (code: number, text: string) => `\x1b[38;5;${code}m${text}\x1b[0m`;

// Published list prices in USD millionths (https://docs.parallel.ai/getting-started/pricing).
const SEARCH_PRICE: Record<string, number> = { turbo: 1_000, fast: 1_000, basic: 5_000, advanced: 5_000 };
const EXTRA_RESULT_PRICE = 1_000;
const EXTRACT_PRICE_PER_URL = 1_000;
const ANSWER_PRICE: Record<string, number> = { low: 10_000, medium: 50_000, high: 250_000 };
const TASK_PRICE: Record<string, number> = { core: 25_000, core2x: 50_000, pro: 100_000, ultra: 300_000, ultra2x: 600_000 };

export type StatusTotals = {
  counts: Record<StatusLane, number>;
  microdollars: number;
  /** Some spend cannot be priced yet: an outcome is unknown, or a price is not published. */
  unpriced: boolean;
  researchInProgress: number;
};

/** Fold the session's runs into the footer's counts and estimated spend. Pure, for tests. */
export function statusTotals(runs: RunSummary[]): StatusTotals {
  const totals: StatusTotals = { counts: { web: 0, answer: 0, research: 0 }, microdollars: 0, unpriced: false, researchInProgress: 0 };
  for (const run of runs) {
    const intent = (run.intent ?? {}) as { mode?: string; urls?: unknown[]; effort?: string };
    // A Task run is only billed when it completes; an open run may still complete.
    if (run.kind === "task" && OPEN_RUN_STATES.has(run.state)) totals.researchInProgress++;
    if (run.state === "uncertain") totals.unpriced = true;
    if (run.state !== "completed") continue;
    if (run.kind === "search") {
      totals.counts.web += run.sources;
      const price = SEARCH_PRICE[intent.mode ?? "basic"];
      if (price === undefined) totals.unpriced = true;
      else totals.microdollars += price + Math.max(0, run.sources - 10) * EXTRA_RESULT_PRICE;
    } else if (run.kind === "extract") {
      totals.counts.web += run.sources;
      totals.microdollars += (Array.isArray(intent.urls) ? intent.urls.length : 1) * EXTRACT_PRICE_PER_URL;
    } else if (run.kind === "answer") {
      totals.counts.answer += 1;
      const price = ANSWER_PRICE[intent.effort ?? "medium"];
      if (price === undefined) totals.unpriced = true;
      else totals.microdollars += price;
    } else if (run.kind === "task") {
      totals.counts.research += run.sources;
      const price = TASK_PRICE[run.processor ?? "core"];
      if (price === undefined) totals.unpriced = true;
      else totals.microdollars += price;
    }
  }
  return totals;
}

/** Dollars in at most four characters: 0, 0.42, 7.10, 38, 412, 1.2K. */
export function formatSpend(microdollars: number): string {
  const dollars = microdollars / 1_000_000;
  const cents = Math.round(microdollars / 10_000);
  if (cents === 0) return "0";
  if (dollars < 10) return (Math.min(cents, 999) / 100).toFixed(2);
  if (Math.round(dollars) < 1_000) return String(Math.round(dollars));
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 }).format(dollars);
}

export class WebtasksStatus {
  private readonly setStatus: (text: string | undefined) => void;
  private readonly load: () => Promise<RunSummary[]>;
  private readonly active: Record<StatusLane, number> = { web: 0, answer: 0, research: 0 };
  private totals: StatusTotals = statusTotals([]);
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(setStatus: (text: string | undefined) => void, load: () => Promise<RunSummary[]>) {
    this.setStatus = setStatus;
    this.load = load;
    this.render();
  }

  /** Mark a lane busy while a tool call runs; the returned function ends it once. */
  begin(lane: StatusLane): () => void {
    if (this.closed) return () => undefined;
    this.active[lane]++;
    this.render();
    let ended = false;
    return () => {
      if (ended || this.closed) return;
      ended = true;
      this.active[lane]--;
      void this.refresh();
    };
  }

  /** Re-read the session's runs. Never throws: a footer must not break a tool call. */
  async refresh(): Promise<void> {
    if (this.closed) return;
    try {
      this.totals = statusTotals(await this.load());
    } catch {
      /* keep the last totals */
    }
    this.render();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.setStatus(undefined);
  }

  private render(): void {
    if (this.closed) return;
    const researching = this.active.research + this.totals.researchInProgress > 0;
    const busy = this.active.web + this.active.answer > 0 || researching;
    if (busy && !this.timer) {
      this.timer = setInterval(() => { this.frame = (this.frame + 1) % FRAMES.length; this.render(); }, 120);
      this.timer.unref?.();
    } else if (!busy && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.frame = 0;
    }
    const marker = FRAMES[this.frame];
    const { counts } = this.totals;
    this.setStatus([
      color(COLOR.web, `${ICON.web} ${counts.web}${this.active.web ? marker : ""}`),
      color(COLOR.answer, `${ICON.answer} ${counts.answer}${this.active.answer ? marker : ""}`),
      color(COLOR.research, `${ICON.research} ${counts.research}${researching ? marker : ""}`),
      color(COLOR.spend, `${ICON.spend} ${formatSpend(this.totals.microdollars)}${this.totals.unpriced ? "+?" : ""}${busy ? marker : ""}`),
    ].join("  "));
  }
}
