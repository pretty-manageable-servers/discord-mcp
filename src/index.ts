#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openSession, runCli } from "./cli.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

// No arguments, or `mcp`: the stdio MCP server. Anything else is a CLI command.
async function serveMcp() {
  const config = loadConfig(process.env);
  // stdout is the MCP channel; log to stderr only.
  const session = await openSession(config, console.error);

  const shutdown = () => {
    session.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const server = buildServer(session.port, config, session.store);
  await server.connect(new StdioServerTransport());
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "mcp")) {
    await serveMcp();
    return;
  }
  const code = await runCli(argv);
  // Exit once the output is flushed. The command has already closed Discord and the store.
  process.stdout.write("", () => process.exit(code));
}

main().catch((err) => {
  // stdout may be the MCP channel; log to stderr only.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
