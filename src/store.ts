import type { MessageView } from "./types.js";

export interface SearchQuery {
  text?: string;       // FTS5 match on content; plain words, quoted for safety by the store
  channelId?: string;  // matches channelId or threadId
  authorId?: string;
  since?: string;      // ISO time, inclusive
  until?: string;      // ISO time, exclusive
  limit: number;       // 1..100
}

// Local SQLite cache of messages (node:sqlite, FTS5). WP6a implements it.
// Tables: messages(id PK, channel_id, guild_id, thread_id, author_id, author_name, author_is_bot,
//   content, created_at, reply_to_id, attachments_json, agent_msg_json, deleted INTEGER, edited_at),
//   messages_fts(content) external content on messages, sync(channel_id PK, synced_at).
export interface MessageStore {
  upsert(m: MessageView): void;
  upsertMany(list: MessageView[]): void;           // one transaction
  markDeleted(channelId: string, id: string): void;
  // Not deleted, oldest first. Same after/before/limit rules as DiscordPort.readMessages.
  range(channelId: string, opts: { limit: number; after?: string; before?: string }): MessageView[];
  newestId(channelId: string): string | null;
  isSynced(channelId: string): boolean;
  markSynced(channelId: string): void;
  // Not deleted, newest first.
  search(q: SearchQuery): MessageView[];
  close(): void;
}

export function openStore(_path: string): MessageStore {
  throw new Error("not built: WP6a");
}
