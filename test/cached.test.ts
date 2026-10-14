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

describe("re-check and gaps", () => {
  // Store holds one synced message. The fake gets `count` newer messages, added with no events.
  function seedCapped(count: number) {
    const fake = new FakeDiscord();
    const seed = makeMessage({ channelId: "c1", content: "seed" });
    fake.messages.push(seed);
    const store = new MemoryStore();
    store.upsert(seed);
    store.markSynced("c1");
    const newer = Array.from({ length: count }, (_, i) => makeMessage({ channelId: "c1", content: `n${i}` }));
    fake.messages.push(...newer);
    return { fake, store, newer };
  }

  it("recheck updates edited text", async () => {
    const fake = new FakeDiscord();
    const m = makeMessage({ channelId: "c1", content: "old text" });
    fake.messages.push(m);
    const store = new MemoryStore();
    await withCache(fake, store).readMessages("c1", { limit: 20 });

    // Edited while no process was watching. Change the fake with no events.
    m.content = "new text";

    const read = await withCache(fake, store).readMessages("c1", { limit: 20 });

    expect(read.map((x) => x.content)).toEqual(["new text"]);
    expect(store.range("c1", { limit: 10 }).map((x) => x.content)).toEqual(["new text"]);
  });

  it("recheck marks missing as deleted", async () => {
    const fake = new FakeDiscord();
    const gone = makeMessage({ channelId: "c1", content: "a" });
    const kept = makeMessage({ channelId: "c1", content: "b" });
    const last = makeMessage({ channelId: "c1", content: "c" });
    fake.messages.push(gone, kept, last);
    const store = new MemoryStore();
    await withCache(fake, store).readMessages("c1", { limit: 20 });

    // Deleted while no process was watching. The oldest message goes, so the check must cover the whole channel.
    fake.messages.splice(0, 1);

    const read = await withCache(fake, store).readMessages("c1", { limit: 20 });

    expect(read.map((x) => x.content)).toEqual(["b", "c"]);
    expect(store.range("c1", { limit: 10 }).map((x) => x.id)).toEqual([kept.id, last.id]);
  });

  it("capped catch up records gap", async () => {
    const { fake, store, newer } = seedCapped(1150);
    const port = withCache(fake, store);

    await port.readMessages("c1", { limit: 20 });

    // Paging stopped after 1000 messages. The newest 100 start at newer[1050].
    expect(store.gaps("c1")).toEqual([{ afterId: newer[999]!.id, beforeId: newer[1050]!.id }]);
  });

  it("read in gap uses api and shrinks gap", async () => {
    const { fake, store, newer } = seedCapped(1150);
    const port = withCache(fake, store);
    await port.readMessages("c1", { limit: 20 });
    const reads = fake.apiReads;

    const page = await port.readMessages("c1", { limit: 20, after: newer[999]!.id });

    expect(fake.apiReads).toBe(reads + 1);
    const expected = Array.from({ length: 20 }, (_, i) => `n${1000 + i}`);
    expect(page.map((m) => m.content)).toEqual(expected);
    expect(store.range("c1", { limit: 20, after: newer[999]!.id }).map((m) => m.content)).toEqual(expected);
    // The page covered the start of the gap, so the gap now starts at its last id.
    expect(store.gaps("c1")).toEqual([{ afterId: newer[1019]!.id, beforeId: newer[1050]!.id }]);
  });

  it("read covering whole gap removes it", async () => {
    const { fake, store, newer } = seedCapped(1150);
    const port = withCache(fake, store);
    await port.readMessages("c1", { limit: 20 });

    const page = await port.readMessages("c1", { limit: 100, after: newer[999]!.id });

    expect(page).toHaveLength(100);
    expect(page[99]!.content).toBe("n1099");
    expect(store.gaps("c1")).toEqual([]);
  });

  it("no gap when not capped", async () => {
    // 250 new messages: two full pages and a short one, so paging is not capped.
    const { fake, store } = seedCapped(250);
    const port = withCache(fake, store);

    const read = await port.readMessages("c1", { limit: 20 });

    expect(read).toHaveLength(20);
    expect(store.range("c1", { limit: 1000 })).toHaveLength(251);
    expect(store.gaps("c1")).toEqual([]);
  });
});
