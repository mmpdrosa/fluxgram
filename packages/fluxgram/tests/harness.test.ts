import { describe, expect, test } from "bun:test";
import { TestHarness } from "../testing/harness";
import { branch, send, set } from "../src/steps";
import type { FlowContext } from "../src/engine/executor";

describe("TestHarness", () => {
  test("runs a registered flow and records sent messages", async () => {
    const h = TestHarness.create();
    h.register("hello", [send("hi"), send("there")]);
    await h.initiateFlow("hello");
    expect(h.sentTexts()).toEqual(["hi", "there"]);
  });

  test("expectMessage resolves when a sent message matches", async () => {
    const h = TestHarness.create();
    h.register("hello", [send("Welcome to onboarding!")]);
    await h.initiateFlow("hello");
    await h.expectMessage(/Welcome/);
  });

  test("expectMessage throws a useful error when nothing matches", async () => {
    const h = TestHarness.create();
    h.register("hello", [send("hi")]);
    await h.initiateFlow("hello");
    expect(h.expectMessage(/nope/)).rejects.toThrow(/no sent message matching/i);
  });

  test("exposes the store of the last initiated flow", async () => {
    const h = TestHarness.create();
    h.register("storey", [
      set("age", 25),
      (ctx: FlowContext) => {
        ctx.store["doubled"] = (ctx.store["age"] as number) * 2;
      },
    ]);
    await h.initiateFlow("storey");
    expect(h.store).toMatchObject({ age: 25, doubled: 50 });
  });

  test("restart() rebuilds the engine on the same storage — persisted docs survive", async () => {
    const h = TestHarness.create();
    h.register("f", [send("before restart")]);
    await h.initiateFlow("f");
    await h.restart();
    const done = await h.storage.listFlowStates({ botId: h.botId, status: "done" });
    expect(done).toHaveLength(1);
    // engine still works after restart
    await h.initiateFlow("f");
    expect(h.sentTexts()).toEqual(["before restart", "before restart"]);
  });

  test("different chats are supported via the chatId option", async () => {
    const h = TestHarness.create();
    h.register("f", [
      branch((ctx) => (ctx as FlowContext).chatId === 1, send("one"), send("other")),
    ]);
    await h.initiateFlow("f", { chatId: 1 });
    await h.initiateFlow("f", { chatId: 2 });
    expect(h.sent.map((s) => `${s.chatId}:${s.text}`)).toEqual(["1:one", "2:other"]);
  });
});
