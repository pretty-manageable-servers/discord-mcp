import { messageLine } from "./format.js";
import type { DiscordPort } from "./port.js";
import type { MessageView } from "./types.js";

export const WATCH_EVENTS = ["new", "edit", "delete"] as const;
export type WatchEvent = (typeof WATCH_EVENTS)[number];

// One message prints at most one edit line per window. The latest text is printed when the window ends.
export const EDIT_WINDOW_MS = 3000;

export interface WatchOptions {
  // Empty or undefined: any channel.
  channelIds?: string[];
  guildId?: string;
  // Empty or undefined: any author.
  fromIds?: string[];
  bots?: "only" | "none";
  contains?: string;
  events: WatchEvent[];
  maxChars?: number;
  untilIdleMs?: number;
  exitAfter?: number;
  json: boolean;
}

export interface WatchRun {
  port: DiscordPort;
  out: (text: string) => void;
  signal?: AbortSignal;
}

// Print state for one message. Exists while the message is inside its edit window.
interface Track {
  content: string;
  timer: ReturnType<typeof setTimeout>;
  pending?: MessageView;
}

// Streams gateway events as lines until the process is stopped, the idle time passes,
// or the event count is reached. Resolves when it stops. The caller closes the port.
export function runWatch(opts: WatchOptions, run: WatchRun): Promise<void> {
  const { port, out, signal } = run;
  const wanted = new Set<string>(opts.events);
  const channels = opts.channelIds?.length ? new Set(opts.channelIds) : null;
  const froms = opts.fromIds?.length ? new Set(opts.fromIds) : null;

  return new Promise<void>((resolve) => {
    let done = false;
    let printedCount = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const tracks = new Map<string, Track>();
    const unsubscribes: (() => void)[] = [];

    function inScope(m: MessageView): boolean {
      if (channels && !channels.has(m.channelId) && !(m.threadId !== null && channels.has(m.threadId))) return false;
      if (opts.guildId !== undefined && m.guildId !== opts.guildId) return false;
      if (froms && !froms.has(m.authorId)) return false;
      if (opts.bots === "only" && !m.authorIsBot) return false;
      if (opts.bots === "none" && m.authorIsBot) return false;
      if (opts.contains !== undefined && !m.content.includes(opts.contains)) return false;
      return true;
    }

    function finish(): void {
      if (done) return;
      done = true;
      clearTimeout(idleTimer);
      for (const t of tracks.values()) clearTimeout(t.timer);
      tracks.clear();
      for (const off of unsubscribes) off();
      signal?.removeEventListener("abort", finish);
      resolve();
    }

    // Prints one event line. Counts the event for --exit-after and restarts the --until-idle timer.
    function printEvent(kind: "new" | "edit" | "delete", m: MessageView | null, ref: { channelId: string; id: string }): void {
      if (opts.json) {
        const body = kind === "delete" ? { event: kind, channelId: ref.channelId, id: ref.id } : { event: kind, message: m };
        out(`${JSON.stringify(body)}\n`);
      } else if (kind === "delete") {
        out(`delete ${ref.id}\n`);
      } else {
        out(`${kind} ${messageLine(m as MessageView, opts.maxChars)}\n`);
      }
      printedCount++;
      if (opts.exitAfter !== undefined && printedCount >= opts.exitAfter) {
        finish();
        return;
      }
      restartIdle();
    }

    function printStatus(status: "reconnecting" | "ready"): void {
      if (done) return;
      out(opts.json ? `${JSON.stringify({ status })}\n` : `status ${status}\n`);
    }

    function restartIdle(): void {
      if (opts.untilIdleMs === undefined) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, opts.untilIdleMs);
    }

    function startTrack(m: MessageView): void {
      tracks.set(m.id, { content: m.content, timer: setTimeout(() => windowEnd(m.id), EDIT_WINDOW_MS) });
    }

    // The window for a message ended. Print its latest pending text, or forget the message.
    function windowEnd(id: string): void {
      const t = tracks.get(id);
      if (!t || done) return;
      const pending = t.pending;
      if (!pending) {
        tracks.delete(id);
        return;
      }
      t.pending = undefined;
      if (pending.content !== t.content) {
        t.content = pending.content;
        printEvent("edit", pending, { channelId: pending.channelId, id });
        if (done) return;
      }
      t.timer = setTimeout(() => windowEnd(id), EDIT_WINDOW_MS);
    }

    function onNew(m: MessageView): void {
      if (done || !wanted.has("new") || !inScope(m)) return;
      printEvent("new", m, { channelId: m.channelId, id: m.id });
      if (!done) startTrack(m);
    }

    function onEdit(m: MessageView): void {
      if (done || !wanted.has("edit") || !inScope(m)) return;
      const t = tracks.get(m.id);
      if (!t) {
        printEvent("edit", m, { channelId: m.channelId, id: m.id });
        if (!done) startTrack(m);
        return;
      }
      // Inside the window: keep only the latest text. Back to the printed text means nothing to print.
      t.pending = m.content === t.content ? undefined : m;
    }

    function onDelete(ref: { channelId: string; id: string }): void {
      // The gateway delete event has only the channel and message ids, so only --channel applies to it.
      if (done || !wanted.has("delete")) return;
      if (channels && !channels.has(ref.channelId)) return;
      const t = tracks.get(ref.id);
      if (t) {
        clearTimeout(t.timer);
        tracks.delete(ref.id);
      }
      printEvent("delete", null, ref);
    }

    if (signal?.aborted) {
      done = true;
      resolve();
      return;
    }
    signal?.addEventListener("abort", finish, { once: true });

    unsubscribes.push(
      port.onMessage(onNew),
      port.onMessageUpdate(onEdit),
      port.onMessageDelete(onDelete),
      port.onStatus(printStatus),
    );
    printStatus("ready");
    restartIdle();
  });
}
