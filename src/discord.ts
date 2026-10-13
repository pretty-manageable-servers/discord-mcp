import type { DiscordPort } from "./port.js";

// WP1 implements this with discord.js (intents: Guilds, GuildMessages, MessageContent).
export function createDiscord(_token: string): DiscordPort {
  throw new Error("not built: WP1");
}
