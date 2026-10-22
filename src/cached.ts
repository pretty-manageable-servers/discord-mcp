import type { DiscordPort } from "./port.js";
import type { MessageStore } from "./store.js";
import type { MessageView } from "./types.js";

const PAGE_SIZE = 100;
const MAX_CATCH_UP_PAGES = 10;

// Upper bound for a gap when the newest page came back empty. Above any Discord snowflake.
const NO_UPPER_BOUND = "9223372036854775807";

// An inclusive id range. null means no bound on that side.
interface IdRange {
  lo: bigint | null;
  hi: bigint | null;
}

interface Gap {
  afterId: string;
  beforeId: string;
}

// Run one store write. A store error is logged and never breaks the Discord call.
function persist(what: string, write: () => void): void {
  try {
    write();
  } catch (err) {
    console.error(`discord-mcp cache: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// True when at least one possible id lies strictly between a and b.
function hasIdBetween(a: string, b: string): boolean {
  return BigInt(a) + 1n < BigInt(b);
}

// Ids the API page proves complete. The API returns a contiguous run next to the request
// bound, so every id in the returned range is in the page. A short page reaches the bound
// (the start of the channel for plain and before reads, the newest message for after reads).
// Pages are oldest first.
function pageRange(opts: { limit: number; after?: string; before?: string }, page: MessageView[]): IdRange {
  const full = page.length > 0 && page.length >= Math.min(opts.limit, PAGE_SIZE);
  if (opts.after !== undefined) {
    return { lo: BigInt(opts.after) + 1n, hi: full ? BigInt(page[page.length - 1]!.id) : null };
  }
  return {
    lo: full ? BigInt(page[0]!.id) : null,
    hi: opts.before !== undefined ? BigInt(opts.before) - 1n : null,
  };
}

// Ids the store rows can answer for this request. A full result means the window ends at
// the last row (after reads) or starts at the first row (before and plain reads). A short
// result means the store has no more rows in that direction, so the window is open there.
function rowsRange(opts: { limit: number; after?: string; before?: string }, rows: MessageView[]): IdRange {
  const full = rows.length > 0 && rows.length >= opts.limit;
  if (opts.after !== undefined) {
    return { lo: BigInt(opts.after) + 1n, hi: full ? BigInt(rows[rows.length - 1]!.id) : null };
  }
  return {
    lo: full ? BigInt(rows[0]!.id) : null,
    hi: opts.before !== undefined ? BigInt(opts.before) - 1n : null,
  };
}

// True when a gap has at least one id inside the range.
function overlapsGap(gap: Gap, range: IdRange): boolean {
  if (!hasIdBetween(gap.afterId, gap.beforeId)) return false;
  const lo = BigInt(gap.afterId) + 1n;
  const hi = BigInt(gap.beforeId) - 1n;
  if (range.lo !== null && range.lo > hi) return false;
  if (range.hi !== null && range.hi < lo) return false;
  return true;
}

// The parts of an overlapping gap that a range does not cover. At most two: one below the
// range and one above it. Only call this for a gap that overlaps the range.
function uncoveredParts(gap: Gap, range: IdRange): Gap[] {
  const a = BigInt(gap.afterId);
  const b = BigInt(gap.beforeId);
  const parts: Gap[] = [];
  if (range.lo !== null) {
    const end = range.lo < b ? range.lo : b;
    if (a + 1n < end) parts.push({ afterId: gap.afterId, beforeId: end.toString() });
  }
  if (range.hi !== null) {
    const start = range.hi > a ? range.hi : a;
    if (start + 1n < b) parts.push({ afterId: start.toString(), beforeId: gap.beforeId });
  }
  return parts;
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

  // Page forward from the newest stored id, up to MAX_CATCH_UP_PAGES pages.
  // Returns the last id fetched, and whether the cap stopped it while the last page was full.
  async function pageAfter(channelId: string, newest: string): Promise<{ lastId: string; capped: boolean }> {
    let after = newest;
    for (let page = 0; ; page++) {
      const msgs = await inner.readMessages(channelId, { limit: PAGE_SIZE, after });
      store.upsertMany(msgs);
      if (msgs.length < PAGE_SIZE) return { lastId: after, capped: false };
      after = msgs[msgs.length - 1]!.id;
      if (page + 1 === MAX_CATCH_UP_PAGES) return { lastId: after, capped: true };
    }
  }

  // Read the newest page and store it. This re-checks recent rows: edits are upserted, and
  // stored rows in the page's id range that are not in the page are marked deleted.
  // If paging stopped early, the missing range is recorded first, so a later store error
  // in the delete check cannot lose it.
  async function recheckNewest(channelId: string, paged: { lastId: string; capped: boolean } | null): Promise<void> {
    const page = await inner.readMessages(channelId, { limit: PAGE_SIZE });
    store.upsertMany(page);

    if (paged !== null && paged.capped) {
      const beforeId = page.length > 0 ? page[0]!.id : NO_UPPER_BOUND;
      if (hasIdBetween(paged.lastId, beforeId)) store.addGap(channelId, paged.lastId, beforeId);
    }

    if (page.length === 0) return;
    // A full page covers every stored row from its oldest id up. A short page is the whole
    // channel, so every stored row is in range.
    const fromId = page.length < PAGE_SIZE ? "0" : page[0]!.id;
    const seen = new Set(page.map((m) => m.id));
    for (const id of store.idsFrom(channelId, fromId)) {
      if (!seen.has(id)) store.markDeleted(channelId, id);
    }
  }

  // Fetch what the store is missing for one channel, then mark it synced.
  // Store errors throw here, so the caller falls back to the API.
  async function catchUp(channelId: string): Promise<void> {
    const newest = store.newestId(channelId);
    if (!store.isSynced(channelId) || newest === null) {
      // First read: the newest page is the whole backfill. It also re-checks recent rows.
      await recheckNewest(channelId, null);
    } else {
      const paged = await pageAfter(channelId, newest);
      await recheckNewest(channelId, paged);
    }
    store.markSynced(channelId);
  }

  // Fill a read that touches a gap from the API, store the page, and shrink the gaps it covers.
  async function readGap(
    channelId: string,
    opts: { limit: number; after?: string; before?: string },
  ): Promise<MessageView[]> {
    const page = await inner.readMessages(channelId, opts);
    persist("store gap fill", () => {
      store.upsertMany(page);
      fillGaps(channelId, pageRange(opts, page));
    });
    return page;
  }

  // Remove the part of each gap that the range covers. A gap left with an uncovered part is
  // replaced by that part. Pieces are added before the old gap is removed, so a store error
  // in between keeps the gap instead of losing it.
  function fillGaps(channelId: string, covered: IdRange): void {
    for (const gap of store.gaps(channelId)) {
      if (!overlapsGap(gap, covered)) continue;
      for (const part of uncoveredParts(gap, covered)) store.addGap(channelId, part.afterId, part.beforeId);
      store.removeGap(channelId, gap.afterId, gap.beforeId);
    }
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

    const rows = store.range(channelId, opts);

    // A gap inside the id range the rows answer for means the rows are incomplete.
    const answers = rowsRange(opts, rows);
    if (store.gaps(channelId).some((gap) => overlapsGap(gap, answers))) {
      return readGap(channelId, opts);
    }

    if (opts.before !== undefined && rows.length < opts.limit) {
      // Store has no more older history. Fill it from the API.
      const api = await inner.readMessages(channelId, opts);
      persist("store history", () => store.upsertMany(api));
      return api;
    }

    return rows;
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
    destroy: () => inner.destroy(),
  };
}
