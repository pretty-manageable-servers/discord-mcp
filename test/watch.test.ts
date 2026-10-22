import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli, type CliDeps } from "../src/cli.js";
import { withCache } from "../src/cached.js";
import { openStore, type MessageStore } from "../src/store.js";
import { FakeDiscord, makeMessage } from "./fake-discord.js";

let fake: FakeDiscord;
let store: MessageStore;
let out: string[];
let err: string[];

function deps(): CliDeps {
  return {
    port: withCache(fake, store),
    store,
    config: { token: "t", allowedChannelIds: [] },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  };
}

// Lets the command start and subscribe before the test pushes events.
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  fake = new FakeDiscord();
  store = openStore(":memory:");
  out = [];
  err = [];
});

afterEach(() => {
  store.close();
  vi.useRealTimers();
});

describe("watch", () => {
  it("watch_prints_new_message_line", async () => {
    const run = runCli(["watch", "--exit-after", "1"], deps());
    await settle();
    fake.push(makeMessage({ id: "1562920405608701992", channelId: "c1", authorName: "ann", content: "line one\nline two", createdAt: "2026-10-22T16:05:09.000Z" }));
    expect(await run).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("")).toBe("status ready\nnew 1562920405608701992 16:05 UTC ann: line one⏎line two\n");
    // The message is also in the local cache.
    expect(store.range("c1", { limit: 10 }).map((m) => m.content)).toEqual(["line one\nline two"]);
  });

  it("watch_filters_from_and_channel", async () => {
    const run = runCli(["watch", "--channel", "c1", "--from", "u1", "--exit-after", "1"], deps());
    await settle();
    fake.push(makeMessage({ channelId: "c2", authorId: "u1", content: "other channel" }));
    fake.push(makeMessage({ channelId: "c1", authorId: "u2", content: "other author" }));
    fake.push(makeMessage({ channelId: "c1", authorId: "u1", content: "wanted" }));
    expect(await run).toBe(0);
    const lines = out.join("").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^new \d+ \d\d:\d\d UTC human: wanted$/);
  });

  it("watch_coalesces_rapid_edits", async () => {
    vi.useFakeTimers();
    const run = runCli(["watch", "--until-idle", "10"], deps());
    await vi.advanceTimersByTimeAsync(0);
    const msg = makeMessage({ channelId: "c1", content: "status: v0" });
    fake.push(msg);
    // Five edits within one window: none is printed right away after the first.
    for (const v of ["v1", "v2", "v3", "v4", "v5"]) {
      await vi.advanceTimersByTimeAsync(100);
      fake.edit(msg.id, `status: ${v}`);
    }
    // The window ends: the latest text is printed once.
    await vi.advanceTimersByTimeAsync(3000);
    // No further edits: the idle timer ends the watch.
    expect(await (async () => { await vi.advanceTimersByTimeAsync(10_000); return run; })()).toBe(0);

    const lines = out.join("").trimEnd().split("\n");
    const edits = lines.filter((l) => l.startsWith("edit "));
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatch(/: status: v5$/);
    expect(lines.filter((l) => l.startsWith("new "))).toHaveLength(1);
  });

  it("watch_until_idle_exits", async () => {
    vi.useFakeTimers();
    const d = deps();
    const base = fake.listenerCount();
    const run = runCli(["watch", "--until-idle", "2"], d);
    await vi.advanceTimersByTimeAsync(1000);
    fake.push(makeMessage({ channelId: "c1", content: "busy" }));
    await vi.advanceTimersByTimeAsync(1500);
    // The printed event restarted the idle timer, so the watch is still running.
    let finished = false;
    run.then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await run).toBe(0);
    expect(out.join("")).toMatch(/^status ready\nnew \d+ .* busy\n$/);
    expect(fake.listenerCount()).toBe(base);
  });

  it("watch_exit_after_count", async () => {
    const d = deps();
    const base = fake.listenerCount();
    const run = runCli(["watch", "--exit-after", "2"], d);
    await settle();
    fake.push(makeMessage({ channelId: "c1", content: "one" }));
    fake.push(makeMessage({ channelId: "c1", content: "two" }));
    fake.push(makeMessage({ channelId: "c1", content: "three" }));
    expect(await run).toBe(0);
    const printed = out.join("").trimEnd().split("\n").filter((l) => l.startsWith("new "));
    expect(printed).toHaveLength(2);
    expect(printed[1]).toMatch(/: two$/);
    expect(fake.listenerCount()).toBe(base);
  });

  it("watch_prints_delete_and_reconnect_status", async () => {
    const run = runCli(["watch", "--events", "new,delete", "--exit-after", "2"], deps());
    await settle();
    fake.setStatus("reconnecting");
    const msg = makeMessage({ id: "777", channelId: "c1", content: "gone soon" });
    fake.push(msg);
    fake.remove(msg.id);
    expect(await run).toBe(0);
    expect(out.join("")).toBe(
      "status ready\nstatus reconnecting\nnew 777 " + msg.createdAt.slice(11, 16) + " UTC human: gone soon\ndelete 777\n",
    );
  });

  it("watch_final_after_settle", async () => {
    vi.useFakeTimers();
    const run = runCli(["watch", "--events", "final", "--exit-after", "1"], deps());
    await vi.advanceTimersByTimeAsync(0);
    const msg = makeMessage({ channelId: "c1", authorName: "bot", authorIsBot: true, content: "working" });
    fake.push(msg);
    await vi.advanceTimersByTimeAsync(5000);
    fake.edit(msg.id, "the answer");
    // 7.9 s after the last edit: still not final.
    await vi.advanceTimersByTimeAsync(7900);
    expect(out.join("")).toBe("status ready\n");
    await vi.advanceTimersByTimeAsync(100);
    expect(await run).toBe(0);
    expect(err).toEqual([]);
    const lines = out.join("").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(new RegExp(`^final ${msg.id} \\d\\d:\\d\\d UTC bot \\[bot\\]: the answer$`));
  });

  it("watch_final_ignores_progress_until_answer", async () => {
    vi.useFakeTimers();
    const run = runCli(
      ["watch", "--events", "final", "--ignore-progress", ":slopbot_pulse:", "--exit-after", "1"],
      deps(),
    );
    await vi.advanceTimersByTimeAsync(0);
    const msg = makeMessage({ channelId: "c1", authorIsBot: true, content: ":slopbot_pulse: step 1" });
    fake.push(msg);
    // Progress edits, and then quiet for much longer than the settle time: nothing is final.
    await vi.advanceTimersByTimeAsync(4000);
    fake.edit(msg.id, ":slopbot_pulse: step 2");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(out.join("")).toBe("status ready\n");
    // The answer edit does not match the progress text, so it settles.
    fake.edit(msg.id, "forty-two");
    await vi.advanceTimersByTimeAsync(8000);
    expect(await run).toBe(0);
    const lines = out.join("").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^final \d+ \d\d:\d\d UTC human \[bot\]: forty-two$/);
  });

  it("watch_final_again_after_late_edit", async () => {
    vi.useFakeTimers();
    const run = runCli(["watch", "--events", "final", "--until-idle", "60"], deps());
    await vi.advanceTimersByTimeAsync(0);
    const msg = makeMessage({ channelId: "c1", content: "first" });
    fake.push(msg);
    await vi.advanceTimersByTimeAsync(8000);
    expect(out.join("").trimEnd().split("\n")).toHaveLength(2);
    // A late edit after the final line: it prints final again once it settles.
    fake.edit(msg.id, "first, corrected");
    await vi.advanceTimersByTimeAsync(8000);
    // An edit back to the printed text prints nothing new.
    fake.edit(msg.id, "first, corrected");
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await run).toBe(0);
    const finals = out.join("").trimEnd().split("\n").filter((l) => l.startsWith("final "));
    expect(finals).toHaveLength(2);
    expect(finals[0]).toMatch(/: first$/);
    expect(finals[1]).toMatch(/: first, corrected$/);
  });

  it("watch_rejects_bad_flags", async () => {
    expect(await runCli(["watch", "--bots-only", "--no-bots"], deps())).toBe(2);
    expect(await runCli(["watch", "--events", "new,bogus"], deps())).toBe(2);
    expect(await runCli(["watch", "--exit-after", "0"], deps())).toBe(2);
    expect(err.join("")).toContain("--exit-after must be a whole number");
  });
});
