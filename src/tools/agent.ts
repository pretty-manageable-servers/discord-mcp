import { z } from "zod";
import type { ToolContext, ToolDeps } from "./context.js";
import { fail, ok, pickChannel } from "./context.js";
import { waitForMessage, type FinalOptions } from "../wait.js";
import type { MessageView } from "../types.js";

export const waitForMessageShape = {
  channel_id: z.string().optional().describe("Channel or thread id. Default: DISCORD_DEFAULT_CHANNEL_ID."),
  after: z.string().regex(/^\d+$/, "after must be a message id").optional()
    .describe("Only return messages newer than this message id."),
  from: z.union([z.enum(["bots", "humans", "all"]), z.array(z.string())]).default("all")
    .describe("Author filter: bots, humans, all, or a list of author ids."),
  to_me: z.boolean().default(false)
    .describe("Only return messages addressed to this agent (agent-msg to, or a mention of this bot)."),
  contains: z.string().min(1).optional()
    .describe("Only return messages whose text includes this string."),
  timeout_s: z.number().int().min(1).max(600).default(300)
    .describe("Seconds to wait before returning code timeout."),
};

export const waitForMessageInput = z.object(waitForMessageShape);
export type WaitForMessageInput = z.infer<typeof waitForMessageInput>;

export async function whoami(deps: ToolDeps): Promise<{ botId: string; botName: string; agentName: string }> {
  const me = await deps.discord.ready();
  return { botId: me.botId, botName: me.botName, agentName: deps.config.agentName ?? me.botName };
}

// final: CLI only. Returns the first match once it has gone quiet, not while it is progress.
export async function waitFor(
  deps: ToolDeps,
  input: WaitForMessageInput,
  signal?: AbortSignal,
  final?: FinalOptions,
): Promise<MessageView> {
  const channelId = pickChannel(deps.config, input.channel_id);
  const me = await deps.discord.ready();
  const selfNames = [deps.config.agentName, me.botName].filter((s): s is string => Boolean(s));
  return waitForMessage(deps.discord, {
    channelId,
    after: input.after,
    from: input.from,
    toMe: input.to_me,
    contains: input.contains,
    timeoutMs: input.timeout_s * 1000,
    selfId: me.botId,
    selfNames,
    signal,
    final,
  });
}

export function registerAgentTools(ctx: ToolContext): void {
  const { server } = ctx;

  server.registerTool(
    "whoami",
    { description: "Return this bot's Discord id and name, and the agent name it runs as." },
    async () => {
      try {
        return ok(await whoami(ctx));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "wait_for_message",
    {
      description:
        "Blocks until a matching message arrives. Pass `after` = last message id you saw so you do not miss messages sent while you were busy. Returns code timeout if none.",
      inputSchema: waitForMessageShape,
    },
    async (args, extra) => {
      try {
        return ok(await waitFor(ctx, args, extra.signal));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
