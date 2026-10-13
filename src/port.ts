import type { BotIdentity, ChannelView, GuildView, MessageView } from "./types.js";

// All Discord access goes through this interface. Only src/discord.ts implements it with discord.js.
export interface DiscordPort {
  ready(): Promise<BotIdentity>;
  listGuilds(): Promise<GuildView[]>;
  listChannels(guildId: string): Promise<ChannelView[]>;
  // Returns messages oldest first.
  readMessages(channelId: string, opts: { limit: number; after?: string; before?: string }): Promise<MessageView[]>;
  sendMessage(channelId: string, content: string, opts?: { replyToId?: string }): Promise<MessageView>;
  createThread(channelId: string, name: string, messageId?: string): Promise<{ id: string }>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  // Returns a function that removes the listener.
  onMessage(cb: (m: MessageView) => void): () => void;
}
