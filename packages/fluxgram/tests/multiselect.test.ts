import { describe, expect, test } from "bun:test";
import { TestHarness } from "../testing/harness";
import { send } from "../src/steps";
import { btn, prompt } from "../src/steps/prompt";
import type { FlowContext } from "../src/engine/executor";

function colorsFlow() {
  return [
    prompt.multiSelect("Pick colors:", { store: "colors", choices: ["Red", "Green", "Blue"] }),
    (ctx: FlowContext) =>
      send(`picked: ${(ctx.store["colors"] as string[]).join(",") || "(none)"}`),
  ];
}

describe("prompt.multiSelect", () => {
  test("sends choices plus a submit button; toggling then submitting stores the values", async () => {
    const h = TestHarness.create();
    h.register("colors", colorsFlow());
    await h.initiateFlow("colors");

    const labels = h.keyboardLabels();
    expect(labels).toEqual(["Red", "Green", "Blue", "Submit"]);

    expect(await h.clickButton("Red")).toBe("handled");
    expect(await h.clickButton("Blue")).toBe("handled");
    // toggles edit the keyboard to show selection marks
    expect(h.lastKeyboardLabels()).toEqual(["✅ Red", "Green", "✅ Blue", "Submit"]);

    await h.clickButton("Submit");
    await h.expectMessage("picked: Red,Blue");
  });

  test("toggling twice deselects", async () => {
    const h = TestHarness.create();
    h.register("colors", colorsFlow());
    await h.initiateFlow("colors");
    await h.clickButton("Red");
    await h.clickButton("✅ Red"); // deselect
    await h.clickButton("Submit");
    await h.expectMessage("picked: (none)");
  });

  test("custom display/value functions with object choices", async () => {
    const users = [
      { name: "John", id: "u1" },
      { name: "Jane", id: "u2" },
    ];
    const h = TestHarness.create();
    h.register("users", [
      prompt.multiSelect("Pick users:", {
        store: "ids",
        choices: users,
        display: (u) => (u as { name: string }).name,
        value: (u) => (u as { id: string }).id,
      }),
      (ctx: FlowContext) => send(`ids: ${(ctx.store["ids"] as string[]).join(",")}`),
    ]);
    await h.initiateFlow("users");
    await h.clickButton("Jane");
    await h.clickButton("Submit");
    await h.expectMessage("ids: u2");
  });

  test("preSelected values start selected", async () => {
    const h = TestHarness.create();
    h.register("colors", [
      prompt.multiSelect("Pick:", {
        store: "colors",
        choices: ["Red", "Green"],
        preSelected: ["Green"],
      }),
      (ctx: FlowContext) => send(`picked: ${(ctx.store["colors"] as string[]).join(",")}`),
    ]);
    await h.initiateFlow("colors");
    expect(h.keyboardLabels()).toEqual(["Red", "✅ Green", "Submit"]);
    await h.clickButton("Submit");
    await h.expectMessage("picked: Green");
  });

  test("empty submit with emptySelectionText sends it and stores an empty array", async () => {
    const h = TestHarness.create();
    h.register("colors", [
      prompt.multiSelect("Pick:", {
        store: "colors",
        choices: ["Red"],
        emptySelectionText: "Nothing selected!",
      }),
      send("after"),
    ]);
    await h.initiateFlow("colors");
    await h.clickButton("Submit");
    await h.expectMessage("Nothing selected!");
    await h.expectMessage("after");
    expect(await h.flowStore()).toMatchObject({ colors: [] });
  });

  test("extra buttons run their own step instead of submitting", async () => {
    const h = TestHarness.create();
    h.register("colors", [
      prompt.multiSelect("Pick:", {
        store: "colors",
        choices: ["Red"],
        extraButtons: [btn("Cancel", send("cancelled"))],
      }),
      send("after"),
    ]);
    await h.initiateFlow("colors");
    await h.clickButton("Cancel");
    await h.expectMessage("cancelled");
    await h.expectMessage("after");
  });

  test("selection state survives a restart", async () => {
    const h = TestHarness.create();
    h.register("colors", colorsFlow());
    await h.initiateFlow("colors");
    await h.clickButton("Red");
    await h.restart();
    await h.clickButton("Green");
    await h.clickButton("Submit");
    await h.expectMessage("picked: Red,Green");
  });

  test("a text reply bounces — buttons only", async () => {
    const h = TestHarness.create();
    h.register("colors", colorsFlow());
    await h.initiateFlow("colors");
    expect(await h.sendUser("Red please")).toBe("handled");
    await h.expectMessage(/click one of the buttons/i);
    await h.clickButton("Red");
    await h.clickButton("Submit");
    await h.expectMessage("picked: Red");
  });
});
