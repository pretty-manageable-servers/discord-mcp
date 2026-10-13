import { ConfigError } from "./errors.js";

export interface Config {
  token: string;
  allowedChannelIds: string[];
  defaultChannelId?: string;
  agentName?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const token = env.DISCORD_BOT_TOKEN?.trim();
  if (!token) throw new ConfigError("DISCORD_BOT_TOKEN is required");
  const allowedChannelIds = (env.DISCORD_ALLOWED_CHANNEL_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    token,
    allowedChannelIds,
    defaultChannelId: env.DISCORD_DEFAULT_CHANNEL_ID?.trim() || undefined,
    agentName: env.AGENT_NAME?.trim() || undefined,
  };
}
