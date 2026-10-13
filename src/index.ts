#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { withCache } from "./cached.js";
import { loadConfig } from "./config.js";
import { createDiscord } from "./discord.js";
import { buildServer } from "./server.js";
import { openStore } from "./store.js";

async function main() {
  const config = loadConfig(process.env);
  const discord = createDiscord(config.token);
  const me = await discord.ready();

  const dbPath = config.dbPath ?? join(homedir(), ".cache", "discord-mcp", `${me.botId}.db`);
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = openStore(dbPath);
  // stdout is the MCP channel; log to stderr only.
  console.error(`discord-mcp: message cache at ${dbPath}`);

  const port = withCache(discord, store);
  const server = buildServer(port, config, store);

  const shutdown = () => {
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  // stdout is the MCP channel; log to stderr only.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
