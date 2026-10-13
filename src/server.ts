import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import type { DiscordPort } from "./port.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerAgentTools } from "./tools/agent.js";

export function buildServer(discord: DiscordPort, config: Config): McpServer {
  const server = new McpServer({ name: "discord-mcp", version: "0.1.0" });
  const ctx = { server, discord, config };
  registerReadTools(ctx);
  registerWriteTools(ctx);
  registerAgentTools(ctx);
  return server;
}
