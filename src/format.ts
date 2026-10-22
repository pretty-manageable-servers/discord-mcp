import type { MessageView } from "./types.js";

// One line per message: `<id> <HH:MM> UTC <author>: <text> [files: ...] ↩<reply id>`.
// Text is cut to `limit` characters when a limit is given.
export function messageLine(m: MessageView, limit?: number): string {
  let text = m.content;
  if (limit !== undefined && text.length > limit) text = `${text.slice(0, limit)}…`;
  const author = m.authorIsBot ? `${m.authorName} [bot]` : m.authorName;
  let line = `${m.id} ${m.createdAt.slice(11, 16)} UTC ${author}: ${text.replace(/\r?\n/g, "⏎")}`;
  if (m.attachments.length > 0) line += ` [files: ${m.attachments.map((a) => a.name).join(", ")}]`;
  if (m.replyToId) line += ` ↩${m.replyToId}`;
  return line;
}
