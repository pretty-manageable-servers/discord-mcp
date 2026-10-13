import { z } from "zod";
import type { ToolContext } from "./context.js";
import { ok, fail, pickChannel } from "./context.js";
import { waitForMessage } from "../wait.js";

export function registerAgentTools(ctx: ToolContext): void {
  const { server, discord, config } = ctx;

  server.registerTool(
    "whoami",
    { description: "Return this bot's Discord id and name, and the agent name it runs as." },
    async () => {
      try {
        const me = await discord.ready();
        return ok({ botId: me.botId, botName: me.botName, agentName: config.agentName ?? me.botName });
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
      inputSchema: {
        channel_id: z.string().optional().describe("Channel or thread id. Default: DISCORD_DEFAULT_CHANNEL_ID."),
        after: z.string().regex(/^\d+$/, "after must be a message id").optional()
          .describe("Only return messages newer than this message id."),
        from: z.union([z.enum(["bots", "humans", "all"]), z.array(z.string())]).default("all")
          .describe("Author filter: bots, humans, all, or a list of author ids."),
        to_me: z.boolean().default(false)
          .describe("Only return messages addressed to this agent (agent-msg to, or a mention of this bot)."),
        timeout_s: z.number().int().min(1).max(600).default(300)
          .describe("Seconds to wait before returning code timeout."),
      },
    },
    async (args, extra) => {
      try {
        const channelId = pickChannel(config, args.channel_id);
        const me = await discord.ready();
        const selfNames = [config.agentName, me.botName].filter((s): s is string => Boolean(s));
        const message = await waitForMessage(discord, {
          channelId,
          after: args.after,
          from: args.from,
          toMe: args.to_me,
          timeoutMs: args.timeout_s * 1000,
          selfId: me.botId,
          selfNames,
          signal: extra.signal,
        });
        return ok(message);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
