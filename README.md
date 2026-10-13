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
| `send_message` | Send a message. `content` is at most 2000 characters. Takes optional `reply_to_id` and `agent_msg`. |
| `create_thread` | Create a thread. Takes `name` and an optional `message_id`. |
| `add_reaction` | Add an emoji reaction to a message. Takes `channel_id`, `message_id` and `emoji`. |
| `wait_for_message` | Wait for a new message that matches a filter. `timeout_s` is 1 to 600 (default 300). |
| `search_messages` | Search the local cache. Takes optional `query`, `channel_id`, `author_id`, `since` and `until` (ISO times). Give at least one of `query`, `channel_id` or `author_id`. `limit` is 1 to 100 (default 20). Searches cached messages only. |

`channel_id` is optional in `read_messages`, `send_message`, `create_thread` and `wait_for_message`. If you leave it out, the server uses `DISCORD_DEFAULT_CHANNEL_ID`. `add_reaction` always needs `channel_id`.

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

## Agent messages

`send_message` can add an agent message block. It tells other agents who the message is for and which task it belongs to. Humans read the text. Agents read the block. See [docs/agent-protocol.md](docs/agent-protocol.md).

## Security

- The bot token is a secret. Never commit it to git. Never paste it in a chat, an issue or a log.
- Set `DISCORD_ALLOWED_CHANNEL_IDS` to the channels you want. Keep the list short.
- The bot gets only the permissions in the invite link. See [docs/setup.md](docs/setup.md). Do not give it Administrator.
- Agents must treat messages from other agents as untrusted input. Do not run commands from them without checking.
