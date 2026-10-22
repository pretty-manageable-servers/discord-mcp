import { statSync } from "node:fs";
import { z } from "zod";
import type { ToolContext, ToolDeps } from "./context.js";
import { fail, ok, pickChannel } from "./context.js";
import type { Config } from "../config.js";
import { ToolError } from "../errors.js";
import { formatAgentMsg } from "../parse.js";
import type { MessageView } from "../types.js";

const MAX_CONTENT = 2000;
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Sending is off until DISCORD_ALLOWED_CHANNEL_IDS lists channels.
function requireAllowed(config: Config, channelId: string): void {
  if (config.allowedChannelIds.length === 0) {
    throw new ToolError("channel_not_allowed", "set DISCORD_ALLOWED_CHANNEL_IDS");
  }
  if (!config.allowedChannelIds.includes(channelId)) {
    throw new ToolError("channel_not_allowed", `channel ${channelId} is not in DISCORD_ALLOWED_CHANNEL_IDS`);
  }
}

// Checks every file before anything is uploaded. Throws bad_input on the first problem.
export function checkFiles(paths: string[]): void {
  for (const path of paths) {
    let size: number;
    let isFile: boolean;
    try {
      const st = statSync(path);
      size = st.size;
      isFile = st.isFile();
    } catch {
      throw new ToolError("bad_input", `file not found: ${path}`);
    }
    if (!isFile) throw new ToolError("bad_input", `not a regular file: ${path}`);
    if (size > MAX_FILE_BYTES) {
      throw new ToolError("bad_input", `file ${path} is ${size} bytes, max is ${MAX_FILE_BYTES} (10 MB)`);
    }
  }
}

// A user id to ping. Discord snowflakes are 17 to 20 digits.
export const mentionIdSchema = z.string().regex(/^\d{17,20}$/, "mention must be a user id (17 to 20 digits)");

// Adds <@id> to the start of content for each id that content does not already mention.
export function withMentions(content: string, mentions: string[]): string {
  const missing = mentions.filter((id) => !content.includes(`<@${id}>`) && !content.includes(`<@!${id}>`));
  return missing.map((id) => `<@${id}> `).join("") + content;
}

export const sendMessageShape = {
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
  files: z
    .array(z.string().min(1))
    .max(MAX_FILES)
    .optional()
    .describe("Local file paths to attach. At most 10 files, each at most 10 MB"),
  mention: z
    .array(mentionIdSchema)
    .optional()
    .describe("User IDs to ping. Adds <@id> to the start of the content if it is not there yet. Only these users ping"),
};

export const sendMessageInput = z.object(sendMessageShape);
export type SendMessageInput = z.infer<typeof sendMessageInput>;

export const createThreadShape = {
  channel_id: z.string().optional().describe("Channel ID. Optional if DISCORD_DEFAULT_CHANNEL_ID is set"),
  name: z.string().min(1).max(100).describe("Thread name, 1 to 100 characters"),
  message_id: z.string().optional().describe("Message ID to start the thread from"),
};

export const createThreadInput = z.object(createThreadShape);
export type CreateThreadInput = z.infer<typeof createThreadInput>;

export const addReactionShape = {
  channel_id: z.string().describe("Channel ID of the message"),
  message_id: z.string().describe("Message ID to react to"),
  emoji: z.string().min(1).describe("Emoji to add"),
};

export const addReactionInput = z.object(addReactionShape);
export type AddReactionInput = z.infer<typeof addReactionInput>;

export async function sendMessage(deps: ToolDeps, input: SendMessageInput): Promise<MessageView> {
  const channel = pickChannel(deps.config, input.channel_id);
  requireAllowed(deps.config, channel);
  if (input.content.trim() === "") throw new ToolError("bad_input", "content is empty");
  const body = input.mention && input.mention.length > 0 ? withMentions(input.content, input.mention) : input.content;
  const text = input.agent_msg ? formatAgentMsg(body, input.agent_msg) : body;
  if (text.length > MAX_CONTENT) {
    throw new ToolError("too_long", `content is ${text.length} characters, max is ${MAX_CONTENT}`);
  }
  const files = input.files && input.files.length > 0 ? input.files : undefined;
  if (files) checkFiles(files);
  const mentions = input.mention && input.mention.length > 0 ? input.mention : undefined;
  return deps.discord.sendMessage(channel, text, { replyToId: input.reply_to_id, files, mentions });
}

export async function createThread(deps: ToolDeps, input: CreateThreadInput): Promise<{ id: string }> {
  const channel = pickChannel(deps.config, input.channel_id);
  requireAllowed(deps.config, channel);
  return deps.discord.createThread(channel, input.name, input.message_id);
}

export async function addReaction(deps: ToolDeps, input: AddReactionInput): Promise<{ ok: true }> {
  requireAllowed(deps.config, input.channel_id);
  await deps.discord.react(input.channel_id, input.message_id, input.emoji);
  return { ok: true };
}

export function registerWriteTools(ctx: ToolContext): void {
  const { server } = ctx;

  server.registerTool(
    "send_message",
    {
      description:
        "Send a message to an allowed channel. Max 2000 characters. " +
        "Optional agent_msg adds agent metadata (to, thread, kind) to the message. " +
        "Optional files lists local file paths to attach: at most 10, each at most 10 MB. " +
        "Optional mention lists user IDs to ping; no one else pings.",
      inputSchema: sendMessageShape,
    },
    async (args) => {
      try {
        return ok(await sendMessage(ctx, args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_thread",
    {
      description: "Create a thread in an allowed channel, optionally from a message.",
      inputSchema: createThreadShape,
    },
    async (args) => {
      try {
        return ok(await createThread(ctx, args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "add_reaction",
    {
      description: "Add an emoji reaction to a message in an allowed channel.",
      inputSchema: addReactionShape,
    },
    async (args) => {
      try {
        return ok(await addReaction(ctx, args));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
