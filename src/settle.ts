import type { MessageView } from "./types.js";

// A message is final when it gets no create or edit for this long.
export const DEFAULT_SETTLE_MS = 8000;

// Quiet timers, one per message. Each create or edit restarts the message's timer.
// When a timer fires, the message is removed from the map and onSettled gets its latest view.
// So the map only holds messages that changed within the last settleMs.
export class SettleTimers {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly settleMs: number,
    private readonly onSettled: (m: MessageView) => void,
  ) {}

  arm(m: MessageView): void {
    const prev = this.timers.get(m.id);
    if (prev !== undefined) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.timers.delete(m.id);
      this.onSettled(m);
    }, this.settleMs);
    this.timers.set(m.id, timer);
  }

  // The message is no longer a candidate (deleted, or edited so that it no longer matches).
  cancel(id: string): void {
    const t = this.timers.get(id);
    if (t === undefined) return;
    clearTimeout(t);
    this.timers.delete(id);
  }

  clear(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
