import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EmbedView } from "./components.js";
import type { AgentMsg, Attachment, MessageView } from "./types.js";

// Version 3 adds components_json and embeds_json (nullable; old rows read as empty).
const SCHEMA_VERSION = 3;

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
//   content, created_at, reply_to_id, attachments_json, agent_msg_json, components_json, embeds_json,
//   deleted INTEGER, edited_at),
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
  // Missing id ranges (exclusive bounds) in a channel's cache.
  addGap(channelId: string, afterId: string, beforeId: string): void;
  gaps(channelId: string): { afterId: string; beforeId: string }[];   // ordered by afterId
  removeGap(channelId: string, afterId: string, beforeId: string): void;
  // Ids of stored, not-deleted rows with channel_id = channelId and id_num >= fromId (numeric).
  idsFrom(channelId: string, fromId: string): string[];
  // Not deleted, newest first.
  search(q: SearchQuery): MessageView[];
  close(): void;
}

type Param = string | number | bigint | null;

interface MessageRow {
  id: string;
  channel_id: string;
  guild_id: string | null;
  thread_id: string | null;
  author_id: string;
  author_name: string;
  author_is_bot: number;
  content: string;
  created_at: string;
  reply_to_id: string | null;
  attachments_json: string | null;
  agent_msg_json: string | null;
  components_json: string | null;
  embeds_json: string | null;
}

const ROW_COLUMNS = `m.id, m.channel_id, m.guild_id, m.thread_id, m.author_id, m.author_name,
  m.author_is_bot, m.content, m.created_at, m.reply_to_id, m.attachments_json, m.agent_msg_json,
  m.components_json, m.embeds_json`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  id_num INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  guild_id TEXT,
  thread_id TEXT,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_is_bot INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reply_to_id TEXT,
  attachments_json TEXT,
  agent_msg_json TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  edited_at TEXT
);
DROP INDEX IF EXISTS messages_channel_id;
CREATE INDEX IF NOT EXISTS messages_channel_id_num ON messages(channel_id, id_num);
CREATE INDEX IF NOT EXISTS messages_thread_id ON messages(thread_id);
CREATE INDEX IF NOT EXISTS messages_author_id ON messages(author_id);
CREATE INDEX IF NOT EXISTS messages_created_at ON messages(created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TABLE IF NOT EXISTS sync (
  channel_id TEXT PRIMARY KEY,
  synced_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gaps (
  channel_id TEXT NOT NULL,
  after_num INTEGER NOT NULL,
  before_num INTEGER NOT NULL,
  after_id TEXT NOT NULL,
  before_id TEXT NOT NULL,
  PRIMARY KEY(channel_id, after_num, before_num)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Adds the columns that version 3 needs to an older file, then records the version.
// Existing rows keep NULL in the new columns, which read as no components and no embeds.
function migrate(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(messages)").all() as unknown as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has("components_json")) db.exec("ALTER TABLE messages ADD COLUMN components_json TEXT");
  if (!columns.has("embeds_json")) db.exec("ALTER TABLE messages ADD COLUMN embeds_json TEXT");
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(SCHEMA_VERSION));
}

const UPSERT_SQL = `
INSERT INTO messages (id, id_num, channel_id, guild_id, thread_id, author_id, author_name,
  author_is_bot, content, created_at, reply_to_id, attachments_json, agent_msg_json,
  components_json, embeds_json, deleted, edited_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
ON CONFLICT(id) DO UPDATE SET
  id_num = excluded.id_num,
  channel_id = excluded.channel_id,
  guild_id = excluded.guild_id,
  thread_id = excluded.thread_id,
  author_id = excluded.author_id,
  author_name = excluded.author_name,
  author_is_bot = excluded.author_is_bot,
  content = excluded.content,
  created_at = excluded.created_at,
  reply_to_id = excluded.reply_to_id,
  attachments_json = excluded.attachments_json,
  agent_msg_json = excluded.agent_msg_json,
  components_json = excluded.components_json,
  embeds_json = excluded.embeds_json,
  edited_at = CASE WHEN messages.content <> excluded.content THEN ? ELSE messages.edited_at END
`;

function rowToView(r: MessageRow): MessageView {
  return {
    id: r.id,
    channelId: r.channel_id,
    guildId: r.guild_id,
    authorId: r.author_id,
    authorName: r.author_name,
    authorIsBot: r.author_is_bot === 1,
    content: r.content,
    createdAt: r.created_at,
    replyToId: r.reply_to_id,
    threadId: r.thread_id,
    attachments: r.attachments_json ? (JSON.parse(r.attachments_json) as Attachment[]) : [],
    agentMsg: r.agent_msg_json ? (JSON.parse(r.agent_msg_json) as AgentMsg) : null,
    components: r.components_json ? (JSON.parse(r.components_json) as string[]) : [],
    embeds: r.embeds_json ? (JSON.parse(r.embeds_json) as EmbedView[]) : [],
  };
}

// Each word becomes a quoted FTS5 phrase, so user input cannot act as FTS syntax.
function ftsQuery(text: string): string | null {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return null;
  return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" ");
}

function clampLimit(n: number): number {
  if (Number.isNaN(n)) return 1;
  return Math.min(100, Math.max(1, Math.trunc(n)));
}

export function openStore(path: string): MessageStore {
  const isMemory = path === ":memory:";
  if (!isMemory) mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  if (!isMemory) db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(SCHEMA);
  migrate(db);

  const upsertStmt = db.prepare(UPSERT_SQL);

  function writeMessage(m: MessageView): void {
    upsertStmt.run(
      m.id,
      BigInt(m.id),
      m.channelId,
      m.guildId,
      m.threadId,
      m.authorId,
      m.authorName,
      m.authorIsBot ? 1 : 0,
      m.content,
      m.createdAt,
      m.replyToId,
      JSON.stringify(m.attachments ?? []),
      m.agentMsg ? JSON.stringify(m.agentMsg) : null,
      JSON.stringify(m.components ?? []),
      JSON.stringify(m.embeds ?? []),
      new Date().toISOString(),
    );
  }

  return {
    upsert(m) {
      writeMessage(m);
    },

    upsertMany(list) {
      db.exec("BEGIN");
      try {
        for (const m of list) writeMessage(m);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    markDeleted(channelId, id) {
      db.prepare(
        "UPDATE messages SET deleted = 1 WHERE id = ? AND (channel_id = ? OR thread_id = ?)",
      ).run(id, channelId, channelId);
    },

    range(channelId, opts) {
      const params: Param[] = [channelId, channelId];
      let where = "(m.channel_id = ? OR m.thread_id = ?) AND m.deleted = 0";
      if (opts.after) {
        where += " AND m.id_num > ?";
        params.push(BigInt(opts.after));
      }
      if (opts.before) {
        where += " AND m.id_num < ?";
        params.push(BigInt(opts.before));
      }
      params.push(opts.limit);

      if (opts.after) {
        const rows = db
          .prepare(`SELECT ${ROW_COLUMNS} FROM messages m WHERE ${where} ORDER BY m.id_num ASC LIMIT ?`)
          .all(...params) as unknown as MessageRow[];
        return rows.map(rowToView);
      }
      const rows = db
        .prepare(`SELECT ${ROW_COLUMNS} FROM messages m WHERE ${where} ORDER BY m.id_num DESC LIMIT ?`)
        .all(...params) as unknown as MessageRow[];
      return rows.reverse().map(rowToView);
    },

    newestId(channelId) {
      const row = db
        .prepare("SELECT m.id FROM messages m WHERE m.channel_id = ? ORDER BY m.id_num DESC LIMIT 1")
        .get(channelId) as unknown as { id: string } | undefined;
      return row ? row.id : null;
    },

    isSynced(channelId) {
      return db.prepare("SELECT 1 FROM sync WHERE channel_id = ?").get(channelId) !== undefined;
    },

    markSynced(channelId) {
      db.prepare(
        `INSERT INTO sync (channel_id, synced_at) VALUES (?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET synced_at = excluded.synced_at`,
      ).run(channelId, new Date().toISOString());
    },

    addGap(channelId, afterId, beforeId) {
      db.prepare(
        `INSERT INTO gaps (channel_id, after_num, before_num, after_id, before_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, after_num, before_num) DO NOTHING`,
      ).run(channelId, BigInt(afterId), BigInt(beforeId), afterId, beforeId);
    },

    gaps(channelId) {
      const rows = db
        .prepare("SELECT after_id, before_id FROM gaps WHERE channel_id = ? ORDER BY after_num ASC")
        .all(channelId) as unknown as { after_id: string; before_id: string }[];
      return rows.map((r) => ({ afterId: r.after_id, beforeId: r.before_id }));
    },

    removeGap(channelId, afterId, beforeId) {
      db.prepare("DELETE FROM gaps WHERE channel_id = ? AND after_num = ? AND before_num = ?").run(
        channelId,
        BigInt(afterId),
        BigInt(beforeId),
      );
    },

    idsFrom(channelId, fromId) {
      const rows = db
        .prepare(
          "SELECT m.id FROM messages m WHERE m.channel_id = ? AND m.id_num >= ? AND m.deleted = 0 ORDER BY m.id_num ASC",
        )
        .all(channelId, BigInt(fromId)) as unknown as { id: string }[];
      return rows.map((r) => r.id);
    },

    search(q) {
      const params: Param[] = [];
      const clauses = ["m.deleted = 0"];
      let from = "messages m";

      const fts = q.text ? ftsQuery(q.text) : null;
      if (fts !== null) {
        from = "messages_fts JOIN messages m ON m.rowid = messages_fts.rowid";
        clauses.push("messages_fts MATCH ?");
        params.push(fts);
      }
      if (q.channelId) {
        clauses.push("(m.channel_id = ? OR m.thread_id = ?)");
        params.push(q.channelId, q.channelId);
      }
      if (q.authorId) {
        clauses.push("m.author_id = ?");
        params.push(q.authorId);
      }
      if (q.since) {
        clauses.push("m.created_at >= ?");
        params.push(new Date(q.since).toISOString());
      }
      if (q.until) {
        clauses.push("m.created_at < ?");
        params.push(new Date(q.until).toISOString());
      }
      params.push(clampLimit(q.limit));

      const rows = db
        .prepare(
          `SELECT ${ROW_COLUMNS} FROM ${from} WHERE ${clauses.join(" AND ")}
           ORDER BY m.id_num DESC LIMIT ?`,
        )
        .all(...params) as unknown as MessageRow[];
      return rows.map(rowToView);
    },

    close() {
      db.close();
    },
  };
}
