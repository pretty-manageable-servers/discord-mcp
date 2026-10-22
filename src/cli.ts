import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { z } from "zod";
import { withCache } from "./cached.js";
import { loadConfig, type Config } from "./config.js";
import { createDiscord, type Logger } from "./discord.js";
import { messageLine } from "./format.js";
import { ConfigError, ToolError } from "./errors.js";
import type { DiscordPort } from "./port.js";
import { openStore, type MessageStore } from "./store.js";
import type { MessageView } from "./types.js";
import { listChannels, listGuilds, readMessages, readMessagesInput } from "./tools/read.js";
import {
  addReaction,
  addReactionInput,
  createThread,
  createThreadInput,
  sendMessage,
  sendMessageInput,
} from "./tools/write.js";
import { waitFor, waitForMessageInput, whoami } from "./tools/agent.js";
import { searchMessages, searchMessagesInput } from "./tools/search.js";
import { runWatch, WATCH_EVENTS, type WatchEvent, type WatchOptions } from "./watch.js";
import { DEFAULT_SETTLE_MS } from "./settle.js";
import type { FinalOptions } from "./wait.js";

// A connected Discord port and cache. close() disconnects and closes the store.
export interface Session {
  port: DiscordPort;
  store: MessageStore;
  close(): void;
}

// Connects to Discord, opens the message cache, and wraps the port with the cache.
// Used by the MCP server and by the CLI.
export async function openSession(config: Config, log: Logger = console.error): Promise<Session> {
  const discord = createDiscord(config.token, log);
  try {
    const me = await discord.ready();
    const dbPath = config.dbPath ?? join(homedir(), ".cache", "discord-mcp", `${me.botId}.db`);
    mkdirSync(dirname(dbPath), { recursive: true });
    const store = openStore(dbPath);
    log(`discord-mcp: message cache at ${dbPath}`);
    return {
      port: withCache(discord, store),
      store,
      close() {
        discord.destroy();
        store.close();
      },
    };
  } catch (err) {
    discord.destroy();
    throw err;
  }
}

export interface CliDeps {
  // Tests pass a port and store. Then no Discord connection is opened and the store is not closed.
  port?: DiscordPort;
  store?: MessageStore;
  config?: Config;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

type Values = Record<string, string | boolean | string[] | undefined>;

interface RunCtx {
  discord: DiscordPort;
  config: Config;
  store?: MessageStore;
  // Streams output for long-running commands (watch). Other commands return their output.
  out: (text: string) => void;
}

interface Output {
  // undefined: the command printed its own output.
  json?: unknown;
  text: string;
}

interface Command {
  summary: string;
  usage: string;
  options: NonNullable<ParseArgsConfig["options"]>;
  required?: string[];
  // Usage checks. They run before the config is loaded, so a bad flag exits 2 even with no token.
  validate?(values: Values): void;
  run(values: Values, ctx: RunCtx): Promise<Output>;
}

// A flag that is wrong or missing. Prints short help and exits 2.
class UsageError extends Error {}

const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  env: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

const MAX_CHARS = { "max-chars": { type: "string" } } as const;
const FILTER_KEYWORDS = ["bots", "humans", "all"];

function strs(v: Values[string]): string[] {
  return (v as string[] | undefined) ?? [];
}

// A whole number of 1 or more, or undefined when the flag is absent.
function positiveInt(v: Values[string], flag: string): number | undefined {
  const raw = str(v);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${flag} must be a whole number, 1 or more`);
  return n;
}

// --events: a comma list of new, edit, delete and final. Default: new,edit.
function watchEvents(raw: string | undefined): WatchEvent[] {
  if (raw === undefined) return ["new", "edit"];
  const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = names.filter((n) => !(WATCH_EVENTS as readonly string[]).includes(n));
  if (names.length === 0 || bad.length > 0) {
    throw new UsageError("--events takes new, edit, delete and final, comma separated");
  }
  return [...new Set(names)] as WatchEvent[];
}

// --settle <seconds>: how long a message must be quiet to be final. Default 8. Milliseconds, or undefined.
function settleMs(v: Values): number | undefined {
  const n = positiveInt(v.settle, "settle");
  return n === undefined ? undefined : n * 1000;
}

// --ignore-progress <regex>: messages whose latest text matches are never final.
function progressPattern(v: Values): RegExp | undefined {
  const raw = str(v["ignore-progress"]);
  if (raw === undefined) return undefined;
  try {
    return new RegExp(raw);
  } catch {
    throw new UsageError("--ignore-progress must be a valid regular expression");
  }
}

// The server of a channel, found from the servers and channels the bot can see.
async function guildOfChannel(ctx: RunCtx, channelId: string): Promise<string> {
  for (const g of await ctx.discord.listGuilds()) {
    const channels = await ctx.discord.listChannels(g.id);
    if (channels.some((c) => c.id === channelId)) return g.id;
  }
  throw new ToolError("not_found", `channel ${channelId} is not in a server the bot can see`);
}

function str(v: Values[string]): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: Values[string]): number | undefined {
  return typeof v === "string" ? Number(v) : undefined;
}

function maxChars(values: Values): number | undefined {
  const raw = str(values["max-chars"]);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageError("--max-chars must be a whole number, 1 or more");
  return n;
}

function messagesOutput(list: MessageView[], limit?: number): Output {
  return { json: list, text: list.map((m) => messageLine(m, limit)).join("\n") };
}

// Message link for the CLI output. The MCP output does not carry it.
function messageUrl(m: MessageView): string {
  return `https://discord.com/channels/${m.guildId ?? "@me"}/${m.channelId}/${m.id}`;
}

function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}

const CHANNEL = { channel: { type: "string" } } as const;

export const COMMANDS: Record<string, Command> = {
  whoami: {
    summary: "Show the bot id, name and agent name.",
    usage: "whoami",
    options: {},
    async run(_v, ctx) {
      const me = await whoami(ctx);
      return { json: me, text: `${me.botId} ${me.botName}` };
    },
  },

  guilds: {
    summary: "List the servers (guilds) the bot is in.",
    usage: "guilds",
    options: {},
    async run(_v, ctx) {
      const list = await listGuilds(ctx);
      return { json: list, text: list.map((g) => `${g.id} ${g.name}`).join("\n") };
    },
  },

  channels: {
    summary: "List the text channels of one server, or of every server when --guild is left out.",
    usage: "channels [--guild <id>]",
    options: { guild: { type: "string" } },
    async run(v, ctx) {
      const guild = str(v.guild);
      if (guild !== undefined) {
        const list = await listChannels(ctx, guild);
        return { json: list, text: list.map((c) => `${c.id} #${c.name} ${c.type}`).join("\n") };
      }
      const groups = [];
      for (const g of await listGuilds(ctx)) {
        groups.push({ guild: g, channels: await listChannels(ctx, g.id) });
      }
      const lines = groups.flatMap((grp) => grp.channels.map((c) => `${grp.guild.id} ${c.id} #${c.name} ${c.type}`));
      return { json: groups, text: lines.join("\n") };
    },
  },

  read: {
    summary: "Read messages from a channel, oldest first.",
    usage: "read [--channel <id>] [--limit N] [--before <id>] [--after <id>] [--max-chars N]",
    options: {
      ...CHANNEL,
      limit: { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
      ...MAX_CHARS,
    },
    async run(v, ctx) {
      const input = readMessagesInput.parse({
        channel_id: str(v.channel),
        limit: num(v.limit),
        before: str(v.before),
        after: str(v.after),
      });
      return messagesOutput(await readMessages(ctx, input), maxChars(v));
    },
  },

  send: {
    summary: "Send a message, optionally with files and agent metadata.",
    usage:
      "send [--channel <id>] (--content <text> | --content-file <path>) [--reply-to <id>] " +
      "[--file <path>]... [--mention <userId>]... [--agent-to <name>] [--agent-thread <name>] [--agent-kind request|reply|note]",
    options: {
      ...CHANNEL,
      content: { type: "string" },
      "content-file": { type: "string" },
      "reply-to": { type: "string" },
      file: { type: "string", multiple: true },
      mention: { type: "string", multiple: true },
      "agent-to": { type: "string" },
      "agent-thread": { type: "string" },
      "agent-kind": { type: "string" },
    },
    validate(v) {
      if ((v.content !== undefined) === (v["content-file"] !== undefined)) {
        throw new UsageError("give exactly one of --content or --content-file");
      }
    },
    async run(v, ctx) {
      let content = str(v.content);
      const contentFile = str(v["content-file"]);
      if (contentFile !== undefined) {
        try {
          content = readFileSync(contentFile, "utf8");
        } catch {
          throw new ToolError("bad_input", `cannot read content file: ${contentFile}`);
        }
      }
      const agentTo = str(v["agent-to"]);
      const agentThread = str(v["agent-thread"]);
      const agentKind = str(v["agent-kind"]);
      const agent = agentTo === undefined && agentThread === undefined && agentKind === undefined
        ? undefined
        : { to: agentTo, thread: agentThread, kind: agentKind };
      const files = (v.file as string[] | undefined) ?? [];
      const mentions = (v.mention as string[] | undefined) ?? [];
      const input = sendMessageInput.parse({
        channel_id: str(v.channel),
        content,
        reply_to_id: str(v["reply-to"]),
        agent_msg: agent,
        files: files.length > 0 ? files : undefined,
        mention: mentions.length > 0 ? mentions : undefined,
      });
      const sent = await sendMessage(ctx, input);
      const json = { ...sent, url: messageUrl(sent) };
      const lines = [`sent ${sent.id} ${json.url}`];
      for (const a of sent.attachments) lines.push(`file ${a.name} ${a.size}B`);
      return { json, text: lines.join("\n") };
    },
  },

  thread: {
    summary: "Create a thread, optionally from a message.",
    usage: "thread [--channel <id>] --name <name> [--message <id>]",
    options: { ...CHANNEL, name: { type: "string" }, message: { type: "string" } },
    required: ["name"],
    async run(v, ctx) {
      const input = createThreadInput.parse({
        channel_id: str(v.channel),
        name: str(v.name),
        message_id: str(v.message),
      });
      const created = await createThread(ctx, input);
      return { json: created, text: `thread ${created.id} ${input.name}` };
    },
  },

  react: {
    summary: "Add an emoji reaction to a message.",
    usage: "react --channel <id> --message <id> --emoji <emoji>",
    options: { ...CHANNEL, message: { type: "string" }, emoji: { type: "string" } },
    required: ["channel", "message", "emoji"],
    async run(v, ctx) {
      const input = addReactionInput.parse({
        channel_id: str(v.channel),
        message_id: str(v.message),
        emoji: str(v.emoji),
      });
      return { json: await addReaction(ctx, input), text: "reacted" };
    },
  },

  wait: {
    summary: "Wait for a new message that matches the filters. Exits 1 with code timeout if none arrives.",
    usage:
      "wait [--channel <id>] [--after <id>] [--from <bots|humans|all|userId>]... [--to-me] " +
      "[--contains <text>] [--timeout <seconds>] [--max-chars N] " +
      "[--final [--settle <seconds>] [--ignore-progress <regex>]]",
    options: {
      ...CHANNEL,
      after: { type: "string" },
      from: { type: "string", multiple: true },
      "to-me": { type: "boolean" },
      contains: { type: "string" },
      timeout: { type: "string" },
      ...MAX_CHARS,
      final: { type: "boolean" },
      settle: { type: "string" },
      "ignore-progress": { type: "string" },
    },
    validate(v) {
      const froms = (v.from as string[] | undefined) ?? [];
      const keyword = froms.some((f) => FILTER_KEYWORDS.includes(f));
      if (keyword && froms.length > 1) {
        throw new UsageError("--from takes bots, humans or all alone, or one or more user ids");
      }
      if (v.final !== true && (v.settle !== undefined || v["ignore-progress"] !== undefined)) {
        throw new UsageError("--settle and --ignore-progress need --final");
      }
      settleMs(v);
      progressPattern(v);
    },
    async run(v, ctx) {
      const froms = (v.from as string[] | undefined) ?? [];
      const keyword = froms.some((f) => FILTER_KEYWORDS.includes(f));
      const from = froms.length === 0 ? undefined : keyword ? froms[0] : froms;
      const input = waitForMessageInput.parse({
        channel_id: str(v.channel),
        after: str(v.after),
        from,
        to_me: v["to-me"] === true,
        contains: str(v.contains),
        timeout_s: num(v.timeout),
      });
      // --final: the first match that has gone quiet. Without it, the first match.
      const final: FinalOptions | undefined = v.final === true
        ? { settleMs: settleMs(v) ?? DEFAULT_SETTLE_MS, ignoreProgress: progressPattern(v) }
        : undefined;
      const message = await waitFor(ctx, input, undefined, final);
      return messagesOutput([message], maxChars(v));
    },
  },

  watch: {
    summary:
      "Stream new, edited and deleted messages, one line each, until stopped. " +
      "Edits of one message are coalesced to one line per 3 seconds. " +
      "With --events final, prints a message once it has been quiet for --settle seconds. With --json, one JSON object per line.",
    usage:
      "watch [--channel <id>]... [--guild <id>] [--from <userId>]... [--bots-only | --no-bots] " +
      "[--contains <text>] [--events new,edit,delete,final] [--max-chars N] [--until-idle <seconds>] " +
      "[--exit-after <count>] [--settle <seconds>] [--ignore-progress <regex>]",
    options: {
      channel: { type: "string", multiple: true },
      guild: { type: "string" },
      from: { type: "string", multiple: true },
      "bots-only": { type: "boolean" },
      "no-bots": { type: "boolean" },
      contains: { type: "string" },
      events: { type: "string" },
      ...MAX_CHARS,
      "until-idle": { type: "string" },
      "exit-after": { type: "string" },
      settle: { type: "string" },
      "ignore-progress": { type: "string" },
    },
    validate(v) {
      if (v["bots-only"] === true && v["no-bots"] === true) {
        throw new UsageError("--bots-only and --no-bots cannot be used together");
      }
      const events = watchEvents(str(v.events));
      if (!events.includes("final") && (v.settle !== undefined || v["ignore-progress"] !== undefined)) {
        throw new UsageError("--settle and --ignore-progress need final in --events");
      }
      positiveInt(v["until-idle"], "until-idle");
      positiveInt(v["exit-after"], "exit-after");
      settleMs(v);
      progressPattern(v);
    },
    async run(v, ctx) {
      const channelIds = strs(v.channel);
      let guildId = str(v.guild);
      // No channel and no server: the server of DISCORD_DEFAULT_CHANNEL_ID, when it is set.
      if (channelIds.length === 0 && guildId === undefined && ctx.config.defaultChannelId) {
        guildId = await guildOfChannel(ctx, ctx.config.defaultChannelId);
      }
      const untilIdle = positiveInt(v["until-idle"], "until-idle");
      const opts: WatchOptions = {
        channelIds: channelIds.length > 0 ? channelIds : undefined,
        guildId,
        fromIds: strs(v.from),
        bots: v["bots-only"] === true ? "only" : v["no-bots"] === true ? "none" : undefined,
        contains: str(v.contains),
        events: watchEvents(str(v.events)),
        maxChars: maxChars(v),
        untilIdleMs: untilIdle === undefined ? undefined : untilIdle * 1000,
        exitAfter: positiveInt(v["exit-after"], "exit-after"),
        json: v.json === true,
        settleMs: settleMs(v),
        ignoreProgress: progressPattern(v),
      };
      // SIGINT and SIGTERM end the watch. The caller then closes the port and the store.
      const stop = new AbortController();
      const onSignal = () => stop.abort();
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        await runWatch(opts, { port: ctx.discord, out: ctx.out, signal: stop.signal });
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
      return { text: "" };
    },
  },

  search: {
    summary: "Search the local message cache. Searches only messages this bot has seen or read.",
    usage:
      "search [--query <text>] [--channel <id>] [--author <id>] [--since <iso>] [--until <iso>] " +
      "[--limit N] [--max-chars N]",
    options: {
      query: { type: "string" },
      channel: { type: "string" },
      author: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      limit: { type: "string" },
      ...MAX_CHARS,
    },
    async run(v, ctx) {
      if (!ctx.store) throw new ConfigError("the message cache is not open");
      const input = searchMessagesInput.parse({
        query: str(v.query),
        channel_id: str(v.channel),
        author_id: str(v.author),
        since: str(v.since),
        until: str(v.until),
        limit: num(v.limit),
      });
      const result = searchMessages(ctx.store, input);
      return messagesOutput(result.results, maxChars(v));
    },
  },
};

// The first token that is not a flag and not the value of --env.
function commandIndex(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--env") {
      i++;
      continue;
    }
    if (t.startsWith("-")) continue;
    return i;
  }
  return -1;
}

export function helpText(): string {
  const lines = [
    "discord-mcp: Discord bot tool. Run with no arguments to start the MCP server.",
    "",
    "usage: discord-mcp <command> [options]",
    "",
    "commands:",
  ];
  for (const c of Object.values(COMMANDS)) lines.push(`  discord-mcp ${c.usage}`, `      ${c.summary}`);
  lines.push(
    "",
    "global options:",
    "  --env <path>      load KEY=VALUE lines from this file first (values are never printed)",
    "  --json             print JSON instead of text (errors too)",
    "  -h, --help         show help for a command",
    "",
    "The MCP server: discord-mcp (no arguments) or discord-mcp mcp.",
  );
  return `${lines.join("\n")}\n`;
}

function commandHelp(c: Command): string {
  return `usage: discord-mcp ${c.usage}\n  ${c.summary}\n`;
}

function errorBody(err: unknown): { code: string; message: string } {
  if (err instanceof ToolError) return { code: err.code, message: err.message };
  if (err instanceof ConfigError) return { code: "config_error", message: err.message };
  if (err instanceof z.ZodError) return { code: "bad_input", message: zodMessage(err) };
  return { code: "discord_error", message: err instanceof Error ? err.message : String(err) };
}

// Loads --env into process.env (existing variables are kept), then reads the config.
function configFromEnv(envFile: string | undefined): Config {
  if (envFile !== undefined) {
    // Checked first: process.loadEnvFile exits the process when the file is missing.
    if (!existsSync(envFile)) throw new ConfigError(`cannot read env file: ${envFile}`);
    try {
      process.loadEnvFile(envFile);
    } catch {
      throw new ConfigError(`cannot read env file: ${envFile}`);
    }
  }
  return loadConfig(process.env);
}

// Runs one CLI command. Returns the exit code: 0 ok, 1 command error, 2 usage error.
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((t: string) => void process.stdout.write(t));
  const err = deps.stderr ?? ((t: string) => void process.stderr.write(t));

  const usageError = (message: string, name?: string): number => {
    const usage = name && COMMANDS[name] ? `usage: discord-mcp ${COMMANDS[name].usage}` : "usage: discord-mcp <command> [options]";
    err(`discord-mcp: ${message}\n${usage}\nRun "discord-mcp help" for all commands.\n`);
    return 2;
  };

  const idx = commandIndex(argv);
  if (idx === -1) {
    if (argv.includes("--help") || argv.includes("-h")) {
      out(helpText());
      return 0;
    }
    return usageError("no command given");
  }
  const name = argv[idx]!;
  if (name === "help") {
    out(helpText());
    return 0;
  }
  if (name === "mcp") return usageError("mcp takes no options. Run discord-mcp with no arguments for the MCP server");
  const command = COMMANDS[name];
  if (!command) return usageError(`unknown command: ${name}`);

  const rest = [...argv.slice(0, idx), ...argv.slice(idx + 1)];
  let values: Values;
  try {
    const parsed = parseArgs({
      args: rest,
      options: { ...command.options, ...GLOBAL_OPTIONS },
      strict: true,
      allowPositionals: false,
    });
    values = parsed.values as Values;
  } catch (e) {
    return usageError(e instanceof Error ? e.message : String(e), name);
  }
  if (values.help === true) {
    out(commandHelp(command));
    return 0;
  }
  for (const flag of command.required ?? []) {
    if (values[flag] === undefined) return usageError(`missing --${flag}`, name);
  }
  try {
    if ("max-chars" in command.options) maxChars(values);
    command.validate?.(values);
  } catch (e) {
    if (e instanceof UsageError) return usageError(e.message, name);
    throw e;
  }

  const json = values.json === true;
  let session: Session | undefined;
  try {
    const config = deps.config ?? configFromEnv(str(values.env));
    let port = deps.port;
    let store = deps.store;
    if (!port) {
      session = await openSession(config, () => {});
      port = session.port;
      store = session.store;
    }
    const result = await command.run(values, { discord: port, config, store, out });
    if (json) {
      if (result.json !== undefined) out(`${JSON.stringify(result.json, null, 2)}\n`);
    } else if (result.text !== "") out(`${result.text}\n`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) return usageError(e.message, name);
    const body = errorBody(e);
    if (json) err(`${JSON.stringify({ error: body }, null, 2)}\n`);
    else err(`error ${body.code}: ${body.message}\n`);
    return 1;
  } finally {
    session?.close();
  }
}
