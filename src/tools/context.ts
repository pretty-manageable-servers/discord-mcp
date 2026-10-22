import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import type { DiscordPort } from "../port.js";
import { ToolError } from "../errors.js";

// What a tool function needs. The MCP server and the CLI both pass one of these.
export interface ToolDeps {
  discord: DiscordPort;
  config: Config;
}

export interface ToolContext extends ToolDeps {
  server: McpServer;
}

// Shared result helpers for all tools.
export function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function fail(err: unknown) {
  const body = err instanceof ToolError
    ? { code: err.code, message: err.message }
    : { code: "discord_error", message: err instanceof Error ? err.message : String(err) };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

export function pickChannel(config: Config, channelId?: string): string {
  const id = channelId ?? config.defaultChannelId;
  if (!id) throw new ToolError("bad_input", "channel_id is required (no DISCORD_DEFAULT_CHANNEL_ID set)");
  return id;
}
