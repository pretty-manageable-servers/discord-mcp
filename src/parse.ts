import type { AgentMsg } from "./types.js";

const KINDS = ["request", "reply", "note"] as const;
type Kind = (typeof KINDS)[number];

// A fenced block that starts with ```agent-msg and ends at the next ```.
const BLOCK = /```agent-msg[ \t\r\n]([\s\S]*?)```/g;

function isKind(v: unknown): v is Kind {
  return typeof v === "string" && (KINDS as readonly string[]).includes(v);
}

// Read the LAST ```agent-msg block. Returns null if no block, bad JSON, or not an object.
// Keeps only to, thread and kind, and only when they have the right type.
export function parseAgentMsg(content: string): AgentMsg | null {
  let body: string | null = null;
  for (const match of content.matchAll(BLOCK)) body = match[1];
  if (body === null) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;
  const msg: AgentMsg = {};
  if (typeof obj.to === "string") msg.to = obj.to;
  if (typeof obj.thread === "string") msg.thread = obj.thread;
  if (isKind(obj.kind)) msg.kind = obj.kind;
  return msg;
}

// Add a ```agent-msg block to the end of the text.
// JSON.stringify skips undefined values, so unset keys are dropped.
export function formatAgentMsg(content: string, msg: AgentMsg): string {
  return `${content}\n\`\`\`agent-msg\n${JSON.stringify(msg)}\n\`\`\``;
}
