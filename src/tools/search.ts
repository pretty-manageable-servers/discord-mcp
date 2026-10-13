import { z } from "zod";
import type { ToolContext } from "./context.js";
import { fail, ok } from "./context.js";
import type { MessageStore } from "../store.js";
import { ToolError } from "../errors.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const CACHE_NOTE =
  "Searches the local cache only: messages this bot has seen or read. Use read_messages to fill a channel first.";

function filled(s: string | undefined): s is string {
  return s !== undefined && s.trim() !== "";
}

function optional(s: string | undefined): string | undefined {
  return filled(s) ? s : undefined;
}

function checkDate(name: string, value: string | undefined): void {
  if (value !== undefined && Number.isNaN(Date.parse(value))) {
    throw new ToolError("bad_input", `${name} must be an ISO date`);
  }
}

// WP6d: search_messages tool over the local store.
export function registerSearchTools(ctx: ToolContext, store: MessageStore): void {
  const { server } = ctx;

  server.registerTool(
    "search_messages",
    {
      description:
        `${CACHE_NOTE} ` +
        "Search cached messages, newest first. Give at least one of query, channel_id or author_id. " +
        "Default limit 20, max 100.",
      inputSchema: {
        query: z.string().optional().describe("Words to find in the message text"),
        channel_id: z.string().optional().describe("Only messages in this channel or thread"),
        author_id: z.string().optional().describe("Only messages from this author ID"),
        since: z.string().optional().describe("Only messages at or after this ISO time"),
        until: z.string().optional().describe("Only messages before this ISO time"),
        limit: z.number().int().optional().describe("Number of messages, 1 to 100. Default 20"),
      },
    },
    async ({ query, channel_id, author_id, since, until, limit }) => {
      try {
        if (!filled(query) && !filled(channel_id) && !filled(author_id)) {
          throw new ToolError("bad_input", "give at least one of query, channel_id or author_id");
        }
        checkDate("since", since);
        checkDate("until", until);
        const n = Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT));
        const results = store.search({
          text: optional(query),
          channelId: optional(channel_id),
          authorId: optional(author_id),
          since,
          until,
          limit: n,
        });
        return ok({ results, note: CACHE_NOTE });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
