import { describe, expect, test } from "bun:test";
import { TestHarness } from "../testing/harness";
import { forward, pin, send, unpin } from "../src/steps";
import { prompt } from "../src/steps/prompt";
import { splitText } from "../src/util/chunk";

describe("splitText", () => {
  test("short text stays a single chunk", () => {
    expect(splitText("hello", 4000)).toEqual(["hello"]);
  });

  test("splits long text into chunks within the limit, preferring paragraph boundaries", () => {
    const para = "word ".repeat(50).trim(); // ~250 chars
    const text = Array.from({ length: 10 }, (_, i) => `P${i} ${para}`).join("\n\n");
    const chunks = splitText(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    // no paragraph is cut in half: every paragraph appears intact in some chunk
    for (let i = 0; i < 10; i++) {
      expect(chunks.some((c) => c.includes(`P${i} ${para}`))).toBe(true);
    }
  });

  test("hard-splits a single oversized line as a last resort", () => {
    const text = "x".repeat(2500);
    const chunks = splitText(text, 1000);
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toBe(text);
  });
});

describe("send: chunking and parse-mode fallback", () => {
  test("an over-limit text is sent as multiple messages, all within the limit", async () => {
    const h = TestHarness.create();
    const long = Array.from({ length: 30 }, (_, i) => `para ${i} ${"word ".repeat(60)}`).join(
      "\n\n",
    );
    h.register("long", [send(long)]);
    await h.initiateFlow("long");
    expect(h.sent.length).toBeGreaterThan(1);
    for (const m of h.sent) expect(m.text.length).toBeLessThanOrEqual(4000);
  });

  test("on a parse-entities error, retries once without parseMode", async () => {
    const h = TestHarness.create();
    h.onSend((req) => {
      if (req.opts?.["parse_mode"]) throw new Error("Bad Request: can't parse entities: lol");
    });
    h.register("html", [send("<b>broken html", { parseMode: "html" })]);
    await h.initiateFlow("html");
    expect(h.sentTexts()).toEqual(["<b>broken html"]); // delivered, sans parse mode
    expect(h.sent[0]!.opts?.["parse_mode"]).toBeUndefined();
  });

  test("other send errors propagate to onFlowError", async () => {
    const errors: unknown[] = [];
    const h = TestHarness.create({ onFlowError: (e) => void errors.push(e.error) });
    h.onSend(() => {
      throw new Error("Internal Server Error: upstream exploded");
    });
    h.register("f", [send("hi")]);
    await h.initiateFlow("f");
    expect(String(errors[0])).toContain("upstream exploded");
  });
});

describe("media sends", () => {
  test("send.photo delivers a photo with caption", async () => {
    const h = TestHarness.create();
    h.register("p", [send.photo("file-id-1", "look at this")]);
    await h.initiateFlow("p");
    expect(h.mediaSent).toEqual([
      { kind: "photo", chatId: h.defaultChatId, file: "file-id-1", caption: "look at this" },
    ]);
  });

  test("send.document and send.video route to their API methods", async () => {
    const h = TestHarness.create();
    h.register("m", [send.document("doc-1", "the doc"), send.video("vid-1", "the vid")]);
    await h.initiateFlow("m");
    expect(h.mediaSent.map((m) => m.kind)).toEqual(["document", "video"]);
  });

  test("an over-limit caption: first chunk is the caption, the rest are plain messages", async () => {
    const h = TestHarness.create();
    const longCaption = "word ".repeat(500); // ~2500 chars > 1000 caption limit
    h.register("p", [send.photo("file-1", longCaption)]);
    await h.initiateFlow("p");
    expect(h.mediaSent).toHaveLength(1);
    expect(h.mediaSent[0]!.caption!.length).toBeLessThanOrEqual(1000);
    expect(h.sent.length).toBeGreaterThanOrEqual(1); // remainder as text messages
  });
});

describe("forward / pin / unpin", () => {
  test("forward sends the message to the target chat", async () => {
    const h = TestHarness.create();
    h.register("f", [forward(123, { toChatId: 555 })]);
    await h.initiateFlow("f");
    expect(h.forwards).toEqual([{ fromChatId: h.defaultChatId, toChatId: 555, messageId: 123 }]);
  });

  test("pin('most_recent_bot') pins the last bot message", async () => {
    const h = TestHarness.create();
    h.register("f", [send("pin me"), pin("most_recent_bot")]);
    await h.initiateFlow("f");
    expect(h.pins).toEqual([{ chatId: h.defaultChatId, messageId: 1 }]);
  });

  test("pin('most_recent_user') pins the last user message", async () => {
    const h = TestHarness.create();
    h.register("f", [
      prompt.text("say something", { store: "x" }),
      pin("most_recent_user"),
      send("pinned!"),
    ]);
    await h.initiateFlow("f");
    await h.sendUser("pin this");
    expect(h.pins).toHaveLength(1);
    await h.expectMessage("pinned!");
  });

  test("pin(fromStore) pins a message id kept in the store", async () => {
    const h = TestHarness.create();
    h.register("f", [
      send("target", { onSent: (ctx, msg) => void (ctx.store["mid"] = msg.message_id) }),
      pin({ fromStore: "mid" }),
    ]);
    await h.initiateFlow("f");
    expect(h.pins).toEqual([{ chatId: h.defaultChatId, messageId: 1 }]);
  });

  test("when the bot lacks pin permission in a group, degrades to an explanatory message", async () => {
    const h = TestHarness.create();
    h.canPin = false; // permission checks only apply to groups (negative chat ids)
    h.register("f", [send("x"), pin("most_recent_bot"), send("after")]);
    await h.initiateFlow("f", { chatId: -100 });
    expect(h.pins).toHaveLength(0);
    await h.expectMessage(/failed to pin/i);
    await h.expectMessage("after"); // flow continues
  });

  test("unpin removes a pin", async () => {
    const h = TestHarness.create();
    h.register("f", [send("x"), pin("most_recent_bot"), unpin("most_recent_bot")]);
    await h.initiateFlow("f");
    expect(h.unpins).toEqual([{ chatId: h.defaultChatId, messageId: 1 }]);
  });
});
