import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MessageStore, openStore } from "../src/store.js";
import type { MessageView } from "../src/types.js";

function msg(over: Partial<MessageView> & { id: string }): MessageView {
  return {
    channelId: "c1",
    guildId: "g1",
    authorId: "u1",
    authorName: "alice",
    authorIsBot: false,
    content: "hi",
    createdAt: "2026-01-01T00:00:00.000Z",
    replyToId: null,
    threadId: null,
    attachments: [],
    agentMsg: null,
    ...over,
  };
}

function ids(list: MessageView[]): string[] {
  return list.map((m) => m.id);
}

let store: MessageStore;

beforeEach(() => {
  store = openStore(":memory:");
});

afterEach(() => {
  store.close();
});

it("upsert then range oldest first", () => {
  store.upsert(msg({ id: "2" }));
  store.upsert(msg({ id: "1" }));
  store.upsert(msg({ id: "3" }));
  expect(ids(store.range("c1", { limit: 10 }))).toEqual(["1", "2", "3"]);
});

it("range after", () => {
  store.upsertMany([1, 2, 3, 4, 5].map((n) => msg({ id: String(n) })));
  expect(ids(store.range("c1", { limit: 2, after: "2" }))).toEqual(["3", "4"]);
});

it("range before", () => {
  store.upsertMany([1, 2, 3, 4, 5].map((n) => msg({ id: String(n) })));
  expect(ids(store.range("c1", { limit: 2, before: "4" }))).toEqual(["2", "3"]);
});

it("upsert updates content and fts", () => {
  store.upsert(msg({ id: "1", content: "apple" }));
  store.upsert(msg({ id: "1", content: "banana" }));
  expect(ids(store.range("c1", { limit: 10 }))).toEqual(["1"]);
  expect(store.range("c1", { limit: 10 })[0]!.content).toBe("banana");
  expect(store.search({ text: "apple", limit: 10 })).toEqual([]);
  expect(ids(store.search({ text: "banana", limit: 10 }))).toEqual(["1"]);
});

it("markDeleted hides from range and search", () => {
  store.upsert(msg({ id: "1", content: "hello" }));
  store.upsert(msg({ id: "2", content: "hello" }));
  store.markDeleted("c1", "2");
  expect(ids(store.range("c1", { limit: 10 }))).toEqual(["1"]);
  expect(ids(store.search({ text: "hello", limit: 10 }))).toEqual(["1"]);
  // Deleted rows stay in the table, so the newest id does not move back.
  expect(store.newestId("c1")).toBe("2");
});

it("newestId by numeric order", () => {
  store.upsert(msg({ id: "9" }));
  store.upsert(msg({ id: "10" }));
  expect(store.newestId("c1")).toBe("10");
  expect(store.newestId("c-empty")).toBeNull();
});

it("sync flag", () => {
  expect(store.isSynced("c1")).toBe(false);
  store.markSynced("c1");
  expect(store.isSynced("c1")).toBe(true);
  expect(store.isSynced("c2")).toBe(false);
});

it("search by text", () => {
  store.upsert(msg({ id: "1", content: "pizza tonight" }));
  store.upsert(msg({ id: "2", content: "red car" }));
  store.upsert(msg({ id: "3", content: "pizza again" }));
  store.upsert(msg({ id: "4", content: "red bike" }));
  expect(ids(store.search({ text: "pizza", limit: 10 }))).toEqual(["3", "1"]);
  // Words are joined with AND.
  expect(ids(store.search({ text: "red car", limit: 10 }))).toEqual(["2"]);
});

it("search text with quotes is safe", () => {
  store.upsert(msg({ id: "1", content: 'say "hi" now' }));
  store.upsert(msg({ id: "2", content: "plain text" }));
  expect(ids(store.search({ text: '"hi"', limit: 10 }))).toEqual(["1"]);
  expect(() => store.search({ text: 'hi" OR "x', limit: 10 })).not.toThrow();
  expect(() => store.search({ text: '"', limit: 10 })).not.toThrow();
  expect(() => store.search({ text: "NEAR( * -", limit: 10 })).not.toThrow();
});

it("search by author and time", () => {
  store.upsertMany([
    msg({ id: "1", authorId: "u1", createdAt: "2026-01-01T00:00:00.000Z" }),
    msg({ id: "2", authorId: "u2", createdAt: "2026-01-02T00:00:00.000Z" }),
    msg({ id: "3", authorId: "u1", createdAt: "2026-01-02T00:00:00.000Z" }),
    msg({ id: "4", authorId: "u1", createdAt: "2026-01-03T00:00:00.000Z" }),
    msg({ id: "5", authorId: "u1", createdAt: "2026-01-04T00:00:00.000Z" }),
  ]);
  const found = store.search({
    authorId: "u1",
    since: "2026-01-02T00:00:00.000Z",
    until: "2026-01-04T00:00:00.000Z",
    limit: 10,
  });
  expect(ids(found)).toEqual(["4", "3"]);
});

it("thread messages in channel range", () => {
  store.upsert(msg({ id: "1", channelId: "c1" }));
  store.upsert(msg({ id: "2", channelId: "t1", threadId: "c1" }));
  store.upsert(msg({ id: "3", channelId: "c2" }));
  expect(ids(store.range("c1", { limit: 10 }))).toEqual(["1", "2"]);
  expect(ids(store.search({ channelId: "c1", limit: 10 }))).toEqual(["2", "1"]);
});

it("file db creates directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "wp6a-"));
  const path = join(dir, "nested", "cache.db");
  try {
    const fileStore = openStore(path);
    fileStore.upsert(msg({ id: "1", content: "persisted" }));
    fileStore.close();
    expect(existsSync(path)).toBe(true);

    const reopened = openStore(path);
    try {
      expect(reopened.range("c1", { limit: 10 })[0]!.content).toBe("persisted");
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("gaps add list remove", () => {
  store.addGap("c1", "20", "50");
  store.addGap("c1", "5", "9");
  store.addGap("c1", "5", "9"); // same gap twice is stored once
  store.addGap("c2", "1", "2");
  // Ordered by afterId, numeric.
  expect(store.gaps("c1")).toEqual([
    { afterId: "5", beforeId: "9" },
    { afterId: "20", beforeId: "50" },
  ]);
  store.removeGap("c1", "5", "9");
  expect(store.gaps("c1")).toEqual([{ afterId: "20", beforeId: "50" }]);
  store.removeGap("c1", "5", "9"); // missing gap is a no-op
  expect(store.gaps("c2")).toEqual([{ afterId: "1", beforeId: "2" }]);
});

it("idsFrom numeric", () => {
  store.upsertMany([
    msg({ id: "9" }),
    msg({ id: "10" }),
    msg({ id: "100" }),
    msg({ id: "99", channelId: "c2" }),
  ]);
  // Numeric order: "10" and "100" are >= "9" in numbers, but not as strings.
  expect(store.idsFrom("c1", "9")).toEqual(["9", "10", "100"]);
  expect(store.idsFrom("c1", "10")).toEqual(["10", "100"]);
  // Other channels are excluded.
  expect(store.idsFrom("c2", "1")).toEqual(["99"]);
  // Deleted rows are excluded.
  store.markDeleted("c1", "10");
  expect(store.idsFrom("c1", "9")).toEqual(["9", "100"]);
});

it("v1 file upgrades to v2", () => {
  const dir = mkdtempSync(join(tmpdir(), "wp7-"));
  const path = join(dir, "cache.db");
  try {
    const first = openStore(path);
    first.upsert(msg({ id: "1", content: "old file" }));
    first.close();

    // Make the file look like schema v1: no gaps table, old channel index, version 1.
    const raw = new DatabaseSync(path);
    raw.exec(`
      DROP TABLE gaps;
      DROP INDEX messages_channel_id_num;
      CREATE INDEX messages_channel_id ON messages(channel_id, id);
      UPDATE meta SET value = '1' WHERE key = 'schema_version';
    `);
    raw.close();

    const upgraded = openStore(path);
    try {
      upgraded.addGap("c1", "1", "5");
      expect(upgraded.gaps("c1")).toEqual([{ afterId: "1", beforeId: "5" }]);
      expect(upgraded.range("c1", { limit: 10 })[0]!.content).toBe("old file");
    } finally {
      upgraded.close();
    }

    const check = new DatabaseSync(path);
    try {
      const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      expect(version.value).toBe("2");
      const oldIndex = check.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'messages_channel_id'",
      ).get();
      expect(oldIndex).toBeUndefined();
    } finally {
      check.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
