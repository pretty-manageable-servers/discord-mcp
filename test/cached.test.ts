import { describe, expect, it, vi } from "vitest";
import { withCache } from "../src/cached.js";
import { waitForMessage } from "../src/wait.js";
import { FakeDiscord, makeMessage } from "./fake-discord.js";
import { MemoryStore } from "./memory-store.js";

describe("cached port", () => {
  it("first read backfills then serves from store", async () => {
    const fake = new FakeDiscord();
    fake.messages.push(makeMessage({ channelId: "c1", content: "a" }), makeMessage({ channelId: "c1", content: "b" }));
    const port = withCache(fake, new MemoryStore());

    const first = await port.readMessages("c1", { limit: 20 });
    expect(first.map((m) => m.content)).toEqual(["a", "b"]);

    const reads = fake.apiReads;
    const second = await port.readMessages("c1", { limit: 20 });
    expect(second).toEqual(first);
    expect(fake.apiReads).toBe(reads);
  });

  it("catch up only after newest", async () => {
    const fake = new FakeDiscord();
    const old = makeMessage({ channelId: "c1", content: "old" });
    const newer = makeMessage({ channelId: "c1", content: "newer" });
    fake.messages.push(old, newer);

    // Earlier process: the store already holds both messages.
    const store = new MemoryStore();
    store.upsertMany([old, newer]);
    store.markSynced("c1");

    // Sent while the process was down. Not in the store yet.
    const later = makeMessage({ channelId: "c1", content: "later" });
    fake.messages.push(later);

    // New process: a new wrapper with no fresh channels.
    const spy = vi.spyOn(fake, "readMessages");
    const port = withCache(fake, store);
    const read = await port.readMessages("c1", { limit: 20 });

    expect(spy).toHaveBeenCalledWith("c1", { limit: 100, after: newer.id });
    expect(read.map((m) => m.content)).toEqual(["old", "newer", "later"]);
  });

  it("live message lands in store", () => {
    const fake = new FakeDiscord();
    const store = new MemoryStore();
    withCache(fake, store);

    fake.push(makeMessage({ channelId: "c1", content: "live" }));

    expect(store.range("c1", { limit: 10 }).map((m) => m.content)).toEqual(["live"]);
  });

  it("edit updates store", () => {
    const fake = new FakeDiscord();
    const store = new MemoryStore();
    withCache(fake, store);
    const m = makeMessage({ channelId: "c1", content: "before edit" });
    fake.push(m);

    fake.edit(m.id, "after edit");

    expect(store.range("c1", { limit: 10 }).map((x) => x.content)).toEqual(["after edit"]);
  });

  it("delete hides message", async () => {
    const fake = new FakeDiscord();
    const store = new MemoryStore();
    const port = withCache(fake, store);
    const m = makeMessage({ channelId: "c1", content: "gone soon" });
    fake.push(m);

    fake.remove(m.id);

    expect(await port.readMessages("c1", { limit: 10 })).toEqual([]);
    expect(store.range("c1", { limit: 10 })).toEqual([]);
  });

  it("send stores own message", async () => {
    const fake = new FakeDiscord();
    // Reply without a gateway event, so only the sendMessage path can store it.
    fake.sendMessage = async (channelId: string, content: string) =>
      makeMessage({ channelId, content, authorId: fake.botId, authorName: fake.botName, authorIsBot: true });
    const store = new MemoryStore();
    const port = withCache(fake, store);

    const sent = await port.sendMessage("c1", "hello from bot");

    expect(store.range("c1", { limit: 10 }).map((m) => m.id)).toEqual([sent.id]);
  });

  it("before reads older history from api when store is short", async () => {
    const fake = new FakeDiscord();
    const all = Array.from({ length: 150 }, (_, i) => makeMessage({ channelId: "c1", content: `m${i}` }));
    fake.messages.push(...all);
    const store = new MemoryStore();
    const port = withCache(fake, store);
    await port.readMessages("c1", { limit: 20 }); // catch-up: store holds the newest 100

    const reads = fake.apiReads;
    const older = await port.readMessages("c1", { limit: 20, before: all[60].id });

    // Store has only m50..m59 before m60, so the API fills the page.
    expect(older.map((m) => m.content)).toEqual(Array.from({ length: 20 }, (_, i) => `m${40 + i}`));
    expect(fake.apiReads).toBe(reads + 1);
    expect(store.range("c1", { limit: 100, before: all[60].id })).toHaveLength(20);
  });

  it("falls back to api when catch up fails", async () => {
    const fake = new FakeDiscord();
    fake.messages.push(makeMessage({ channelId: "c1", content: "x" }), makeMessage({ channelId: "c1", content: "y" }));
    const store = new MemoryStore();
    const port = withCache(fake, store);
    const spy = vi.spyOn(fake, "readMessages").mockRejectedValueOnce(new Error("discord down"));

    const result = await port.readMessages("c1", { limit: 20 });

    expect(result.map((m) => m.content)).toEqual(["x", "y"]);
    expect(store.isSynced("c1")).toBe(false);

    // Next read retries catch-up and succeeds.
    await port.readMessages("c1", { limit: 20 });
    expect(store.isSynced("c1")).toBe(true);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("rethrows when api fallback also fails", async () => {
    const fake = new FakeDiscord();
    const port = withCache(fake, new MemoryStore());
    vi.spyOn(fake, "readMessages").mockRejectedValue(new Error("discord down"));

    await expect(port.readMessages("c1", { limit: 20 })).rejects.toThrow("discord down");
  });

  it("wait_for_message backlog uses store", async () => {
    const fake = new FakeDiscord();
    const anchor = makeMessage({ channelId: "c1", authorId: "u2", content: "anchor" });
    const target = makeMessage({ channelId: "c1", authorId: "u-target", content: "target" });
    fake.messages.push(anchor, target);
    const port = withCache(fake, new MemoryStore());

    const hit = await waitForMessage(port, {
      channelId: "c1", after: anchor.id, from: "all", toMe: false, timeoutMs: 1000,
      selfId: "bot-self", selfNames: ["self-bot"],
    });

    expect(hit.content).toBe("target");
    // One API call for catch-up. The backlog read itself came from the store.
    expect(fake.apiReads).toBe(1);
  });
});
