import { describe, expect, test } from "bun:test";
import { TestHarness } from "../testing/harness";
import { send, sleep } from "../src/steps";
import { btn, prompt } from "../src/steps/prompt";

describe("listActive", () => {
  test("lists in-flight conversations with flow, status and waiting info", async () => {
    const h = TestHarness.create();
    h.register("ask", [prompt.text("Q?", { store: "a" }), send("done")]);
    await h.initiateFlow("ask", { chatId: 1 });
    await h.initiateFlow("ask", { chatId: 2 });

    const all = await h.listActive();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ flowName: "ask", status: "waiting" });

    const one = await h.listActive({ chatId: 2 });
    expect(one).toHaveLength(1);
    expect(one[0]!.chatId).toBe(2);
  });
});

describe("FlowHandle", () => {
  test("editText edits the live prompt message, keeping the keyboard", async () => {
    const h = TestHarness.create();
    h.register("pick", [
      prompt.buttons("Original", { buttons: [btn("A", send("got A"))] }),
      send("after"),
    ]);
    await h.initiateFlow("pick");

    const [active] = await h.listActive();
    const handle = await h.getFlowHandle(active!.id);
    await handle!.editText("Edited!");

    expect(h.edits).toHaveLength(1);
    expect(h.edits[0]!.text).toBe("Edited!");
    expect(h.edits[0]!.replyMarkup).toBeDefined(); // keyboard kept

    await h.clickButton("A"); // still works after the edit
    await h.expectMessage("got A");
  });

  test("editButtonText relabels a button on the live keyboard", async () => {
    const h = TestHarness.create();
    h.register("pick", [prompt.buttons("Pick", { buttons: [btn("A", send("got A"))] })]);
    await h.initiateFlow("pick");

    const [active] = await h.listActive();
    const handle = await h.getFlowHandle(active!.id);
    await handle!.editButtonText("A EDITED", 0);

    const kb = h.edits[0]!.replyMarkup as { inline_keyboard: { text: string }[][] };
    expect(kb.inline_keyboard[0]![0]!.text).toBe("A EDITED");

    await h.clickButton("A EDITED"); // the relabeled button still routes
    await h.expectMessage("got A");
  });

  test("terminate() strips the keyboard and kills the conversation", async () => {
    const h = TestHarness.create();
    h.register("ask", [prompt.text("Q?", { store: "a" }), send("never")]);
    await h.initiateFlow("ask");

    const [active] = await h.listActive();
    await (await h.getFlowHandle(active!.id))!.terminate();

    expect(await h.sendUser("too late")).toBe("unhandled");
    expect(h.sentTexts()).not.toContain("never");
    expect(await h.listActive()).toHaveLength(0);
  });

  test("terminate({ continueNextSteps: true }) runs the rest of the flow", async () => {
    const h = TestHarness.create();
    h.register("ask", [prompt.text("Q?", { store: "a" }), send("continued")]);
    await h.initiateFlow("ask");

    const [active] = await h.listActive();
    await (await h.getFlowHandle(active!.id))!.terminate({ continueNextSteps: true });
    await h.expectMessage("continued");
  });
});

describe("gcFlows", () => {
  test("removes flow states and their waiters", async () => {
    const h = TestHarness.create();
    h.register("ask", [prompt.text("Q?", { store: "a" }), send("never")]);
    await h.initiateFlow("ask");
    const [active] = await h.listActive();

    await h.gcFlows([active!.id]);
    expect(await h.listActive()).toHaveLength(0);
    expect(await h.sendUser("hello")).toBe("unhandled");
  });

  test("gc'ing one flow does not remove another flow's chat waiter", async () => {
    const h = TestHarness.create();
    h.register("ask", [prompt.text("Q?", { store: "a" }), send("done")]);
    h.register("napper", [sleep(3600), send("woke")]);
    await h.initiateFlow("ask"); // suspends waiting on the chat waiter
    await h.initiateFlow("napper"); // suspends as a durable timer, same chat

    const napper = (await h.listActive()).find((a) => a.flowName === "napper");
    await h.gcFlows([napper!.id]);

    expect(await h.sendUser("answer")).toBe("handled");
    await h.expectMessage("done");
  });
});
