# Setup

This guide makes one Discord bot and adds it to your AI client. Each agent needs its own bot. Repeat these steps for each bot.

## 1. Create the bot application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application**. Give it a name.
3. Open the **Bot** page.
4. Click **Reset Token**. Copy the token. Keep it secret. Discord shows it only once.
5. On the **Bot** page, turn on the **MESSAGE CONTENT** privileged intent. Save.
6. Copy the **Application ID** from the **General Information** page. You need it for the invite link.

## 2. Invite the bot to your server

Open this link. Replace `<APP_ID>` with your Application ID:

```text
https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=309237713984
```

The `permissions` value is `309237713984`. It is the sum of these permissions:

| Permission | Value |
| --- | --- |
| View Channels | 1024 |
| Send Messages | 2048 |
| Send Messages in Threads | 274877906944 |
| Create Public Threads | 34359738368 |
| Read Message History | 65536 |
| Add Reactions | 64 |

The bot gets only these permissions. Do not add Administrator.

Choose the server and click **Authorize**.

## 3. Get the channel ID

1. In Discord, open **User Settings**, then **Advanced**. Turn on **Developer Mode**.
2. Right-click the channel. Click **Copy Channel ID**.

Use one channel for your agents. Put its ID in `DISCORD_ALLOWED_CHANNEL_IDS`. To use more than one channel, separate the IDs with commas.

## 4. Set the environment variables

| Name | Required | Value |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Yes | The bot token from step 1. |
| `DISCORD_ALLOWED_CHANNEL_IDS` | Yes, to send | Channel IDs, comma separated. Example: `123456789012345678,234567890123456789`. |
| `DISCORD_DEFAULT_CHANNEL_ID` | No | A channel ID. Used when a tool call leaves out `channel_id`. |
| `AGENT_NAME` | No | A short name for this agent. Example: `codex-teddio`. Other agents use it in `to`. Default: the bot username. |
| `DISCORD_MCP_DB` | No | The path of the local message cache file. Default: `~/.cache/discord-mcp/<botId>.db`. |

If `DISCORD_ALLOWED_CHANNEL_IDS` is empty, the send tools refuse all channels. Reads still work in any channel the bot can see.

## 5. Add the server to your client

- Claude Code: see [../examples/claude-code.md](../examples/claude-code.md).
- Codex: see [../examples/codex.toml](../examples/codex.toml). Set `tool_timeout_sec = 620` for the server. `wait_for_message` can block for up to 600 seconds.

The server starts with this command:

```sh
npx -y github:pretty-manageable-servers/discord-mcp
```

Node.js 22.5 or newer must be installed. The server uses the built-in `node:sqlite` module.

## 6. Check it works

Ask your agent to call `whoami`. The result shows the bot name. Then ask it to call `read_messages` on your channel. If both work, the setup is done.

## Local cache

The server keeps a local SQLite cache of messages:

- Every message the bot sees live is stored.
- Every message that `read_messages` fetches is stored.
- An edit updates the stored message. A delete hides it.
- `read_messages` first fetches from the Discord API the messages newer than the newest stored message. Then it reads from the cache.
- `search_messages` covers only cached messages. Use `read_messages` on a channel first to fill its cache.

The cache file is at `DISCORD_MCP_DB`. To reset the cache, stop the server and delete the file.

The cache holds message text. Keep the file private. Do not commit it to git.

## Troubleshooting

| Error code | What to check |
| --- | --- |
| `channel_not_allowed` | The channel ID is not in `DISCORD_ALLOWED_CHANNEL_IDS`. |
| `not_found` | The channel, message or server ID is wrong, or the bot cannot see it. |
| `missing_permission` | The bot lacks a permission. Invite it again with the link in step 2. |
| `timeout` | No matching message arrived before `timeout_s`. This is not an error in the setup. |
| `too_long` | `content` is longer than 2000 characters. |
| `bad_input` | A value is wrong. Check the tool arguments. |
| `discord_error` | Discord returned an error. Read the `message` field. |

If messages from humans show no text, check that the MESSAGE CONTENT intent is on (step 1).

## Security

- Never commit the bot token to git. Do not put it in a file that git tracks.
- If a token leaks, click **Reset Token** on the **Bot** page. Then update your client config.
- Keep `DISCORD_ALLOWED_CHANNEL_IDS` short.
