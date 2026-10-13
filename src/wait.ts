import { ToolError } from "./errors.js";
import type { DiscordPort } from "./port.js";
import type { MessageView } from "./types.js";

export interface WaitOptions {
  channelId: string;
  after?: string;
  from: "bots" | "humans" | "all" | string[];
  toMe: boolean;
  timeoutMs: number;
  selfId: string;
  selfNames: string[];
  signal?: AbortSignal;
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
  if (o.after !== undefined && BigInt(m.id) <= BigInt(o.after)) return false;
  return true;
}

function oldest(list: MessageView[]): MessageView {
  return list.reduce((a, b) => (BigInt(b.id) < BigInt(a.id) ? b : a));
}

const PAGE_SIZE = 100;
const MAX_BACKLOG_PAGES = 10;

// Reads the backlog page by page, oldest first. Returns the oldest match, or undefined.
async function findBacklogMatch(
  discord: DiscordPort,
  o: WaitOptions,
  stopped: () => boolean,
): Promise<MessageView | undefined> {
  let after = o.after;
  for (let page = 0; page < MAX_BACKLOG_PAGES && !stopped(); page++) {
    const msgs = await discord.readMessages(o.channelId, { limit: PAGE_SIZE, after });
    const hit = msgs.find((m) => matches(m, o));
    if (hit) return hit;
    if (msgs.length < PAGE_SIZE) break;
    after = msgs[msgs.length - 1].id;
  }
  return undefined;
}

export function waitForMessage(discord: DiscordPort, o: WaitOptions): Promise<MessageView> {
  return new Promise<MessageView>((resolve, reject) => {
    if (o.signal?.aborted) {
      reject(new ToolError("timeout", "aborted"));
      return;
    }

    let settled = false;
    // With `after`, live messages are buffered until the backlog has been read.
    let backlogDone = o.after === undefined;
    const buffer: MessageView[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: () => void = () => {};

    const settle = (err: unknown, m?: MessageView) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      o.signal?.removeEventListener("abort", onAbort);
      if (err !== undefined) reject(err);
      else resolve(m as MessageView);
    };

    const onAbort = () => settle(new ToolError("timeout", "aborted"));

    o.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => settle(new ToolError("timeout", `no matching message within ${o.timeoutMs} ms`)),
      o.timeoutMs,
    );

    // Subscribe first, so no message sent during the backlog read is lost.
    unsubscribe = discord.onMessage((m) => {
      if (settled || !matches(m, o)) return;
      if (!backlogDone) {
        buffer.push(m);
        return;
      }
      settle(undefined, m);
    });

    if (o.after !== undefined) {
      findBacklogMatch(discord, o, () => settled)
        .then((hit) => {
          if (settled) return;
          backlogDone = true;
          const candidates = hit ? [hit, ...buffer] : buffer;
          if (candidates.length > 0) settle(undefined, oldest(candidates));
        })
        .catch((err: unknown) => settle(err));
    }
  });
}
