import { configDefaults, defineConfig } from "vitest/config";

// Live tests need real bot tokens. They run only with `npm run test:live`.
export default defineConfig({
  test: {
    exclude: process.env.DISCORD_MCP_LIVE ? configDefaults.exclude : [...configDefaults.exclude, "test/live/**"],
  },
});
