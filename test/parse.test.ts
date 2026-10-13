import { expect, it } from "vitest";
import { formatAgentMsg, parseAgentMsg } from "../src/parse.js";

it("parses agent-msg block", () => {
  const text = [
    "first draft",
    "```agent-msg",
    '{"to":"old","kind":"note"}',
    "```",
    "final answer",
    "```agent-msg",
    '{"to":"bot-b","thread":"t1","kind":"request"}',
    "```",
  ].join("\n");
  expect(parseAgentMsg(text)).toStrictEqual({ to: "bot-b", thread: "t1", kind: "request" });
});

it("ignores bad json block", () => {
  expect(parseAgentMsg("hi\n```agent-msg\n{not json\n```")).toBeNull();
  expect(parseAgentMsg("hi\n```agent-msg\n[1,2]\n```")).toBeNull();
  expect(parseAgentMsg("hi\n```agent-msg\n\"text\"\n```")).toBeNull();
});

it("returns null with no block", () => {
  expect(parseAgentMsg("plain text")).toBeNull();
  expect(parseAgentMsg("```ts\nconst a = 1;\n```")).toBeNull();
  expect(parseAgentMsg("")).toBeNull();
});

it("drops unknown keys", () => {
  const text = '```agent-msg\n{"to":"bot","secret":"x","kind":"bogus","thread":5}\n```';
  expect(parseAgentMsg(text)).toStrictEqual({ to: "bot" });
});

it("format then parse round trip", () => {
  const msg = { to: "bot-b", thread: "t1", kind: "reply" as const };
  const text = formatAgentMsg("done", msg);
  expect(text).toBe('done\n```agent-msg\n{"to":"bot-b","thread":"t1","kind":"reply"}\n```');
  expect(parseAgentMsg(text)).toStrictEqual(msg);

  const partial = formatAgentMsg("ok", { to: "bot-c", thread: undefined });
  expect(partial).toBe('ok\n```agent-msg\n{"to":"bot-c"}\n```');
  expect(parseAgentMsg(partial)).toStrictEqual({ to: "bot-c" });
});
