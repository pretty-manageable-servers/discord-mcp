import { z } from "zod";
import type { ToolContext } from "./context.js";
import { fail, ok } from "./context.js";
import type { MessageStore } from "../store.js";
import { ToolError } from "../errors.js";
import type { MessageView } from "../types.js";

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

export const searchMessagesShape = {
  query: z.string().optional().describe("Words to find in the message text"),
  channel_id: z.string().optional().describe("Only messages in this channel or thread"),
  author_id: z.string().optional().describe("Only messages from this author ID"),
  since: z.string().optional().describe("Only messages at or after this ISO time"),
  until: z.string().optional().describe("Only messages before this ISO time"),
  limit: z.number().int().optional().describe("Number of messages, 1 to 100. Default 20"),
};

export const searchMessagesInput = z.object(searchMessagesShape);
export type SearchMessagesInput = z.infer<typeof searchMessagesInput>;

export function searchMessages(
  store: MessageStore,
  input: SearchMessagesInput,
): { results: MessageView[]; note: string } {
  if (!filled(input.query) && !filled(input.channel_id) && !filled(input.author_id)) {
    throw new ToolError("bad_input", "give at least one of query, channel_id or author_id");
  }
  checkDate("since", input.since);
  checkDate("until", input.until);
  const n = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
  const results = store.search({
    text: optional(input.query),
    channelId: optional(input.channel_id),
    authorId: optional(input.author_id),
    since: input.since,
    until: input.until,
    limit: n,
  });
  return { results, note: CACHE_NOTE };
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
      inputSchema: searchMessagesShape,
    },
    async (args) => {
      try {
        return ok(searchMessages(store, args));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
