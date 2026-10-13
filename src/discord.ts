import {
  ChannelType,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  type Message,
  type PartialMessage,
  Partials,
} from "discord.js";
import { ToolError } from "./errors.js";
import { parseAgentMsg } from "./parse.js";
import type { DiscordPort } from "./port.js";
import type { BotIdentity, ChannelView, GuildView, MessageView } from "./types.js";

// Logs go to stderr only. stdout is the MCP channel.
function log(...args: unknown[]): void {
  console.error("[discord]", ...args);
}

function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function toView(message: Message): MessageView {
  const channel = message.channel;
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId ?? null,
    authorId: message.author.id,
    authorName: message.author.displayName,
    authorIsBot: message.author.bot,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    replyToId: message.reference?.messageId ?? null,
    threadId: channel.isThread() ? channel.id : null,
    attachments: [...message.attachments.values()].map((a) => ({
      name: a.name ?? "",
      url: a.url,
      size: a.size,
    })),
    agentMsg: parseAgentMsg(message.content),
  };
}

// Map discord.js errors to ToolError codes. ToolError passes through unchanged.
function toToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  if (err instanceof DiscordAPIError) {
    const code = Number(err.code);
    if (code === 50001 || code === 50013) return new ToolError("missing_permission", err.message);
    if (code === 10003 || code === 10008) return new ToolError("not_found", err.message);
    return new ToolError("discord_error", err.message);
  }
  return new ToolError("discord_error", err instanceof Error ? err.message : String(err));
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toToolError(err);
  }
}

export function createDiscord(token: string): DiscordPort {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    // Edits and deletes of messages sent before this process started arrive as partials.
    partials: [Partials.Message, Partials.Channel],
  });
  client.on(Events.Error, (err) => log("client error:", err.message));
  client.on(Events.Warn, (msg) => log("warn:", msg));

  let readyPromise: Promise<BotIdentity> | null = null;

  // Returns the channel only if it can hold text messages.
  async function textChannel(channelId: string) {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      throw new ToolError("not_found", `channel ${channelId} is not a text channel`);
    }
    return channel;
  }

  return {
    ready() {
      readyPromise ??= call(async () => {
        const ready = new Promise<BotIdentity>((resolve) => {
          client.once(Events.ClientReady, (c) => {
            log(`ready as ${c.user.username} (${c.user.id})`);
            resolve({ botId: c.user.id, botName: c.user.username });
          });
        });
        await client.login(token);
        return ready;
      });
      return readyPromise;
    },

    listGuilds() {
      return call(async (): Promise<GuildView[]> =>
        [...client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name })),
      );
    },

    listChannels(guildId: string) {
      return call(async (): Promise<ChannelView[]> => {
        const guild = await client.guilds.fetch(guildId);
        const channels = await guild.channels.fetch();
        const views: ChannelView[] = [];
        for (const channel of channels.values()) {
          if (channel && channel.isTextBased()) {
            views.push({ id: channel.id, name: channel.name, type: ChannelType[channel.type] });
          }
        }
        return views;
      });
    },

    readMessages(channelId, opts) {
      return call(async (): Promise<MessageView[]> => {
        const channel = await textChannel(channelId);
        const messages = await channel.messages.fetch({
          limit: opts.limit,
          after: opts.after,
          before: opts.before,
        });
        return [...messages.values()]
          .sort((a, b) => compareIds(a.id, b.id))
          .map(toView);
      });
    },

    sendMessage(channelId, content, opts) {
      return call(async (): Promise<MessageView> => {
        const channel = await textChannel(channelId);
        const sent = await channel.send({
          content,
          reply: opts?.replyToId ? { messageReference: opts.replyToId } : undefined,
          allowedMentions: { parse: [] },
        });
        return toView(sent);
      });
    },

    createThread(channelId, name, messageId) {
      return call(async (): Promise<{ id: string }> => {
        const channel = await textChannel(channelId);
        if (messageId) {
          const message = await channel.messages.fetch(messageId);
          const thread = await message.startThread({ name });
          return { id: thread.id };
        }
        if (!("threads" in channel)) {
          throw new ToolError("bad_input", `channel ${channelId} cannot hold threads`);
        }
        const thread = await channel.threads.create({ name });
        return { id: thread.id };
      });
    },

    react(channelId, messageId, emoji) {
      return call(async (): Promise<void> => {
        const channel = await textChannel(channelId);
        const message = await channel.messages.fetch(messageId);
        await message.react(emoji);
      });
    },

    onMessage(cb) {
      const handler = (m: Message) => cb(toView(m));
      client.on(Events.MessageCreate, handler);
      return () => {
        client.off(Events.MessageCreate, handler);
      };
    },

    onMessageUpdate(cb) {
      const handler = async (_old: unknown, m: Message | PartialMessage) => {
        try {
          cb(toView(m.partial ? await m.fetch() : m));
        } catch (err) {
          console.error("message update failed:", err instanceof Error ? err.message : err);
        }
      };
      client.on(Events.MessageUpdate, handler);
      return () => {
        client.off(Events.MessageUpdate, handler);
      };
    },

    onMessageDelete(cb) {
      const handler = (m: Message | PartialMessage) => cb({ channelId: m.channelId, id: m.id });
      client.on(Events.MessageDelete, handler);
      return () => {
        client.off(Events.MessageDelete, handler);
      };
    },
  };
}
