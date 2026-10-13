import type { MessageStore, SearchQuery } from "../src/store.js";
import type { MessageView } from "../src/types.js";

interface Row {
  m: MessageView;
  deleted: boolean;
}

// In-memory MessageStore for tests. Not production code.
export class MemoryStore implements MessageStore {
  private rows = new Map<string, Row>();
  private synced = new Set<string>();

  upsert(m: MessageView): void {
    this.rows.set(m.id, { m: { ...m }, deleted: false });
  }

  upsertMany(list: MessageView[]): void {
    for (const m of list) this.upsert(m);
  }

  markDeleted(channelId: string, id: string): void {
    const row = this.rows.get(id);
    if (row && row.m.channelId === channelId) row.deleted = true;
  }

  // Same rules as FakeDiscord.readMessages: oldest first, after/before by numeric id.
  range(channelId: string, opts: { limit: number; after?: string; before?: string }): MessageView[] {
    let list = this.live().filter((m) => m.channelId === channelId);
    if (opts.after) list = list.filter((m) => BigInt(m.id) > BigInt(opts.after!));
    if (opts.before) list = list.filter((m) => BigInt(m.id) < BigInt(opts.before!));
    list.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    return opts.after ? list.slice(0, opts.limit) : list.slice(-opts.limit);
  }

  // Newest id seen in the channel, deleted rows included, so it works as a cursor.
  newestId(channelId: string): string | null {
    let best: string | null = null;
    for (const { m } of this.rows.values()) {
      if (m.channelId !== channelId) continue;
      if (best === null || BigInt(m.id) > BigInt(best)) best = m.id;
    }
    return best;
  }

  isSynced(channelId: string): boolean {
    return this.synced.has(channelId);
  }

  markSynced(channelId: string): void {
    this.synced.add(channelId);
  }

  // Newest first. Substring match on text.
  search(q: SearchQuery): MessageView[] {
    const list = this.live().filter((m) => {
      if (q.text !== undefined && !m.content.includes(q.text)) return false;
      if (q.channelId !== undefined && m.channelId !== q.channelId && m.threadId !== q.channelId) return false;
      if (q.authorId !== undefined && m.authorId !== q.authorId) return false;
      if (q.since !== undefined && m.createdAt < q.since) return false;
      if (q.until !== undefined && m.createdAt >= q.until) return false;
      return true;
    });
    list.sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1));
    return list.slice(0, q.limit);
  }

  close(): void {}

  private live(): MessageView[] {
    return [...this.rows.values()].filter((r) => !r.deleted).map((r) => r.m);
  }
}
