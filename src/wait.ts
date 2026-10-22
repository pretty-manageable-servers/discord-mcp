import { ToolError } from "./errors.js";
import type { DiscordPort } from "./port.js";
import { SettleTimers } from "./settle.js";
import type { MessageView } from "./types.js";

export interface FinalOptions {
  settleMs: number;
  // A match whose latest text matches this is not returned yet. Use a regex without the g flag.
  ignoreProgress?: RegExp;
}

export interface WaitOptions {
  channelId: string;
  after?: string;
  from: "bots" | "humans" | "all" | string[];
  toMe: boolean;
  // Only messages whose text includes this string.
  contains?: string;
  timeoutMs: number;
  selfId: string;
  selfNames: string[];
  signal?: AbortSignal;
  // Set: return the first match that goes quiet (is final), not the first match.
  final?: FinalOptions;
}

function fromOk(m: MessageView, from: WaitOptions["from"]): boolean {
  if (from === "all") return true;
  if (from === "bots") return m.authorIsBot;
  if (from === "humans") return !m.authorIsBot;
  return from.includes(m.authorId);
}

function isToMe(m: MessageView, o: WaitOptions): boolean {
  const to = m.agentMsg?.to?.toLowerCase();
  if (to !== undefined && o.selfNames.some((n) => n.toLowerCase() === to)) return true;
  return m.content.includes(`<@${o.selfId}>`) || m.content.includes(`<@!${o.selfId}>`);
}

// True when m is a message the waiter should return.
export function matches(m: MessageView, o: WaitOptions): boolean {
  if (m.channelId !== o.channelId && m.threadId !== o.channelId) return false;
  if (m.authorId === o.selfId) return false;
  if (!fromOk(m, o.from)) return false;
  if (o.toMe && !isToMe(m, o)) return false;
  if (o.contains !== undefined && !m.content.includes(o.contains)) return false;
  if (o.after !== undefined && BigInt(m.id) <= BigInt(o.after)) return false;
  return true;
}

function oldest(list: MessageView[]): MessageView {
  return list.reduce((a, b) => (BigInt(b.id) < BigInt(a.id) ? b : a));
}

const PAGE_SIZE = 100;
const MAX_BACKLOG_PAGES = 10;

// Reads the backlog page by page, oldest first. Returns the matches: the first one only,
// unless `all` is set. Stops early when stopped() is true.
async function readBacklog(
  discord: DiscordPort,
  o: WaitOptions,
  stopped: () => boolean,
  all: boolean,
): Promise<MessageView[]> {
  const hits: MessageView[] = [];
  let after = o.after;
  for (let page = 0; page < MAX_BACKLOG_PAGES && !stopped(); page++) {
    const msgs = await discord.readMessages(o.channelId, { limit: PAGE_SIZE, after });
    for (const m of msgs) {
      if (!matches(m, o)) continue;
      hits.push(m);
      if (!all) return hits;
    }
    if (msgs.length < PAGE_SIZE) break;
    after = msgs[msgs.length - 1].id;
  }
  return hits;
}

export function waitForMessage(discord: DiscordPort, o: WaitOptions): Promise<MessageView> {
  return new Promise<MessageView>((resolve, reject) => {
    if (o.signal?.aborted) {
      reject(new ToolError("timeout", "aborted"));
      return;
    }

    let settled = false;
    // With `after`, live events are buffered until the backlog has been read.
    let backlogDone = o.after === undefined;
    const buffer: MessageView[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubs: (() => void)[] = [];

    const settle = (err: unknown, m?: MessageView) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      quiet?.clear();
      for (const off of unsubs) off();
      o.signal?.removeEventListener("abort", onAbort);
      if (err !== undefined) reject(err);
      else resolve(m as MessageView);
    };

    const onAbort = () => settle(new ToolError("timeout", "aborted"));

    // With --final, a match is returned only after it has been quiet for settleMs, and not while it is progress.
    const quiet = o.final
      ? new SettleTimers(o.final.settleMs, (m) => {
          if (o.final?.ignoreProgress?.test(m.content)) return;
          settle(undefined, m);
        })
      : undefined;

    const accept = (m: MessageView) => {
      if (quiet) quiet.arm(m);
      else settle(undefined, m);
    };

    const onEvent = (m: MessageView) => {
      if (settled) return;
      if (!backlogDone) {
        buffer.push(m);
        return;
      }
      if (!matches(m, o)) {
        quiet?.cancel(m.id);
        return;
      }
      accept(m);
    };

    o.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => settle(new ToolError("timeout", `no matching message within ${o.timeoutMs} ms`)),
      o.timeoutMs,
    );

    // Subscribe first, so no message sent during the backlog read is lost.
    unsubs.push(discord.onMessage(onEvent));
    // Edits matter only for --final: an answer is often the last edit of a message.
    if (o.final) unsubs.push(discord.onMessageUpdate(onEvent));

    if (o.after !== undefined) {
      readBacklog(discord, o, () => settled, o.final !== undefined)
        .then((hits) => {
          if (settled) return;
          backlogDone = true;
          if (o.final) {
            for (const h of hits) accept(h);
            for (const m of buffer) {
              if (matches(m, o)) accept(m);
              else quiet?.cancel(m.id);
            }
          } else {
            const candidates = [...hits, ...buffer.filter((m) => matches(m, o))];
            if (candidates.length > 0) settle(undefined, oldest(candidates));
          }
          buffer.length = 0;
        })
        .catch((err: unknown) => settle(err));
    }
  });
}
