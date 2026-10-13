import { z } from "zod";
import type { ToolContext } from "./context.js";
import { fail, ok, pickChannel } from "./context.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function registerReadTools(ctx: ToolContext): void {
  const { server, discord, config } = ctx;

  server.registerTool(
    "list_guilds",
    {
      description: "List the Discord servers (guilds) the bot is in.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await discord.listGuilds());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_channels",
    {
      description: "List the channels of one Discord server (guild).",
      inputSchema: {
        guild_id: z.string().describe("Discord server (guild) ID"),
      },
    },
    async ({ guild_id }) => {
      try {
        return ok(await discord.listChannels(guild_id));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "read_messages",
    {
      description:
        "Read recent messages from a channel, oldest first. Default limit 20, max 100. " +
        "Uses DISCORD_DEFAULT_CHANNEL_ID when channel_id is not given.",
      inputSchema: {
        channel_id: z.string().optional().describe("Channel ID. Optional if DISCORD_DEFAULT_CHANNEL_ID is set"),
        limit: z.number().int().optional().describe("Number of messages, 1 to 100. Default 20"),
        after: z.string().optional().describe("Only messages after this message ID"),
        before: z.string().optional().describe("Only messages before this message ID"),
      },
    },
    async ({ channel_id, limit, after, before }) => {
      try {
        const channel = pickChannel(config, channel_id);
        const n = Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT));
        return ok(await discord.readMessages(channel, { limit: n, after, before }));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
