import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { FakeDiscord } from "./fake-discord.js";

describe("wp0", () => {
  it("config needs token", () => {
    expect(() => loadConfig({})).toThrow("DISCORD_BOT_TOKEN");
    expect(loadConfig({ DISCORD_BOT_TOKEN: "t", DISCORD_ALLOWED_CHANNEL_IDS: "a, b" }).allowedChannelIds).toEqual(["a", "b"]);
  });
  it("server builds", () => {
    expect(buildServer(new FakeDiscord(), loadConfig({ DISCORD_BOT_TOKEN: "t" }))).toBeTruthy();
  });
});
