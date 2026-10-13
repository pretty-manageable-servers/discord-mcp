import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { FakeDiscord, makeMessage } from "./fake-discord.js";

type RawResult = { isError?: boolean; content: { type: string; text: string }[] };

async function connect(fake: FakeDiscord, config: Config): Promise<Client> {
  const server = buildServer(fake, config);
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

describe("read tools", () => {
  it("lists guilds", async () => {
    const fake = new FakeDiscord();
    const client = await connect(fake, baseConfig);
    const { isError, body } = await call(client, "list_guilds");
    expect(isError).toBe(false);
    expect(body).toEqual([{ id: "g1", name: "Test" }]);
  });

  it("read limit clamp", async () => {
    const fake = new FakeDiscord();
    for (let i = 0; i < 120; i++) {
      fake.push(makeMessage({ channelId: "c1", content: `m${i}` }));
    }
    const client = await connect(fake, baseConfig);
    const { isError, body } = await call(client, "read_messages", { channel_id: "c1", limit: 500 });
    expect(isError).toBe(false);
    expect(body).toHaveLength(100);
    // Oldest first: the last returned message is the newest one.
    expect(body[body.length - 1].content).toBe("m119");
    expect(body[0].content).toBe("m20");
  });

  it("read uses default channel", async () => {
    const fake = new FakeDiscord();
    fake.push(makeMessage({ channelId: "c1", content: "in default" }));
    fake.push(makeMessage({ channelId: "c2", content: "in other" }));
    const client = await connect(fake, { ...baseConfig, defaultChannelId: "c1" });
    const { isError, body } = await call(client, "read_messages");
    expect(isError).toBe(false);
    expect(body).toHaveLength(1);
    expect(body[0].content).toBe("in default");
    expect(body[0].channelId).toBe("c1");
  });

  it("read without channel fails bad_input", async () => {
    const fake = new FakeDiscord();
    const client = await connect(fake, baseConfig);
    const { isError, body } = await call(client, "read_messages");
    expect(isError).toBe(true);
    expect(body.code).toBe("bad_input");
  });
});
