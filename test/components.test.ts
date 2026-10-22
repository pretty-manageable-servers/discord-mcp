import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { withCache } from "../src/cached.js";
import { runCli } from "../src/cli.js";
import { flattenComponents, mapEmbeds, type RawComponent } from "../src/components.js";
import type { Config } from "../src/config.js";
import { messageLine } from "../src/format.js";
import { buildServer } from "../src/server.js";
import { openStore } from "../src/store.js";
import type { MessageView } from "../src/types.js";
import { FakeDiscord, makeMessage } from "./fake-discord.js";

// Components V2 card: a container with a heading, a section with a button accessory, a separator.
const reminderCard: RawComponent[] = [
  {
    type: 17,
    components: [
      { type: 10, content: "## Reminder" },
      { type: 14 },
      { type: 10, content: "Standup at 10:00" },
      { type: 9, components: [{ type: 10, content: "Ping the team" }], accessory: { type: 2, style: 2, label: "Snooze" } },
    ],
  },
];

describe("components and embeds", () => {
  it("components_v2_card_text_shown", () => {
    const texts = flattenComponents(reminderCard);
    expect(texts).toEqual(["## Reminder", "Standup at 10:00", "Ping the team", "[button: Snooze]"]);

    const m = makeMessage({ content: "", components: texts });
    expect(messageLine(m)).toMatch(/ UTC human: \[card: ## Reminder \| Standup at 10:00 \| Ping the team \| \[button: Snooze\]\]$/);
    // Text is cut to max-chars, and the line still has its prefix.
    const cut = messageLine(m, 10);
    expect(cut).toContain("[card: ## Reminde…]");
  });

  it("buttons_and_links_shown", () => {
    const row: RawComponent[] = [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: "Yes" },
          { type: 2, style: 5, label: "Docs", url: "https://docs.example" },
          { type: 2, style: 2, emoji: { name: "🔔" } },
        ],
      },
      { type: 1, components: [{ type: 3, placeholder: "Pick a time" }] },
    ];
    expect(flattenComponents(row)).toEqual([
      "[button: Yes]",
      "[link: Docs → https://docs.example]",
      "[button: 🔔]",
      "[select: Pick a time]",
    ]);
  });

  it("embed_fields_shown", () => {
    const embeds = mapEmbeds([
      {
        title: "Poll",
        description: "Lunch?",
        fields: [
          { name: "Pizza", value: "3 votes" },
          { name: "Tacos", value: "1 vote" },
        ],
        footer: { text: "closes Friday" },
      },
    ]);
    expect(embeds[0]).toEqual({
      title: "Poll",
      description: "Lunch?",
      fields: [
        { name: "Pizza", value: "3 votes" },
        { name: "Tacos", value: "1 vote" },
      ],
      footer: "closes Friday",
    });
    const m = makeMessage({ content: "vote", embeds });
    expect(messageLine(m)).toContain(
      "vote [embed: Poll | Lunch? | Pizza: 3 votes | Tacos: 1 vote | closes Friday]",
    );
  });

  it("json_has_components_field", async () => {
    const fake = new FakeDiscord();
    fake.push(
      makeMessage({
        channelId: "c1",
        content: "",
        components: flattenComponents(reminderCard),
        embeds: mapEmbeds([{ title: "Poll", fields: [{ name: "A", value: "1" }] }]),
      }),
    );
    const dir = mkdtempSync(join(tmpdir(), "dmcp-comp-"));
    const store = openStore(":memory:");
    const lines: string[] = [];
    try {
      const code = await runCli(["read", "--json", "--channel", "c1"], {
        port: withCache(fake, store),
        store,
        config: { token: "t", allowedChannelIds: ["c1"] },
        stdout: (t) => lines.push(t),
        stderr: () => {},
      });
      expect(code).toBe(0);
      const body = JSON.parse(lines.join(""));
      expect(body[0].components).toContain("[button: Snooze]");
      expect(body[0].embeds).toEqual([{ title: "Poll", description: null, fields: [{ name: "A", value: "1" }], footer: null }]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }

    // The MCP read keeps its existing fields and adds the two new ones.
    const mcpFake = new FakeDiscord();
    mcpFake.push(makeMessage({ channelId: "c1", content: "hi", components: ["[button: Go]"] }));
    const config: Config = { token: "t", allowedChannelIds: [] };
    const server = buildServer(mcpFake, config);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientSide);
    const res = (await client.callTool({ name: "read_messages", arguments: { channel_id: "c1" } })) as unknown as {
      content: { text: string }[];
    };
    const [msg] = JSON.parse(res.content[0].text) as MessageView[];
    expect(msg.components).toEqual(["[button: Go]"]);
    expect(msg.embeds).toEqual([]);
    expect(msg.content).toBe("hi");
  });

  it("cache_migration_keeps_old_rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "dmcp-mig-"));
    const path = join(dir, "cache.db");
    try {
      const first = openStore(path);
      first.upsert(makeMessage({ id: "1", channelId: "c1", content: "old row" }));
      first.close();

      // Turn the file back into a version 2 cache: no component columns.
      const raw = new DatabaseSync(path);
      raw.exec(`
        ALTER TABLE messages DROP COLUMN components_json;
        ALTER TABLE messages DROP COLUMN embeds_json;
        UPDATE meta SET value = '2' WHERE key = 'schema_version';
      `);
      raw.close();

      const upgraded = openStore(path);
      try {
        const [old] = upgraded.range("c1", { limit: 10 });
        expect(old.content).toBe("old row");
        expect(old.components).toEqual([]);
        expect(old.embeds).toEqual([]);

        upgraded.upsert(makeMessage({ id: "2", channelId: "c1", content: "", components: ["[button: Ok]"] }));
        const [, fresh] = upgraded.range("c1", { limit: 10 });
        expect(fresh.components).toEqual(["[button: Ok]"]);
      } finally {
        upgraded.close();
      }

      const check = new DatabaseSync(path);
      try {
        const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
        expect(version.value).toBe("3");
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
