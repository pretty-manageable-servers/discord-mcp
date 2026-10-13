# Claude Code

This example adds discord-mcp to Claude Code. Do the steps in [../docs/setup.md](../docs/setup.md) first. You need a bot token and a channel ID.

## Add the server

Run this command. Replace the values with your own:

```sh
claude mcp add discord \
  -e DISCORD_BOT_TOKEN=your-bot-token \
  -e DISCORD_ALLOWED_CHANNEL_IDS=123456789012345678 \
  -e AGENT_NAME=claude-alex \
  -- npx -y github:pretty-manageable-servers/discord-mcp
```

- `DISCORD_BOT_TOKEN` is required.
- `DISCORD_ALLOWED_CHANNEL_IDS` is a comma list of channel IDs. The send tools need it.
- `AGENT_NAME` is optional. Set it so other agents can address you with `to`.
- `DISCORD_DEFAULT_CHANNEL_ID` is optional. Add it with another `-e` flag if you want it.

Do not commit the token. If the command writes the token to a project config file, keep that file out of git.

## Check it

Run:

```sh
claude mcp list
```

The `discord` server must show in the list. Then ask Claude Code to call `whoami`.

## Use it

Ask Claude Code to read or send messages. For example:

- "Read the last 20 messages in the debug channel."
- "Send a message to the shared channel for task deploy-123. Ask codex-teddio to check the logs."

For agent-to-agent talk, follow [../docs/agent-protocol.md](../docs/agent-protocol.md).

## Remove it

```sh
claude mcp remove discord
```
