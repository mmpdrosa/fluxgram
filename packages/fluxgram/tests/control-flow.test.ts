import { describe, expect, test } from "bun:test";
import { TestHarness } from "../testing/harness";
import { branch, callCC, callFlow, redirectCC, ret, send, set, steps, storeCC } from "../src/steps";
import { btn, prompt } from "../src/steps/prompt";
import type { FlowContext } from "../src/engine/executor";

describe("callFlow / ret", () => {
  test("runs a subflow with an isolated store seeded from args; ret value lands in storeResult", async () => {
    const h = TestHarness.create();
    h.register("main", [
      set("outer", "untouched"),
      callFlow(
        [
          (ctx: FlowContext) => send(`sub sees a=${ctx.store["a"]} outer=${ctx.store["outer"]}`),
          (ctx: FlowContext) => ret((ctx.store["a"] as number) * 2),
        ],
        { args: { a: 21 }, storeResult: "result" },
      ),
      (ctx: FlowContext) => send(`result=${ctx.store["result"]} outer=${ctx.store["outer"]}`),
    ]);
    await h.initiateFlow("main");
    expect(h.sentTexts()).toEqual([
      "sub sees a=21 outer=undefined", // isolated store: no outer
      "result=42 outer=untouched", // caller store restored, result delivered
    ]);
  });

  test("ret exits the subflow early, skipping its remaining steps", async () => {
    const h = TestHarness.create();
    h.register("main", [
      callFlow([send("before"), ret("early"), send("never")], { storeResult: "r" }),
      (ctx: FlowContext) => send(`r=${ctx.store["r"]}`),
    ]);
    await h.initiateFlow("main");
    expect(h.sentTexts()).toEqual(["before", "r=early"]);
  });

  test("ret.fromStore returns a value from the subflow store", async () => {
    const h = TestHarness.create();
    h.register("main", [
      callFlow([set("inner", 99), ret.fromStore("inner")], { storeResult: "r" }),
      (ctx: FlowContext) => send(`r=${ctx.store["r"]}`),
    ]);
    await h.initiateFlow("main");
    expect(h.sentTexts()).toEqual(["r=99"]);
  });

  test("a subflow completing without ret yields undefined and the caller continues", async () => {
    const h = TestHarness.create();
    h.register("main", [
      callFlow([send("sub ran")], { storeResult: "r" }),
      (ctx: FlowContext) => send(`r=${String(ctx.store["r"])}`),
    ]);
    await h.initiateFlow("main");
    expect(h.sentTexts()).toEqual(["sub ran", "r=undefined"]);
  });

  test("prompts inside subflows suspend; the frame stack survives a restart", async () => {
    const h = TestHarness.create();
    h.register("main", [
      send("calling sub"),
      callFlow(
        [
          prompt.text("Number?", { store: "n" }),
          (ctx: FlowContext) => ret(Number(ctx.store["n"]) * 3),
        ],
        { storeResult: "tripled" },
      ),
      (ctx: FlowContext) => send(`tripled=${ctx.store["tripled"]}`),
    ]);
    await h.initiateFlow("main");
    await h.restart();
    await h.sendUser("5");
    expect(h.sentTexts()).toEqual(["calling sub", "Number?", "tripled=15"]);
  });

  test("nested callFlows unwind correctly", async () => {
    const h = TestHarness.create();
    h.register("main", [
      callFlow(
        [
          callFlow([ret(10)], { storeResult: "inner" }),
          (ctx: FlowContext) => ret((ctx.store["inner"] as number) + 1),
        ],
        { storeResult: "outer" },
      ),
      (ctx: FlowContext) => send(`outer=${ctx.store["outer"]}`),
    ]);
    await h.initiateFlow("main");
    expect(h.sentTexts()).toEqual(["outer=11"]);
  });

  test("ret outside any subflow routes an error to onFlowError", async () => {
    const errors: unknown[] = [];
    const h = TestHarness.create({ onFlowError: (e) => void errors.push(e.error) });
    h.register("main", [ret("nope")]);
    await h.initiateFlow("main");
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/outside.*subflow/i);
  });
});

describe("storeCC / redirectCC / callCC", () => {
  test("redirectCC jumps back to the point after storeCC (menu loop)", async () => {
    const h = TestHarness.create();
    h.register("loop", [
      storeCC("again"),
      prompt.text("Word?", { store: "w" }),
      (ctx: FlowContext) => send(`got ${ctx.store["w"]}`),
      branch((ctx) => (ctx as FlowContext).store["w"] !== "stop", redirectCC("again"), send("bye")),
    ]);
    await h.initiateFlow("loop");
    await h.sendUser("aaa");
    await h.sendUser("bbb");
    await h.sendUser("stop");
    expect(h.sentTexts()).toEqual([
      "Word?",
      "got aaa",
      "Word?",
      "got bbb",
      "Word?",
      "got stop",
      "bye",
    ]);
  });

  test("callCC runs its body; redirectCC inside skips the rest of the body", async () => {
    const h = TestHarness.create();
    h.register("main", [
      callCC("skip", steps([send("inner1"), redirectCC("skip"), send("never")])),
      send("after"),
    ]);
    await h.initiateFlow("main");
    expect(h.sentTexts()).toEqual(["inner1", "after"]);
  });

  test("redirectCC with no saved continuation routes an error", async () => {
    const errors: unknown[] = [];
    const h = TestHarness.create({ onFlowError: (e) => void errors.push(e.error) });
    h.register("main", [redirectCC("ghost")]);
    await h.initiateFlow("main");
    expect(String(errors[0])).toMatch(/no.*continuation/i);
  });

  test("saved continuations survive a restart (button 'back to menu' idiom)", async () => {
    const h = TestHarness.create();
    h.register("menu", [
      storeCC("menu"),
      prompt.buttons("Menu", {
        buttons: [
          btn(
            "inner",
            steps([
              send("inner flow"),
              prompt.buttons("Inner", { buttons: [btn("back", redirectCC("menu"))] }),
            ]),
          ),
          btn("done", send("goodbye")),
        ],
      }),
    ]);
    await h.initiateFlow("menu");
    await h.clickButton("inner");
    await h.restart();
    await h.clickButton("back"); // jumps back to the menu CC -> menu re-prompts
    expect(h.sentTexts()).toEqual(["Menu", "inner flow", "Inner", "Menu"]);
    await h.clickButton("done");
    await h.expectMessage("goodbye");
  });
});
