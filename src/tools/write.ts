import { z } from "zod";
import type { ToolContext } from "./context.js";
import { fail, ok, pickChannel } from "./context.js";
import type { Config } from "../config.js";
import { ToolError } from "../errors.js";
import { formatAgentMsg } from "../parse.js";

const MAX_CONTENT = 2000;

// Sending is off until DISCORD_ALLOWED_CHANNEL_IDS lists channels.
function requireAllowed(config: Config, channelId: string): void {
  if (config.allowedChannelIds.length === 0) {
    throw new ToolError("channel_not_allowed", "set DISCORD_ALLOWED_CHANNEL_IDS");
  }
  if (!config.allowedChannelIds.includes(channelId)) {
    throw new ToolError("channel_not_allowed", `channel ${channelId} is not in DISCORD_ALLOWED_CHANNEL_IDS`);
  }
}

export function registerWriteTools(ctx: ToolContext): void {
  const { server, discord, config } = ctx;

  server.registerTool(
    "send_message",
    {
      description:
        "Send a message to an allowed channel. Max 2000 characters. " +
        "Optional agent_msg adds agent metadata (to, thread, kind) to the message.",
      inputSchema: {
        channel_id: z.string().optional().describe("Channel ID. Optional if DISCORD_DEFAULT_CHANNEL_ID is set"),
        content: z.string().describe("Message text"),
        reply_to_id: z.string().optional().describe("Message ID to reply to"),
        agent_msg: z
          .object({
            to: z.string().optional(),
            thread: z.string().optional(),
            kind: z.enum(["request", "reply", "note"]).optional(),
          })
          .optional()
          .describe("Agent metadata for agent-to-agent messages"),
      },
    },
    async ({ channel_id, content, reply_to_id, agent_msg }) => {
      try {
        const channel = pickChannel(config, channel_id);
        requireAllowed(config, channel);
        if (content.trim() === "") throw new ToolError("bad_input", "content is empty");
        const text = agent_msg ? formatAgentMsg(content, agent_msg) : content;
        if (text.length > MAX_CONTENT) {
          throw new ToolError("too_long", `content is ${text.length} characters, max is ${MAX_CONTENT}`);
        }
        return ok(await discord.sendMessage(channel, text, { replyToId: reply_to_id }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_thread",
    {
      description: "Create a thread in an allowed channel, optionally from a message.",
      inputSchema: {
        channel_id: z.string().optional().describe("Channel ID. Optional if DISCORD_DEFAULT_CHANNEL_ID is set"),
        name: z.string().min(1).max(100).describe("Thread name, 1 to 100 characters"),
        message_id: z.string().optional().describe("Message ID to start the thread from"),
      },
    },
    async ({ channel_id, name, message_id }) => {
      try {
        const channel = pickChannel(config, channel_id);
        requireAllowed(config, channel);
        return ok(await discord.createThread(channel, name, message_id));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "add_reaction",
    {
      description: "Add an emoji reaction to a message in an allowed channel.",
      inputSchema: {
        channel_id: z.string().describe("Channel ID of the message"),
        message_id: z.string().describe("Message ID to react to"),
        emoji: z.string().min(1).describe("Emoji to add"),
      },
    },
    async ({ channel_id, message_id, emoji }) => {
      try {
        requireAllowed(config, channel_id);
        await discord.react(channel_id, message_id, emoji);
        return ok({ ok: true });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
