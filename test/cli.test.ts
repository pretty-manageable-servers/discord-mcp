import { mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliDeps } from "../src/cli.js";
import { withCache } from "../src/cached.js";
import type { Config } from "../src/config.js";
import { openStore, type MessageStore } from "../src/store.js";
import { FakeDiscord, makeMessage } from "./fake-discord.js";

const MB = 1024 * 1024;

let fake: FakeDiscord;
let store: MessageStore;
let out: string[];
let err: string[];
let dir: string;

function deps(config: Partial<Config> = {}): CliDeps {
  return {
    port: withCache(fake, store),
    store,
    config: { token: "t", allowedChannelIds: ["c1"], ...config },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  };
}

beforeEach(() => {
  fake = new FakeDiscord();
  store = openStore(":memory:");
  out = [];
  err = [];
  dir = mkdtempSync(join(tmpdir(), "dmcp-cli-"));
});

afterEach(() => {
  store.close();
});

describe("cli", () => {
  it("cli_send_prints_message_line", async () => {
    const code = await runCli(["send", "--channel", "c1", "--content", "hello"], deps());
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/^sent \d+ https:\/\/discord\.com\/channels\/g1\/c1\/\d+\n$/);
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0].content).toBe("hello");
  });

  it("cli_send_prints_json_with_json_flag", async () => {
    const code = await runCli(["send", "--json", "--channel", "c1", "--content", "hello"], deps());
    expect(code).toBe(0);
    const body = JSON.parse(out.join(""));
    expect(body.content).toBe("hello");
    expect(body.url).toMatch(/\/channels\/g1\/c1\//);
  });

  it("cli_send_with_files_attaches", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "hello");
    const code = await runCli(["send", "--channel", "c1", "--content", "see", "--file", file], deps());
    expect(code).toBe(0);
    expect(out.join("")).toContain("file a.txt 5B\n");
    expect(fake.messages[0].attachments).toEqual([{ name: "a.txt", url: "https://cdn.fake/a.txt", size: 5 }]);
  });

  it("cli_file_over_10mb_rejected_before_upload", async () => {
    const file = join(dir, "big.bin");
    writeFileSync(file, "");
    truncateSync(file, 10 * MB + 1);
    const code = await runCli(["send", "--channel", "c1", "--content", "x", "--file", file], deps());
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/^error bad_input: file .* max is/);
    expect(fake.messages).toHaveLength(0);
  });

  it("cli_send_outside_allowed_channel_fails", async () => {
    const code = await runCli(["send", "--channel", "c9", "--content", "hi"], deps());
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/^error channel_not_allowed: /);
    expect(fake.messages).toHaveLength(0);
  });

  it("cli_wait_returns_matching_message", async () => {
    const pending = runCli(["wait", "--channel", "c1", "--from", "humans", "--timeout", "5"], deps());
    await new Promise((r) => setTimeout(r, 20));
    fake.push(makeMessage({ channelId: "c1", content: "pong", authorId: "u9", authorName: "bot-b" }));
    const code = await pending;
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/ bot-b: pong\n$/);
  });

  it("cli_read_prints_one_line_per_message", async () => {
    fake.push(makeMessage({ channelId: "c1", content: "line one\nline two", authorName: "ann", createdAt: "2026-10-22T16:05:09.000Z" }));
    fake.push(makeMessage({
      channelId: "c1", content: "answer", authorName: "bot-b", authorIsBot: true,
      replyToId: "1001", attachments: [{ name: "a.png", url: "u", size: 3 }],
    }));
    const code = await runCli(["read", "--channel", "c1"], deps());
    expect(code).toBe(0);
    const lines = out.join("").trimEnd().split("\n");
    expect(lines[0]).toMatch(/^\d+ 16:05 UTC ann: line one⏎line two$/);
    expect(lines[1]).toMatch(/^\d+ \d\d:\d\d UTC bot-b \[bot\]: answer \[files: a\.png\] ↩1001$/);
  });

  it("cli_unknown_command_exits_2", async () => {
    const code = await runCli(["bogus"], deps());
    expect(code).toBe(2);
    expect(err.join("")).toContain("unknown command: bogus");
    expect(err.join("")).toContain("discord-mcp <command>");
  });
});
