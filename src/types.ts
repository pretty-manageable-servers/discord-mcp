import type { EmbedView } from "./components.js";

export interface AgentMsg {
  to?: string;
  thread?: string;
  kind?: "request" | "reply" | "note";
}

export interface Attachment {
  name: string;
  url: string;
  size: number;
}

export interface MessageView {
  id: string;
  channelId: string;
  guildId: string | null;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
  createdAt: string;
  replyToId: string | null;
  threadId: string | null;
  attachments: Attachment[];
  agentMsg: AgentMsg | null;
  // Flattened text of Components V2 and action rows, in order. Empty when there are none.
  components: string[];
  embeds: EmbedView[];
}

export interface GuildView { id: string; name: string }
export interface ChannelView { id: string; name: string; type: string }
export interface BotIdentity { botId: string; botName: string }
