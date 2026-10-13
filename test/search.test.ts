import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "../src/config.js";
import { buildServer } from "../src/server.js";
import type { MessageStore, SearchQuery } from "../src/store.js";
import type { MessageView } from "../src/types.js";
import { FakeDiscord, makeMessage } from "./fake-discord.js";

type RawResult = { isError?: boolean; content: { type: string; text: string }[] };

// Fake store: records each SearchQuery and returns fixed rows.
class FakeStore implements MessageStore {
  calls: SearchQuery[] = [];
  rows: MessageView[] = [];

  search(q: SearchQuery): MessageView[] {
    this.calls.push(q);
    return this.rows;
  }
  upsert(): void { throw new Error("not used"); }
  upsertMany(): void { throw new Error("not used"); }
  markDeleted(): void { throw new Error("not used"); }
  range(): MessageView[] { throw new Error("not used"); }
  newestId(): string | null { throw new Error("not used"); }
  isSynced(): boolean { throw new Error("not used"); }
  markSynced(): void { throw new Error("not used"); }
  close(): void {}
}

async function connect(fake: FakeDiscord, config: Config, store?: MessageStore): Promise<Client> {
  const server = buildServer(fake, config, store);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as unknown as RawResult;
  return { isError: res.isError === true, body: JSON.parse(res.content[0].text) as any };
}

const baseConfig: Config = { token: "t", allowedChannelIds: [] };

describe("search tools", () => {
  it("search passes filters", async () => {
    const store = new FakeStore();
    const row = makeMessage({ channelId: "c1", authorId: "u1", content: "hello there" });
    store.rows = [row];
    const client = await connect(new FakeDiscord(), baseConfig, store);
    const since = "2026-01-01T00:00:00.000Z";
    const until = "2026-02-01T00:00:00.000Z";
    const { isError, body } = await call(client, "search_messages", {
      query: "hello",
      channel_id: "c1",
      author_id: "u1",
      since,
      until,
      limit: 5,
    });
    expect(isError).toBe(false);
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toEqual({
      text: "hello",
      channelId: "c1",
      authorId: "u1",
      since,
      until,
      limit: 5,
    });
    expect(body.results).toEqual([row]);
    expect(body.note).toContain("local cache");
  });

  it("search needs a filter", async () => {
    const store = new FakeStore();
    const client = await connect(new FakeDiscord(), baseConfig, store);
    const { isError, body } = await call(client, "search_messages", { limit: 5 });
    expect(isError).toBe(true);
    expect(body.code).toBe("bad_input");
    expect(store.calls).toHaveLength(0);
  });

  it("search limit clamp", async () => {
    const store = new FakeStore();
    const client = await connect(new FakeDiscord(), baseConfig, store);
    await call(client, "search_messages", { query: "x", limit: 500 });
    await call(client, "search_messages", { query: "x", limit: 0 });
    await call(client, "search_messages", { query: "x" });
    expect(store.calls.map((q) => q.limit)).toEqual([100, 1, 20]);
  });

  it("search bad date", async () => {
    const store = new FakeStore();
    const client = await connect(new FakeDiscord(), baseConfig, store);
    const { isError, body } = await call(client, "search_messages", {
      query: "x",
      since: "not a date",
    });
    expect(isError).toBe(true);
    expect(body.code).toBe("bad_input");
    expect(store.calls).toHaveLength(0);
  });

  it("search not registered without store", async () => {
    const client = await connect(new FakeDiscord(), baseConfig);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("search_messages");
  });
});
