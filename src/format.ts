import type { MessageView } from "./types.js";
import { embedText } from "./components.js";

// Cut to `limit` characters when a limit is given.
function cut(text: string, limit?: number): string {
  return limit !== undefined && text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function oneLine(text: string): string {
  return text.replace(/\r?\n/g, "⏎");
}

// One line per message:
// `<id> <HH:MM> UTC <author>: <text> [card: ...] [embed: ...] [files: ...] ↩<reply id>`.
// Text, card and embed are each cut to `limit` characters when a limit is given.
export function messageLine(m: MessageView, limit?: number): string {
  const author = m.authorIsBot ? `${m.authorName} [bot]` : m.authorName;
  const parts = [`${m.id} ${m.createdAt.slice(11, 16)} UTC ${author}:`];
  if (m.content.length > 0) parts.push(oneLine(cut(m.content, limit)));
  if (m.components.length > 0) parts.push(`[card: ${oneLine(cut(m.components.join(" | "), limit))}]`);
  const embeds = embedText(m.embeds);
  if (embeds.length > 0) parts.push(`[embed: ${oneLine(cut(embeds, limit))}]`);
  if (m.attachments.length > 0) parts.push(`[files: ${m.attachments.map((a) => a.name).join(", ")}]`);
  if (m.replyToId) parts.push(`↩${m.replyToId}`);
  return parts.join(" ");
}
