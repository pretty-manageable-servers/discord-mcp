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
}

export interface GuildView { id: string; name: string }
export interface ChannelView { id: string; name: string; type: string }
export interface BotIdentity { botId: string; botName: string }
