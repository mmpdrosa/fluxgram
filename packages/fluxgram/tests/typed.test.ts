import { describe, expect, test } from "bun:test";
import { TestHarness } from "../testing/harness";
import { defineFlow, flowKit } from "../src/steps/typed";
import { send } from "../src/steps";

interface Store {
  name: string;
  count: number;
  tags: string[];
  statusMessageId: number;
}

const k = flowKit<Store>();

describe("flowKit (typed store)", () => {
  test("typed factories produce working steps", async () => {
    const h = TestHarness.create();
    h.register("typed", [
      k.set("count", 2),
      k.prompt.text("Name?", { store: "name" }),
      k.branch(
        (ctx) => ctx.store["count"] === 2,
        k.step((ctx) => send(`hi ${ctx.store["name"]} x${ctx.store["count"]}`)),
        send("nope"),
      ),
    ]);
    await h.initiateFlow("typed");
    await h.sendUser("john");
    expect(h.sentTexts()).toContain("hi john x2");
  });

  test("store keys and value types are enforced at compile time", () => {
    // @ts-expect-error wrong value type for key
    k.set("count", "two");
    // @ts-expect-error unknown key
    k.set("missing", 1);
    // @ts-expect-error count is not a string key
    k.prompt.text("Q?", { store: "count" });
    // @ts-expect-error name is not an array key
    k.prompt.multiSelect("Pick", { store: "name", choices: ["a"] });
    // valid usages compile:
    k.prompt.multiSelect("Pick", { store: "tags", choices: ["a"] });
    k.ret.fromStore("name");
    // @ts-expect-error unknown key in ret.fromStore
    k.ret.fromStore("nope");
    expect(true).toBe(true);
  });

  test("store reads are optional and must be guarded", () => {
    k.step((ctx) => {
      // reads carry | undefined: the key may not have been written yet
      const maybe: string | undefined = ctx.store.name;
      // @ts-expect-error a read is possibly undefined until narrowed
      const sure: string = ctx.store.name;
      // narrowing recovers the value type
      if (ctx.store.name !== undefined) {
        const narrowed: string = ctx.store.name;
        void narrowed;
      }
      // writes still require the declared value type
      ctx.store.count = 1;
      // @ts-expect-error wrong value type written to store
      ctx.store.count = "two";
      void maybe;
      void sure;
      return send("x");
    });
    expect(true).toBe(true);
  });

  test("k.send: storeMessageId and onSent are checked against the store", () => {
    // storeMessageId must name a number-typed key
    k.send("queued", { storeMessageId: "statusMessageId" });
    // @ts-expect-error name is not a number key
    k.send("bad", { storeMessageId: "name" });
    // @ts-expect-error unknown key
    k.send("bad", { storeMessageId: "missing" });
    // onSent sees a typed (optional-read) store and a message with message_id
    k.send("hi", {
      onSent: (ctx, msg) => {
        ctx.store.statusMessageId = msg.message_id;
      },
    });
    // @ts-expect-error onSent write must match the declared value type
    k.send("hi", { onSent: (ctx) => (ctx.store.statusMessageId = "x") });
    expect(true).toBe(true);
  });

  test("k.pin / k.forward check fromStore against number keys", () => {
    k.pin("most_recent");
    k.pin(123);
    k.pin({ fromStore: "statusMessageId" });
    // @ts-expect-error fromStore must name a number key
    k.pin({ fromStore: "name" });
    // @ts-expect-error unknown key
    k.pin({ fromStore: "missing" });
    k.forward({ fromStore: "statusMessageId" }, { toChatId: 1 });
    k.forward(99, { toChatId: 1 });
    // @ts-expect-error fromStore must name a number key
    k.forward({ fromStore: "tags" }, { toChatId: 1 });
    expect(true).toBe(true);
  });

  test("k.callFlow checks args against the subflow store and storeResult against S", () => {
    const sub = flowKitSub();
    k.callFlow(sub, { args: { n: 1 }, storeResult: "statusMessageId" });
    // @ts-expect-error storeResult must be a key of the caller store
    k.callFlow(sub, { storeResult: "nope" });
    // @ts-expect-error args must match the subflow store shape
    k.callFlow(sub, { args: { n: "x" } });
    expect(true).toBe(true);
  });
});

function flowKitSub() {
  return defineFlow<{ n: number }>("subt", (kk) => [kk.step(() => send("x"))]);
}

describe("flowKit k.send (runtime)", () => {
  test("storeMessageId stores the sent message id into the store", async () => {
    const h = TestHarness.create();
    h.register("status", [
      k.send("Status: queued", { storeMessageId: "statusMessageId" }),
      k.step((ctx) => send(`id=${ctx.store.statusMessageId}`)),
    ]);
    await h.initiateFlow("status");
    const echoed = h.sentTexts().find((t) => t.startsWith("id="));
    expect(echoed).toBe(`id=${h.sent[0]!.message_id}`);
  });

  test("storeMessageId runs alongside a user onSent callback", async () => {
    const seen: number[] = [];
    const h = TestHarness.create();
    h.register("status", [
      k.send("queued", {
        storeMessageId: "statusMessageId",
        onSent: (_ctx, msg) => void seen.push(msg.message_id),
      }),
    ]);
    await h.initiateFlow("status");
    expect(seen).toEqual([h.sent[0]!.message_id]);
  });
});
