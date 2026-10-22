import { statSync } from "node:fs";
import { basename } from "node:path";
import type { DiscordPort } from "../src/port.js";
import type { ChannelView, GuildView, MessageView } from "../src/types.js";

let seq = 1000;
export function nextId(): string {
  return String(++seq);
}

export function makeMessage(over: Partial<MessageView> = {}): MessageView {
  return {
    id: nextId(), channelId: "c1", guildId: "g1",
    authorId: "u1", authorName: "human", authorIsBot: false,
    content: "hi", createdAt: new Date().toISOString(),
    replyToId: null, threadId: null, attachments: [], agentMsg: null,
    ...over,
  };
}

// In-memory DiscordPort for tests. No network.
export class FakeDiscord implements DiscordPort {
  botId = "bot-self";
  botName = "self-bot";
  guilds: GuildView[] = [{ id: "g1", name: "Test" }];
  channels: Record<string, ChannelView[]> = { g1: [{ id: "c1", name: "general", type: "text" }] };
  messages: MessageView[] = [];
  reactions: { channelId: string; messageId: string; emoji: string }[] = [];
  threads: { channelId: string; name: string; messageId?: string; id: string }[] = [];
  private listeners = new Set<(m: MessageView) => void>();
  private updateListeners = new Set<(m: MessageView) => void>();
  private deleteListeners = new Set<(ref: { channelId: string; id: string }) => void>();
  apiReads = 0;

  async ready() { return { botId: this.botId, botName: this.botName }; }
  async listGuilds() { return this.guilds; }
  async listChannels(guildId: string) { return this.channels[guildId] ?? []; }

  async readMessages(channelId: string, opts: { limit: number; after?: string; before?: string }) {
    this.apiReads++;
    let list = this.messages.filter((m) => m.channelId === channelId);
    if (opts.after) list = list.filter((m) => BigInt(m.id) > BigInt(opts.after!));
    if (opts.before) list = list.filter((m) => BigInt(m.id) < BigInt(opts.before!));
    list.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    return opts.after ? list.slice(0, opts.limit) : list.slice(-opts.limit);
  }

  // Files become attachments with the file's base name and size. No upload happens.
  // Options of the last sendMessage call, so tests can check what the port was asked to do.
  lastSendOpts: { replyToId?: string; files?: string[]; mentions?: string[] } | undefined;

  async sendMessage(
    channelId: string,
    content: string,
    opts?: { replyToId?: string; files?: string[]; mentions?: string[] },
  ) {
    this.lastSendOpts = opts;
    const attachments = (opts?.files ?? []).map((path) => {
      const name = basename(path);
      return { name, url: `https://cdn.fake/${name}`, size: statSync(path).size };
    });
    const m = makeMessage({
      channelId, content, authorId: this.botId, authorName: this.botName,
      authorIsBot: true, replyToId: opts?.replyToId ?? null, attachments,
    });
    this.push(m);
    return m;
  }

  async createThread(channelId: string, name: string, messageId?: string) {
    const id = nextId();
    this.threads.push({ channelId, name, messageId, id });
    return { id };
  }

  async react(channelId: string, messageId: string, emoji: string) {
    this.reactions.push({ channelId, messageId, emoji });
  }

  onMessage(cb: (m: MessageView) => void) {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  onMessageUpdate(cb: (m: MessageView) => void) {
    this.updateListeners.add(cb);
    return () => { this.updateListeners.delete(cb); };
  }

  onMessageDelete(cb: (ref: { channelId: string; id: string }) => void) {
    this.deleteListeners.add(cb);
    return () => { this.deleteListeners.delete(cb); };
  }

  listenerCount() { return this.listeners.size; }

  destroyed = false;
  destroy() { this.destroyed = true; }

  // Change a stored message and tell update listeners.
  edit(id: string, content: string) {
    const m = this.messages.find((x) => x.id === id);
    if (!m) throw new Error("no message " + id);
    m.content = content;
    for (const cb of [...this.updateListeners]) cb({ ...m });
  }

  // Remove a message and tell delete listeners.
  remove(id: string) {
    const i = this.messages.findIndex((x) => x.id === id);
    if (i < 0) throw new Error("no message " + id);
    const [m] = this.messages.splice(i, 1);
    for (const cb of [...this.deleteListeners]) cb({ channelId: m.channelId, id: m.id });
  }

  // Store a message and tell all listeners, like a gateway event.
  push(m: MessageView) {
    this.messages.push(m);
    for (const cb of [...this.listeners]) cb(m);
  }
}
