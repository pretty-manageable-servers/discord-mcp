import { z } from "zod";
import type { ToolContext, ToolDeps } from "./context.js";
import { fail, ok, pickChannel } from "./context.js";
import type { ChannelView, GuildView, MessageView } from "../types.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const listChannelsShape = {
  guild_id: z.string().describe("Discord server (guild) ID"),
};

export const readMessagesShape = {
  channel_id: z.string().optional().describe("Channel ID. Optional if DISCORD_DEFAULT_CHANNEL_ID is set"),
  limit: z.number().int().optional().describe("Number of messages, 1 to 100. Default 20"),
  after: z.string().optional().describe("Only messages after this message ID"),
  before: z.string().optional().describe("Only messages before this message ID"),
};

export const readMessagesInput = z.object(readMessagesShape);
export type ReadMessagesInput = z.infer<typeof readMessagesInput>;

export function listGuilds(deps: ToolDeps): Promise<GuildView[]> {
  return deps.discord.listGuilds();
}

export function listChannels(deps: ToolDeps, guildId: string): Promise<ChannelView[]> {
  return deps.discord.listChannels(guildId);
}

export async function readMessages(deps: ToolDeps, input: ReadMessagesInput): Promise<MessageView[]> {
  const channel = pickChannel(deps.config, input.channel_id);
  const n = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
  return deps.discord.readMessages(channel, { limit: n, after: input.after, before: input.before });
}

export function registerReadTools(ctx: ToolContext): void {
  const { server } = ctx;

  server.registerTool(
    "list_guilds",
    {
      description: "List the Discord servers (guilds) the bot is in.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await listGuilds(ctx));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_channels",
    {
      description: "List the channels of one Discord server (guild).",
      inputSchema: listChannelsShape,
    },
    async ({ guild_id }) => {
      try {
        return ok(await listChannels(ctx, guild_id));
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
      inputSchema: readMessagesShape,
    },
    async (args) => {
      try {
        return ok(await readMessages(ctx, args));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
