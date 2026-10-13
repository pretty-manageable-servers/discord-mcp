import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const live = Boolean(process.env.LIVE_TOKEN_A);
const channel = process.env.LIVE_CHANNEL_ID ?? "";
const tag = `run-${Date.now().toString(36)}`;

async function start(token: string, agent: string, db: string): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.DISCORD_BOT_TOKEN = token;
  env.DISCORD_ALLOWED_CHANNEL_IDS = channel;
  env.DISCORD_DEFAULT_CHANNEL_ID = channel;
  env.AGENT_NAME = agent;
  env.DISCORD_MCP_DB = db;
  const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env });
  const client = new Client({ name: `live-${agent}`, version: "0.0.0" });
  await client.connect(transport);
  return client;
}

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }> };

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as Result;
  const text = r.content.map((x) => x.text ?? "").join("");
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { isError: Boolean(r.isError), data };
}

async function callOk(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await call(c, name, args);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.data)}`);
  return r.data;
}

describe.skipIf(!live)("live two bots", { timeout: 90_000 }, () => {
  let dir: string;
  let a: Client;
  let b: Client;
  let aId = "";
  let reply: any;
  let request: any;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "discord-mcp-live-"));
    a = await start(process.env.LIVE_TOKEN_A!, "live-a", join(dir, "a.db"));
    b = await start(process.env.LIVE_TOKEN_B!, "live-b", join(dir, "b.db"));
  }, 90_000);

  afterAll(async () => {
    await a?.close();
    await b?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("whoami both", async () => {
    const wa = await callOk(a, "whoami");
    const wb = await callOk(b, "whoami");
    expect(wa.botId).toBeTruthy();
    expect(wb.botId).toBeTruthy();
    expect(wa.botId).not.toBe(wb.botId);
    aId = wa.botId;
  });

  it("read and cache", async () => {
    const first = await callOk(a, "read_messages", { limit: 5 });
    expect(Array.isArray(first)).toBe(true);
    const second = await callOk(a, "read_messages", { limit: 5 });
    expect(Array.isArray(second)).toBe(true);
  });

  it("a asks b and b replies", async () => {
    const recent = await callOk(b, "read_messages", { limit: 1 });
    const last: string | undefined = recent.length ? recent[recent.length - 1].id : undefined;
    const waiting = call(b, "wait_for_message", {
      after: last,
      to_me: true,
      from: "bots",
      timeout_s: 30,
    });
    request = await callOk(a, "send_message", {
      content: `ping ${tag}`,
      agent_msg: { to: "live-b", thread: tag, kind: "request" },
    });
    const got = await waiting;
    expect(got.isError).toBe(false);
    expect(got.data.agentMsg.to).toBe("live-b");

    const waitReply = call(a, "wait_for_message", {
      after: got.data.id,
      to_me: true,
      from: "bots",
      timeout_s: 30,
    });
    reply = await callOk(b, "send_message", {
      content: `pong ${tag}`,
      reply_to_id: got.data.id,
      agent_msg: { to: "live-a", thread: tag, kind: "reply" },
    });
    const back = await waitReply;
    expect(back.isError).toBe(false);
    expect(back.data.agentMsg.to).toBe("live-a");
    expect(back.data.id).toBe(reply.id);
  });

  it("search finds the tag", async () => {
    const r = await callOk(a, "search_messages", { query: tag });
    expect(r.results.length).toBeGreaterThanOrEqual(1);
  });

  it("send outside allowlist fails", async () => {
    const r = await call(a, "send_message", { channel_id: "1", content: "nope" });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("channel_not_allowed");
  });

  it("reaction and thread", async () => {
    await callOk(a, "add_reaction", { channel_id: channel, message_id: reply.id, emoji: "✅" });
    const t = await callOk(a, "create_thread", {
      channel_id: channel,
      name: `live-${tag}`,
      message_id: request.id,
    });
    expect(t).toBeTruthy();
    expect(aId).toBeTruthy();
  });
});
