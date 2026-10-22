import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCli } from "../src/cli.js";
import { allowedMentionsFor } from "../src/discord.js";
import type { Config } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { FakeDiscord } from "./fake-discord.js";

const USER = "123456789012345678";
const config: Config = { token: "t", allowedChannelIds: ["c1"] };

async function connect(fake: FakeDiscord): Promise<Client> {
  const server = buildServer(fake, config);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("mentions", () => {
  it("send_mention_sets_allowed_users", async () => {
    const fake = new FakeDiscord();
    const client = await connect(fake);
    const res = (await client.callTool({
      name: "send_message",
      arguments: { channel_id: "c1", content: "ping me", mention: [USER] },
    })) as unknown as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).not.toBe(true);
    expect(fake.messages[0].content).toBe(`<@${USER}> ping me`);
    expect(fake.lastSendOpts?.mentions).toEqual([USER]);
    expect(allowedMentionsFor({ mentions: [USER] })).toEqual({ parse: [], users: [USER] });
    expect(allowedMentionsFor({ mentions: [USER], replyToId: "5" })).toEqual({
      parse: [],
      users: [USER],
      repliedUser: true,
    });

    const out: string[] = [];
    const code = await runCli(["send", "--channel", "c1", "--content", "hi", "--mention", USER], {
      port: fake,
      config,
      stdout: (t) => out.push(t),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(fake.messages[1].content).toBe(`<@${USER}> hi`);
    expect(fake.lastSendOpts?.mentions).toEqual([USER]);
  });

  it("send_without_mention_pings_nobody", async () => {
    const fake = new FakeDiscord();
    const client = await connect(fake);
    await client.callTool({ name: "send_message", arguments: { channel_id: "c1", content: "hello all" } });
    expect(fake.messages[0].content).toBe("hello all");
    expect(fake.lastSendOpts?.mentions).toBeUndefined();
    expect(allowedMentionsFor()).toEqual({ parse: [], users: [] });
    expect(allowedMentionsFor({ replyToId: "5" })).toEqual({ parse: [], users: [] });
  });

  it("mention_already_in_content_is_not_repeated", async () => {
    const fake = new FakeDiscord();
    const client = await connect(fake);
    await client.callTool({
      name: "send_message",
      arguments: { channel_id: "c1", content: `hey <@${USER}>`, mention: [USER] },
    });
    expect(fake.messages[0].content).toBe(`hey <@${USER}>`);
  });
});
