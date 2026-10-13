import type { DiscordPort } from "./port.js";
import type { MessageStore } from "./store.js";
import type { MessageView } from "./types.js";

const PAGE_SIZE = 100;
const MAX_CATCH_UP_PAGES = 10;

// Run one store write. A store error is logged and never breaks the Discord call.
function persist(what: string, write: () => void): void {
  try {
    write();
  } catch (err) {
    console.error(`discord-mcp cache: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Wraps a DiscordPort so reads use the local store. Returns the same DiscordPort
// interface, so tools do not change.
export function withCache(inner: DiscordPort, store: MessageStore): DiscordPort {
  // Channels caught up in this process.
  const fresh = new Set<string>();

  // Live gateway events keep the store current while the process runs.
  inner.onMessage((m) => persist("store message", () => store.upsert(m)));
  inner.onMessageUpdate((m) => persist("store edit", () => store.upsert(m)));
  inner.onMessageDelete((ref) => persist("store delete", () => store.markDeleted(ref.channelId, ref.id)));

  // Fetch what the store is missing for one channel, then mark it synced.
  // Store errors throw here, so the caller falls back to the API.
  async function catchUp(channelId: string): Promise<void> {
    const newest = store.newestId(channelId);
    if (!store.isSynced(channelId) || newest === null) {
      store.upsertMany(await inner.readMessages(channelId, { limit: PAGE_SIZE }));
    } else {
      let after: string = newest;
      for (let page = 0; page < MAX_CATCH_UP_PAGES; page++) {
        const msgs = await inner.readMessages(channelId, { limit: PAGE_SIZE, after });
        store.upsertMany(msgs);
        if (msgs.length < PAGE_SIZE) break;
        after = msgs[msgs.length - 1].id;
      }
    }
    store.markSynced(channelId);
  }

  async function readMessages(
    channelId: string,
    opts: { limit: number; after?: string; before?: string },
  ): Promise<MessageView[]> {
    if (!fresh.has(channelId)) {
      try {
        await catchUp(channelId);
        fresh.add(channelId);
      } catch {
        // Catch-up failed. Serve this read from the API, and retry catch-up on the next read.
        return inner.readMessages(channelId, opts);
      }
    }

    if (opts.before !== undefined) {
      const rows = store.range(channelId, opts);
      if (rows.length < opts.limit) {
        // Store has no more older history. Fill it from the API.
        const api = await inner.readMessages(channelId, opts);
        persist("store history", () => store.upsertMany(api));
        return api;
      }
      return rows;
    }

    return store.range(channelId, opts);
  }

  return {
    ready: () => inner.ready(),
    listGuilds: () => inner.listGuilds(),
    listChannels: (guildId) => inner.listChannels(guildId),
    readMessages,
    async sendMessage(channelId, content, opts) {
      const sent = await inner.sendMessage(channelId, content, opts);
      persist("store sent message", () => store.upsert(sent));
      return sent;
    },
    createThread: (channelId, name, messageId) => inner.createThread(channelId, name, messageId),
    react: (channelId, messageId, emoji) => inner.react(channelId, messageId, emoji),
    onMessage: (cb) => inner.onMessage(cb),
    onMessageUpdate: (cb) => inner.onMessageUpdate(cb),
    onMessageDelete: (cb) => inner.onMessageDelete(cb),
  };
}
