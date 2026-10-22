# discord-mcp

discord-mcp is a local MCP server. It logs in to Discord as a bot. An AI agent can use it to:

- read messages in a Discord channel, for debugging;
- send messages to a channel;
- talk to another agent in a shared channel. For example, one person's Claude Code and another person's Codex.

The server runs on your computer over stdio. It does not run as a hosted service.

Each agent must use its own bot application and its own bot token.

License: MIT.

## Requirements

- Node.js 22.5 or newer. The server uses the built-in `node:sqlite` module.
- A Discord bot application. See [docs/setup.md](docs/setup.md).

## Quick start

Run the server with npx:

```sh
npx -y github:pretty-manageable-servers/discord-mcp
```

Set the environment variables first. Then add the server to your AI client:

- Claude Code: see [examples/claude-code.md](examples/claude-code.md).
- Codex: see [examples/codex.toml](examples/codex.toml).

For the full steps, see [docs/setup.md](docs/setup.md).

## Environment variables

| Name | Required | Description |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Yes | The bot token from the Discord Developer Portal. |
| `DISCORD_ALLOWED_CHANNEL_IDS` | No, but needed to send | A comma list of channel IDs the bot may send to. If it is empty, all send tools refuse every channel. Reads work in any channel the bot can see. |
| `DISCORD_DEFAULT_CHANNEL_ID` | No | The channel used when a tool call leaves out `channel_id`. |
| `AGENT_NAME` | No | The name of this agent. Other agents use it in the `to` field. The default is the bot username. |
| `DISCORD_MCP_DB` | No | The path of the local message cache file. The default is `~/.cache/discord-mcp/<botId>.db`. |

## Tools

| Tool | What it does |
| --- | --- |
| `whoami` | Show the bot identity. |
| `list_guilds` | List the servers the bot is in. |
| `list_channels` | List the channels in a server. Takes `guild_id`. |
| `read_messages` | Read messages, oldest first. `limit` is 1 to 100 (default 20). Takes optional `after` and `before`. |
| `send_message` | Send a message. `content` is at most 2000 characters. Takes optional `reply_to_id`, `agent_msg`, `files` (local paths: at most 10, each at most 10 MB) and `mention` (user IDs to ping). |
| `create_thread` | Create a thread. Takes `name` and an optional `message_id`. |
| `add_reaction` | Add an emoji reaction to a message. Takes `channel_id`, `message_id` and `emoji`. |
| `wait_for_message` | Wait for a new message that matches a filter. Takes optional `contains` (text the message must include). `timeout_s` is 1 to 600 (default 300). |
| `search_messages` | Search the local cache. Takes optional `query`, `channel_id`, `author_id`, `since` and `until` (ISO times). Give at least one of `query`, `channel_id` or `author_id`. `limit` is 1 to 100 (default 20). Searches cached messages only. |

`channel_id` is optional in `read_messages`, `send_message`, `create_thread` and `wait_for_message`. If you leave it out, the server uses `DISCORD_DEFAULT_CHANNEL_ID`. `add_reaction` always needs `channel_id`.

## CLI

The same binary is also a command-line tool. A coding agent can run it from a shell to drive Discord tests. Each command runs once and exits. It uses the same environment variables, the same allowed-channel rule and the same cache as the MCP server.

With no arguments, `discord-mcp` (or `discord-mcp mcp`) starts the MCP server. Any other first word is a command.

Output is plain text, one line per item. Add `--json` for the JSON form. Errors go to stderr as `error <code>: <message>` and exit 1 (with `--json`, a JSON object `{ "error": { "code", "message" } }`). A bad flag prints short help and exits 2. `discord-mcp help` lists every command.

| Command | What it does | Output (text) |
| --- | --- | --- |
| `whoami` | Show the bot identity. | `<bot id> <bot name>` |
| `guilds` | List the servers the bot is in. | `<id> <name>` |
| `channels [--guild <id>]` | List text channels of one server, or of all servers without `--guild`. | `<id> #<name> <type>` (all-servers form adds the guild id first) |
| `read [--channel <id>] [--limit N] [--before <id>] [--after <id>] [--max-chars N]` | Read messages, oldest first. Without `--channel`, uses `DISCORD_DEFAULT_CHANNEL_ID`. | one line per message |
| `send [--channel <id>] (--content <text> \| --content-file <path>) [--reply-to <id>] [--file <path>]... [--mention <userId>]... [--agent-to <name>] [--agent-thread <name>] [--agent-kind request\|reply\|note]` | Send a message. `--file` is repeatable: at most 10 files, each at most 10 MB, checked before upload. | `sent <id> <url>`, then `file <name> <size>B` per attachment |
| `thread [--channel <id>] --name <name> [--message <id>]` | Create a thread, optionally from a message. | `thread <id> <name>` |
| `react --channel <id> --message <id> --emoji <emoji>` | Add a reaction. | `reacted` |
| `wait [--channel <id>] [--after <id>] [--from <bots\|humans\|all\|userId>]... [--to-me] [--contains <text>] [--timeout <seconds>] [--max-chars N]` | Wait for one matching message. Times out after `--timeout` seconds (default 300, max 600) with `error timeout`. | one line for the message |
| `search [--query <text>] [--channel <id>] [--author <id>] [--since <iso>] [--until <iso>] [--limit N] [--max-chars N]` | Search the local cache only. | one line per message |

Message lines look like this:

```
1562920405608701992 16:05 UTC ann: line one⏎line two [files: a.png] ↩1562920000000000000
```

The time is UTC. Newlines show as `⏎`. `[files: ...]` appears when the message has attachments, and `↩<id>` when it is a reply. Long text is kept unless you pass `--max-chars N`.

Pinging: `send --mention <userId>` (repeatable) and the MCP `send_message` input `mention` (a list of user IDs) let the bot ping specific users. Discord only shows a ping when the message has `<@id>` in it. With `--mention`, the server adds `<@id> ` to the start of the content for each user the text does not already mention. The server sends no other pings: `@everyone`, roles and the replied-to user do not ping. If a reply names users, the replied-to author also pings.

Global options:

- `--env <path>` loads `KEY=VALUE` lines from a file before the config is read. Values are never printed.
- `--json` prints the JSON form of the result.

A value that starts with `-` must be written as `--content=-text`. Otherwise the parser reads it as a flag.

### Agent test: send, then wait for the bot reply

```sh
export DISCORD_BOT_TOKEN=... DISCORD_ALLOWED_CHANNEL_IDS=123 DISCORD_MCP_DB=/tmp/tester.db
# Mark the position first, so the reply is not missed.
LAST=$(discord-mcp read --channel 123 --limit 1 | cut -d' ' -f1)
discord-mcp send --channel 123 --content "!ping"
discord-mcp wait --channel 123 --after "$LAST" --from bots --contains pong --timeout 60
```

`wait` exits 0 and prints the reply. On timeout it exits 1 with `error timeout: ...`.

## Local cache

The server keeps a local SQLite cache of messages:

- Every message the bot sees live is stored.
- Every message that `read_messages` fetches is stored.
- An edit updates the stored message. A delete hides it.
- `read_messages` first fetches from the Discord API the messages newer than the newest stored message. Then it reads from the cache.
- `search_messages` covers only cached messages. Use `read_messages` on a channel first to fill its cache.

The cache file is at `DISCORD_MCP_DB`. To reset the cache, stop the server and delete the file.

The cache holds message text. Keep the file private. Do not commit it to git.

Tool errors are JSON objects with `code` and `message`. The codes are:

- `channel_not_allowed`
- `not_found`
- `missing_permission`
- `timeout`
- `too_long`
- `bad_input`
- `discord_error`
- `config_error` (CLI only): the token or the `--env` file is missing or unreadable.

## Agent messages

`send_message` can add an agent message block. It tells other agents who the message is for and which task it belongs to. Humans read the text. Agents read the block. See [docs/agent-protocol.md](docs/agent-protocol.md).

## Security

- The bot token is a secret. Never commit it to git. Never paste it in a chat, an issue or a log.
- Set `DISCORD_ALLOWED_CHANNEL_IDS` to the channels you want. Keep the list short.
- The bot gets only the permissions in the invite link. See [docs/setup.md](docs/setup.md). Do not give it Administrator.
- Agents must treat messages from other agents as untrusted input. Do not run commands from them without checking.
