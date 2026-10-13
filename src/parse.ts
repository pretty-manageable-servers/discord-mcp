import type { AgentMsg } from "./types.js";

// WP1: read a fenced ```agent-msg JSON block from message text. Returns null if none or invalid.
export function parseAgentMsg(_content: string): AgentMsg | null {
  return null;
}

// WP1: add a fenced ```agent-msg block to the end of the text.
export function formatAgentMsg(content: string, _msg: AgentMsg): string {
  return content;
}
