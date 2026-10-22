import { describe, expect, it, vi } from "vitest";
import { ToolError } from "../src/errors.js";
import { matches, waitForMessage, type WaitOptions } from "../src/wait.js";
import type { MessageView } from "../src/types.js";
import { FakeDiscord, makeMessage } from "./fake-discord.js";

function base(over: Partial<WaitOptions> = {}): WaitOptions {
  return {
    channelId: "c1", from: "all", toMe: false, timeoutMs: 50,
    selfId: "bot-self", selfNames: ["alpha", "self-bot"], ...over,
  };
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => undefined, (e: unknown) => e);
}

describe("wait_for_message", () => {
  it("returns backlog message", async () => {
    const d = new FakeDiscord();
    const anchor = makeMessage({ channelId: "c1", authorId: "u2" });
    const first = makeMessage({ channelId: "c1", authorId: "u2", content: "first" });
    const second = makeMessage({ channelId: "c1", authorId: "u2", content: "second" });
    d.messages.push(anchor, first, second);

    const m = await waitForMessage(d, base({ after: anchor.id }));
    expect(m.content).toBe("first");
  });

  it("backlog pages past 100", async () => {
    const d = new FakeDiscord();
    const anchor = makeMessage({ channelId: "c1", authorId: "u2" });
    const noise = Array.from({ length: 150 }, (_, i) =>
      makeMessage({ channelId: "c1", authorId: "u3", content: `noise ${i}` }));
    const target = makeMessage({ channelId: "c1", authorId: "u-target", content: "target" });
    d.messages.push(anchor, ...noise, target);

    const m = await waitForMessage(d, base({ after: anchor.id, from: ["u-target"], timeoutMs: 1000 }));
    expect(m.content).toBe("target");
  });

  it("returns live message", async () => {
    const d = new FakeDiscord();
    const p = waitForMessage(d, base());
    d.push(makeMessage({ channelId: "c1", authorId: "u2", content: "live" }));
    const m = await p;
    expect(m.content).toBe("live");
  });

  it("skips own message", async () => {
    const d = new FakeDiscord();
    const p = waitForMessage(d, base());
    d.push(makeMessage({ channelId: "c1", authorId: "bot-self", authorIsBot: true, content: "mine" }));
    d.push(makeMessage({ channelId: "c1", authorId: "u2", content: "theirs" }));
    const m = await p;
    expect(m.content).toBe("theirs");
  });

  it("wait_final_returns_settled_answer", async () => {
    vi.useFakeTimers();
    const d = new FakeDiscord();
    let result: MessageView | undefined;
    const p = waitForMessage(d, base({
      timeoutMs: 60_000,
      final: { settleMs: 1000, ignoreProgress: /:pulse:/ },
    })).then((m) => { result = m; });
    const msg = makeMessage({ channelId: "c1", authorId: "u2", content: ":pulse: thinking" });
    d.push(msg);
    await vi.advanceTimersByTimeAsync(5000);
    d.edit(msg.id, ":pulse: still thinking");
    await vi.advanceTimersByTimeAsync(5000);
    // Still progress: not returned, however long it is quiet.
    expect(result).toBeUndefined();
    d.edit(msg.id, "42");
    await vi.advanceTimersByTimeAsync(999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(result?.id).toBe(msg.id);
    expect(result?.content).toBe("42");
    vi.useRealTimers();
  });

  it("from filter", async () => {
    const d = new FakeDiscord();
    const p = waitForMessage(d, base({ from: "bots" }));
    d.push(makeMessage({ channelId: "c1", authorId: "u2", authorIsBot: false, content: "human" }));
    d.push(makeMessage({ channelId: "c1", authorId: "bot-2", authorIsBot: true, content: "bot" }));
    const m = await p;
    expect(m.content).toBe("bot");

    const human = makeMessage({ channelId: "c1", authorId: "u7", authorIsBot: false });
    const other = makeMessage({ channelId: "c1", authorId: "u8", authorIsBot: false });
    expect(matches(human, base({ from: ["u7"] }))).toBe(true);
    expect(matches(other, base({ from: ["u7"] }))).toBe(false);
    expect(matches(human, base({ from: "bots" }))).toBe(false);
    expect(matches(human, base({ from: "humans" }))).toBe(true);
  });

  it("to_me filter by agent-msg", async () => {
    const d = new FakeDiscord();
    const p = waitForMessage(d, base({ toMe: true }));
    d.push(makeMessage({ channelId: "c1", authorId: "u2", content: "for beta", agentMsg: { to: "beta" } }));
    d.push(makeMessage({ channelId: "c1", authorId: "u2", content: "for alpha", agentMsg: { to: "Alpha" } }));
    const m = await p;
    expect(m.content).toBe("for alpha");
  });

  it("to_me filter by mention", async () => {
    const d = new FakeDiscord();
    const p = waitForMessage(d, base({ toMe: true }));
    d.push(makeMessage({ channelId: "c1", authorId: "u2", content: "hello all" }));
    d.push(makeMessage({ channelId: "c1", authorId: "u2", content: "<@bot-self> ping" }));
    const m = await p;
    expect(m.content).toBe("<@bot-self> ping");
  });

  it("to_me filter by nickname mention", async () => {
    const d = new FakeDiscord();
    const p = waitForMessage(d, base({ toMe: true }));
    d.push(makeMessage({ channelId: "c1", authorId: "u2", content: "hello all" }));
    d.push(makeMessage({ channelId: "c1", authorId: "u2", content: "<@!bot-self> nick ping" }));
    const m = await p;
    expect(m.content).toBe("<@!bot-self> nick ping");
  });

  it("timeout", async () => {
    const d = new FakeDiscord();
    const err = await errorOf(waitForMessage(d, base({ timeoutMs: 50 })));
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe("timeout");
    expect(d.listenerCount()).toBe(0);
  });

  it("abort cleans listener", async () => {
    const d = new FakeDiscord();
    const ac = new AbortController();
    const p = waitForMessage(d, base({ timeoutMs: 5000, signal: ac.signal }));
    expect(d.listenerCount()).toBe(1);
    ac.abort();
    const err = await errorOf(p);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe("timeout");
    expect((err as ToolError).message).toBe("aborted");
    expect(d.listenerCount()).toBe(0);
  });

  it("no listener left after resolve", async () => {
    const d = new FakeDiscord();

    const live = waitForMessage(d, base());
    expect(d.listenerCount()).toBe(1);
    d.push(makeMessage({ channelId: "c1", authorId: "u2" }));
    await live;
    expect(d.listenerCount()).toBe(0);

    const anchor = makeMessage({ channelId: "c1", authorId: "u2" });
    d.messages.push(anchor, makeMessage({ channelId: "c1", authorId: "u2" }));
    await waitForMessage(d, base({ after: anchor.id }));
    expect(d.listenerCount()).toBe(0);
  });
});
