#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createDiscord } from "./discord.js";
import { buildServer } from "./server.js";

async function main() {
  const config = loadConfig(process.env);
  const discord = createDiscord(config.token);
  await discord.ready();
  const server = buildServer(discord, config);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  // stdout is the MCP channel; log to stderr only.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
