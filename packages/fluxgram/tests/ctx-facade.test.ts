import { describe, expect, test } from "bun:test";
import { TestHarness } from "../testing/harness";
import type { FlowContext } from "../src/engine/executor";

describe("ctx facade", () => {
  test("ctx.send sends a chat-bound message and returns the sent message", async () => {
    const h = TestHarness.create();
    h.register("f", [
      async (ctx: FlowContext) => {
        const msg = await ctx.send("hello from ctx");
        await ctx.send(`my id was ${msg.message_id}`);
      },
    ]);
    await h.initiateFlow("f");
    expect(h.sentTexts()).toEqual(["hello from ctx", "my id was 1"]);
  });

  test("ctx.editMessage edits a previously sent message in this chat", async () => {
    const h = TestHarness.create();
    h.register("f", [
      async (ctx: FlowContext) => {
        const msg = await ctx.send("v1");
        await ctx.editMessage(msg.message_id, "v2");
      },
    ]);
    await h.initiateFlow("f");
    expect(h.edits).toHaveLength(1);
    expect(h.edits[0]!.text).toBe("v2");
    expect(h.edits[0]!.messageId).toBe(1);
  });
});
