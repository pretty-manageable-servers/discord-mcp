import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { FakeDiscord } from "./fake-discord.js";

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

describe("write tools", () => {
  it("send blocked with empty allowlist", async () => {
    const fake = new FakeDiscord();
    const client = await connect(fake, baseConfig);
    const { isError, body } = await call(client, "send_message", { channel_id: "c1", content: "hi" });
    expect(isError).toBe(true);
    expect(body.code).toBe("channel_not_allowed");
    expect(body.message).toContain("DISCORD_ALLOWED_CHANNEL_IDS");
    expect(fake.messages).toHaveLength(0);
  });

  it("send blocked outside allowlist", async () => {
    const fake = new FakeDiscord();
    const client = await connect(fake, { ...baseConfig, allowedChannelIds: ["c9"] });
    const { isError, body } = await call(client, "send_message", { channel_id: "c1", content: "hi" });
    expect(isError).toBe(true);
    expect(body.code).toBe("channel_not_allowed");
    expect(fake.messages).toHaveLength(0);
  });

  it("send ok in allowlist", async () => {
    const fake = new FakeDiscord();
    const client = await connect(fake, { ...baseConfig, allowedChannelIds: ["c1"] });
    const { isError, body } = await call(client, "send_message", { channel_id: "c1", content: "hello" });
    expect(isError).toBe(false);
    expect(body.channelId).toBe("c1");
    expect(body.content).toBe("hello");
    expect(fake.messages).toHaveLength(1);
  });

  it("too_long over 2000", async () => {
    const fake = new FakeDiscord();
    const client = await connect(fake, { ...baseConfig, allowedChannelIds: ["c1"] });
    const { isError, body } = await call(client, "send_message", {
      channel_id: "c1",
      content: "x".repeat(2001),
    });
    expect(isError).toBe(true);
    expect(body.code).toBe("too_long");
    expect(fake.messages).toHaveLength(0);
  });

  it("reply_to sets reference", async () => {
    const fake = new FakeDiscord();
    const client = await connect(fake, { ...baseConfig, allowedChannelIds: ["c1"] });
    const { isError, body } = await call(client, "send_message", {
      channel_id: "c1",
      content: "reply",
      reply_to_id: "555",
    });
    expect(isError).toBe(false);
    expect(body.replyToId).toBe("555");
  });

  it("create thread", async () => {
    const fake = new FakeDiscord();
    const client = await connect(fake, { ...baseConfig, allowedChannelIds: ["c1"] });
    const { isError, body } = await call(client, "create_thread", {
      channel_id: "c1",
      name: "planning",
      message_id: "42",
    });
    expect(isError).toBe(false);
    expect(typeof body.id).toBe("string");
    expect(fake.threads).toHaveLength(1);
    expect(fake.threads[0]).toMatchObject({ channelId: "c1", name: "planning", messageId: "42", id: body.id });
  });

  it("add reaction", async () => {
    const fake = new FakeDiscord();
    const client = await connect(fake, { ...baseConfig, allowedChannelIds: ["c1"] });
    const { isError, body } = await call(client, "add_reaction", {
      channel_id: "c1",
      message_id: "42",
      emoji: "👍",
    });
    expect(isError).toBe(false);
    expect(body).toEqual({ ok: true });
    expect(fake.reactions).toEqual([{ channelId: "c1", messageId: "42", emoji: "👍" }]);
  });
});

describe("write tools with files", () => {
  it("mcp_send_message_files_input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dmcp-files-"));
    const file = join(dir, "note.txt");
    writeFileSync(file, "hello");
    const fake = new FakeDiscord();
    const client = await connect(fake, { ...baseConfig, allowedChannelIds: ["c1"] });
    const { isError, body } = await call(client, "send_message", {
      channel_id: "c1",
      content: "see file",
      files: [file],
    });
    expect(isError).toBe(false);
    expect(body.attachments).toEqual([{ name: "note.txt", url: "https://cdn.fake/note.txt", size: 5 }]);

    const tooMany = (await client.callTool({
      name: "send_message",
      arguments: { channel_id: "c1", content: "x", files: Array.from({ length: 11 }, () => file) },
    })) as unknown as RawResult;
    expect(tooMany.isError).toBe(true);
    expect(fake.messages).toHaveLength(1);
  });
});
