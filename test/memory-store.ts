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
  private gapRows: { channelId: string; afterId: string; beforeId: string }[] = [];

  // Like SQLite: a stored delete stays, even when the same id is upserted again.
  upsert(m: MessageView): void {
    const old = this.rows.get(m.id);
    this.rows.set(m.id, { m: { ...m }, deleted: old?.deleted ?? false });
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

  addGap(channelId: string, afterId: string, beforeId: string): void {
    if (this.findGap(channelId, afterId, beforeId) >= 0) return;
    this.gapRows.push({ channelId, afterId, beforeId });
  }

  gaps(channelId: string): { afterId: string; beforeId: string }[] {
    return this.gapRows
      .filter((g) => g.channelId === channelId)
      .sort((a, b) => (BigInt(a.afterId) < BigInt(b.afterId) ? -1 : 1))
      .map((g) => ({ afterId: g.afterId, beforeId: g.beforeId }));
  }

  removeGap(channelId: string, afterId: string, beforeId: string): void {
    const i = this.findGap(channelId, afterId, beforeId);
    if (i >= 0) this.gapRows.splice(i, 1);
  }

  // Same rules as the SQLite store: stored, not deleted, numeric id order.
  idsFrom(channelId: string, fromId: string): string[] {
    return this.live()
      .filter((m) => m.channelId === channelId && BigInt(m.id) >= BigInt(fromId))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
      .map((m) => m.id);
  }

  private findGap(channelId: string, afterId: string, beforeId: string): number {
    return this.gapRows.findIndex(
      (g) =>
        g.channelId === channelId &&
        BigInt(g.afterId) === BigInt(afterId) &&
        BigInt(g.beforeId) === BigInt(beforeId),
    );
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
