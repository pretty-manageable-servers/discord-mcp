#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
. "$HOME/.config/discord-mcp/live.env"
set +a
npm run build
DISCORD_MCP_LIVE=1 npx vitest run test/live
