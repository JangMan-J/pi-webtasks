/** Runtime-local results: web sources/entities, interactive answers, deep report sources. */
import type { Effort, ResearchEffort } from "./research-types.ts";

type Lane = "web" | "interactive" | "deep";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const color = (code: number, text: string) => `\x1b[38;5;${code}m${text}\x1b[0m`;

// Published list prices, USD millionths. Credits and negotiated rates are not deducted.
// https://parallel.ai/pricing ; https://docs.parallel.ai/resources/pricing
const SEARCH_PRICE: Record<Effort, number> = { low: 1_000, medium: 5_000, high: 5_000 };
const RESPONSE_PRICE: Record<Effort, number> = { low: 10_000, medium: 50_000, high: 250_000 };
const DEEP_PRICE: Record<Effort, number> = { low: 25_000, medium: 100_000, high: 600_000 };

export function webEstimate(kind: "search" | "extract" | "entity", effort: Effort, requested: number, received: number): number {
  if (kind === "extract") return requested * 1_000;
  if (kind === "entity") return 5_000 + Math.max(0, received - 100) * 50;
  return SEARCH_PRICE[effort] + Math.max(0, received - 10) * 1_000;
}

export const responseEstimate = (effort: Effort): number => RESPONSE_PRICE[effort];

export class SearchStatus {
  private readonly setStatus: (text: string | undefined) => void;
  private readonly counts: Record<Lane, number> = { web: 0, interactive: 0, deep: 0 };
  private readonly active: Record<Lane, number> = { web: 0, interactive: 0, deep: 0 };
  private readonly received = new Set<string>();
  private microdollars = 0;
  private unpriced = false;
  private pendingDeep = 0;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(setStatus: (text: string | undefined) => void) {
    this.setStatus = setStatus;
    this.render();
  }

  begin(lane: Lane): () => void {
    if (this.closed) return () => {};
    this.active[lane]++;
    this.render();
    let ended = false;
    return () => {
      if (ended || this.closed) return;
      ended = true;
      this.active[lane]--;
      this.render();
    };
  }

  add(lane: "web" | "interactive", count: number, microdollars = 0): void {
    if (this.closed) return;
    this.counts[lane] += count;
    this.microdollars += microdollars;
    this.render();
  }

  deepReceived(reference: string, effort: ResearchEffort, sources: number): void {
    if (this.closed || this.received.has(reference)) return;
    this.received.add(reference);
    this.counts.deep += sources;
    if (effort === "custom") this.unpriced = true;
    else this.microdollars += DEEP_PRICE[effort];
    this.render();
  }

  setDeepPending(count: number): void {
    if (this.closed) return;
    this.pendingDeep = count;
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
    const busy = this.active.web + this.active.interactive + this.active.deep + this.pendingDeep > 0;
    if (busy && !this.timer) {
      this.timer = setInterval(() => { this.frame = (this.frame + 1) % FRAMES.length; this.render(); }, 120);
      this.timer.unref?.();
    } else if (!busy && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.frame = 0;
    }
    const marker = FRAMES[this.frame];
    const dollars = this.microdollars / 1_000_000;
    const roundedDollars = Math.round(dollars);
    const cents = Math.round(this.microdollars / 10_000);
    const cost = cents === 0 ? "0"
      : dollars < 10 ? (Math.min(cents, 999) / 100).toFixed(2)
      : roundedDollars < 1_000 ? String(roundedDollars)
      : new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 }).format(dollars);
    this.setStatus([
      color(39, ` ${this.counts.web}${this.active.web ? marker : ""}`),
      color(141, ` ${this.counts.interactive}${this.active.interactive ? marker : ""}`),
      color(214, ` ${this.counts.deep}${this.active.deep || this.pendingDeep ? marker : ""}`),
      color(82, ` ${cost}${this.unpriced ? "+?" : ""}${busy ? marker : ""}`),
    ].join("  "));
  }
}
