import { describe, expect, test } from "bun:test";
import { TestHarness } from "../testing/harness";
import { redirectCC, send, set, storeCC } from "../src/steps";
import { btn, prompt } from "../src/steps/prompt";
import { ValidationError } from "../src/errors";
import type { FlowContext } from "../src/engine/executor";

describe("prompt.text: suspend and resume", () => {
  test("suspends at the prompt; a user reply stores the text and continues", async () => {
    const h = TestHarness.create();
    h.register("onboard", [
      prompt.text("What is your name?", { store: "name" }),
      (ctx: FlowContext) => send(`hi ${ctx.store["name"]}`),
    ]);
    await h.initiateFlow("onboard");
    expect(h.sentTexts()).toEqual(["What is your name?"]); // nothing after the prompt yet

    const result = await h.sendUser("matheus");
    expect(result).toBe("handled");
    expect(h.sentTexts()).toEqual(["What is your name?", "hi matheus"]);
  });

  test("the suspended doc is durable: status waiting, prompt message id recorded", async () => {
    const h = TestHarness.create();
    h.register("onboard", [prompt.text("Name?", { store: "name" })]);
    await h.initiateFlow("onboard");
    const docs = await h.storage.listFlowStates({ botId: h.botId, status: "waiting" });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.waiting?.kind).toBe("reply");
    expect(docs[0]!.waiting?.promptMessageId).toBe(1);
  });

  test("HEADLINE: restart between prompt and reply — conversation resumes exactly where it paused", async () => {
    const h = TestHarness.create();
    h.register("onboard", [
      prompt.text("Age?", { store: "age" }),
      (ctx: FlowContext) => send(`age is ${ctx.store["age"]}`),
      send("done"),
    ]);
    await h.initiateFlow("onboard");
    await h.restart(); // process death simulated

    const result = await h.sendUser("25");
    expect(result).toBe("handled");
    expect(h.sentTexts()).toEqual(["Age?", "age is 25", "done"]);
    expect(await h.flowStore()).toMatchObject({ age: "25" });
  });

  test("messages with no waiter are unhandled (free for command routing)", async () => {
    const h = TestHarness.create();
    expect(await h.sendUser("hello?")).toBe("unhandled");
  });
});

describe("validation loop", () => {
  test("a validate function throwing ValidationError re-prompts and stays waiting", async () => {
    const h = TestHarness.create();
    h.register("age", [
      prompt.text("Age?", {
        store: "age",
        validate: (_ctx, msg) => {
          const n = Number((msg as { text?: string }).text);
          if (Number.isNaN(n) || n < 13) throw new ValidationError("Must be a number >= 13");
          return n;
        },
      }),
      (ctx: FlowContext) => send(`ok: ${ctx.store["age"]}`),
    ]);
    await h.initiateFlow("age");

    await h.sendUser("7");
    expect(h.sentTexts()).toEqual(["Age?", "Must be a number >= 13"]);

    await h.sendUser("25");
    expect(h.sentTexts()).toEqual(["Age?", "Must be a number >= 13", "ok: 25"]);
    expect(await h.flowStore()).toMatchObject({ age: 25 });
  });

  test("a Standard Schema (valibot-style) validates and transforms; issue message is the re-prompt", async () => {
    // minimal inline Standard Schema — what valibot/zod/arktype produce
    const minAge13 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (input: unknown) => {
          const n = Number(input);
          if (Number.isNaN(n)) return { issues: [{ message: "Not a number" }] };
          if (n < 13) return { issues: [{ message: "Must be at least 13" }] };
          return { value: n };
        },
      },
    };
    const h = TestHarness.create();
    h.register("age", [
      prompt.text("Age?", { store: "age", validate: minAge13 }),
      (ctx: FlowContext) => send(`stored ${typeof ctx.store["age"]} ${ctx.store["age"]}`),
    ]);
    await h.initiateFlow("age");
    await h.sendUser("abc");
    await h.expectMessage("Not a number");
    await h.sendUser("30");
    await h.expectMessage("stored number 30"); // transformed to number
  });
});

describe("prompt.buttons", () => {
  function buttonsFlow() {
    return [
      prompt.buttons("Pick one", {
        buttons: [btn("John", set("name", "john")), btn("Jane", set("name", "jane"))],
      }),
      (ctx: FlowContext) => send(`picked ${ctx.store["name"]}`),
    ];
  }

  test("sends an inline keyboard with fx-prefixed callback data", async () => {
    const h = TestHarness.create();
    h.register("pick", buttonsFlow());
    await h.initiateFlow("pick");
    const kb = h.sent[0]!.replyMarkup as {
      inline_keyboard: { text: string; callback_data: string }[][];
    };
    expect(kb.inline_keyboard.flat().map((b) => b.text)).toEqual(["John", "Jane"]);
    expect(kb.inline_keyboard[0]![0]!.callback_data).toMatch(/^fx:/);
  });

  test("clicking a button runs its step, then the flow continues after the prompt", async () => {
    const h = TestHarness.create();
    h.register("pick", buttonsFlow());
    await h.initiateFlow("pick");
    const result = await h.clickButton("Jane");
    expect(result).toBe("handled");
    await h.expectMessage("picked jane");
  });

  test("a second click on the same (consumed) button is stale", async () => {
    const h = TestHarness.create();
    h.register("pick", buttonsFlow());
    await h.initiateFlow("pick");
    await h.clickButton("John");
    expect(await h.clickButton("John")).toBe("stale");
    expect(h.sentTexts().filter((t) => t.startsWith("picked"))).toEqual(["picked john"]); // ran once
  });

  test("buttons survive a restart: click resumes from storage", async () => {
    const h = TestHarness.create();
    h.register("pick", buttonsFlow());
    await h.initiateFlow("pick");
    await h.restart();
    expect(await h.clickButton("Jane")).toBe("handled");
    await h.expectMessage("picked jane");
  });

  test("a text reply to a buttons-only prompt bounces with requireButtonText and keeps waiting", async () => {
    const h = TestHarness.create();
    h.register("pick", [
      prompt.buttons("Pick one", {
        buttons: [btn("A", send("got A"))],
        requireButtonText: "Buttons only, please.",
      }),
    ]);
    await h.initiateFlow("pick");
    expect(await h.sendUser("but I want to type")).toBe("handled");
    await h.expectMessage("Buttons only, please.");
    expect(await h.clickButton("A")).toBe("handled"); // still clickable
    await h.expectMessage("got A");
  });

  test("a prompt with store AND buttons accepts a typed reply too", async () => {
    const h = TestHarness.create();
    h.register("pick", [
      prompt.text("Name or pick", {
        store: "name",
        buttons: [btn("John", set("name", "john"))],
      }),
      (ctx: FlowContext) => send(`name=${ctx.store["name"]}`),
    ]);
    await h.initiateFlow("pick");
    await h.sendUser("custom");
    await h.expectMessage("name=custom");
  });

  test("clicking edits the prompt message to strip the keyboard and append the choice", async () => {
    const h = TestHarness.create();
    h.register("pick", buttonsFlow());
    await h.initiateFlow("pick");
    await h.clickButton("John");
    expect(h.edits).toHaveLength(1);
    expect(h.edits[0]!.text).toContain('"John"');
    expect(h.edits[0]!.replyMarkup).toBeUndefined();
  });
});

describe("prompt.message", () => {
  test("stores the whole message object", async () => {
    const h = TestHarness.create();
    h.register("any", [
      prompt.message("Send anything", { store: "msg" }),
      (ctx: FlowContext) => send(`got message ${(ctx.store["msg"] as { text: string }).text}`),
    ]);
    await h.initiateFlow("any");
    await h.sendUser("a thing");
    await h.expectMessage("got message a thing");
  });
});

describe("dynamic steps returning prompts", () => {
  test("a function returning a prompt suspends and resumes through the dynamic node", async () => {
    const h = TestHarness.create();
    h.register("menu", [
      (ctx: FlowContext) =>
        prompt.text(`Hello chat ${ctx.chatId}, type something:`, { store: "x" }),
      (ctx: FlowContext) => send(`you typed ${ctx.store["x"]}`),
    ]);
    await h.initiateFlow("menu");
    await h.expectMessage("type something");
    await h.sendUser("abc");
    await h.expectMessage("you typed abc");
  });

  test("resume through a dynamic subtree works across a restart", async () => {
    const h = TestHarness.create();
    h.register("menu", [
      () => [send("intro"), prompt.text("Q?", { store: "a" })],
      (ctx: FlowContext) => send(`answer: ${ctx.store["a"]}`),
    ]);
    await h.initiateFlow("menu");
    await h.restart();
    await h.sendUser("42");
    await h.expectMessage("answer: 42");
  });

  test("a dynamic subtree that changes shape between suspend and resume is rejected (hash check)", async () => {
    let shape = 1;
    const errors: unknown[] = [];
    const h = TestHarness.create({ onFlowError: (e) => void errors.push(e.error) });
    h.register("mut", [
      () => (shape === 1 ? prompt.text("Q?", { store: "a" }) : [send("x"), send("y")]),
      send("after"),
    ]);
    await h.initiateFlow("mut");
    shape = 2; // simulates a deploy that changed the dynamic return shape
    await h.sendUser("hello");
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/changed shape/i);
    expect(h.sentTexts()).not.toContain("after");
  });
});

describe("prompt parseMode", () => {
  test("the prompt message is sent with parse_mode and the post-click edit keeps it", async () => {
    const h = TestHarness.create();
    h.register("fancy", [
      prompt.buttons("*Pick*", {
        parseMode: "Markdown",
        buttons: [btn("A", send("got A"))],
      }),
    ]);
    await h.initiateFlow("fancy");

    const promptMsg = await h.expectMessage("*Pick*");
    expect(promptMsg.opts?.["parse_mode"]).toBe("Markdown");

    await h.clickButton("A");
    const edit = h.edits.find((e) => e.text.includes('"A"'));
    expect(edit?.opts?.["parse_mode"]).toBe("Markdown");
  });

  test("multiselect sends with parse_mode", async () => {
    const h = TestHarness.create();
    h.register("ms", [
      prompt.multiSelect("_Choose_", { store: "sel", choices: ["x"], parseMode: "Markdown" }),
    ]);
    await h.initiateFlow("ms");
    const msg = await h.expectMessage("_Choose_");
    expect(msg.opts?.["parse_mode"]).toBe("Markdown");
  });
});

describe("prompt timeouts", () => {
  test("an unanswered prompt times out: onTimeout runs, keyboard handling, flow continues", async () => {
    const h = TestHarness.create();
    h.register("expire", [
      prompt.text("Answer me", {
        store: "a",
        timeoutSecs: 60,
        onTimeout: send("too slow"),
      }),
      send("after"),
    ]);
    await h.initiateFlow("expire");

    h.clock.advance(61_000);
    await h.sweep();

    expect(h.sentTexts()).toContain("too slow");
    expect(h.sentTexts()).toContain("after");
    expect(await h.sendUser("late answer")).toBe("unhandled");
  });

  test("a timeout without onTimeout just ends the flow", async () => {
    const h = TestHarness.create();
    h.register("expire", [
      prompt.text("Answer me", { store: "a", timeoutSecs: 60 }),
      send("never"),
    ]);
    await h.initiateFlow("expire");

    h.clock.advance(61_000);
    await h.sweep();

    expect(h.sentTexts()).not.toContain("never");
    expect(await h.listActive()).toHaveLength(0);
    expect(await h.sendUser("late")).toBe("unhandled");
  });

  test("answering in time clears the deadline; later sweeps do nothing", async () => {
    const h = TestHarness.create();
    h.register("expire", [
      prompt.text("Answer me", { store: "a", timeoutSecs: 60, onTimeout: send("too slow") }),
      prompt.text("Second q (no timeout)", { store: "b" }),
      send("after"),
    ]);
    await h.initiateFlow("expire");
    expect(await h.sendUser("quick")).toBe("handled");

    h.clock.advance(120_000);
    await h.sweep();

    expect(h.sentTexts()).not.toContain("too slow");
    // the second prompt is still alive and answerable
    expect(await h.sendUser("second")).toBe("handled");
    await h.expectMessage("after");
  });

  test("multiselect timeout runs onTimeout", async () => {
    const h = TestHarness.create();
    h.register("ms", [
      prompt.multiSelect("Pick", {
        store: "sel",
        choices: ["x", "y"],
        timeoutSecs: 30,
        onTimeout: send("expired"),
      }),
      send("after"),
    ]);
    await h.initiateFlow("ms");
    h.clock.advance(31_000);
    await h.sweep();
    expect(h.sentTexts()).toContain("expired");
    expect(h.sentTexts()).toContain("after");
  });

  test("a timed-out prompt survives restart (deadline is durable)", async () => {
    const h = TestHarness.create();
    h.register("expire", [
      prompt.text("Q", { store: "a", timeoutSecs: 60, onTimeout: send("too slow") }),
      send("after"),
    ]);
    await h.initiateFlow("expire");
    await h.restart();
    h.clock.advance(61_000);
    await h.sweep();
    expect(h.sentTexts()).toContain("too slow");
  });
});

describe("onlyFrom prompt scoping", () => {
  test("replies from other users are ignored; the named user's reply answers", async () => {
    const h = TestHarness.create();
    h.register("scoped", [prompt.text("Q?", { store: "a", onlyFrom: 7 }), send("answered")]);
    await h.initiateFlow("scoped");

    expect(await h.sendUser("intruder", { fromUserId: 9 })).toBe("unhandled");
    expect(h.sentTexts()).not.toContain("answered");
    expect(await h.sendUser("mine", { fromUserId: 7 })).toBe("handled");
    expect(h.sentTexts()).toContain("answered");
  });

  test("onlyFrom 'initiator' binds to the user who started the flow", async () => {
    const h = TestHarness.create();
    h.register("scoped", [
      prompt.text("Q?", { store: "a", onlyFrom: "initiator" }),
      send("answered"),
    ]);
    await h.initiateFlow("scoped", { fromUserId: 5 });

    expect(await h.sendUser("nope", { fromUserId: 6 })).toBe("unhandled");
    expect(await h.sendUser("yes", { fromUserId: 5 })).toBe("handled");
    expect(h.sentTexts()).toContain("answered");
  });

  test("clicks from other users bounce and the prompt keeps working", async () => {
    const h = TestHarness.create();
    h.register("scoped", [
      prompt.buttons("Pick", { onlyFrom: 7, buttons: [btn("Go", send("clicked"))] }),
    ]);
    await h.initiateFlow("scoped");

    expect(await h.clickButton("Go", { fromUserId: 9 })).toBe("forbidden");
    expect(h.sentTexts()).not.toContain("clicked");
    expect(h.callbackAnswers.at(-1)?.text).toBe("This isn't for you");

    expect(await h.clickButton("Go", { fromUserId: 7 })).toBe("handled");
    expect(h.sentTexts()).toContain("clicked");
  });

  test("unscoped prompts accept anyone (groups keep current behavior)", async () => {
    const h = TestHarness.create();
    h.register("open", [prompt.text("Q?", { store: "a" }), send("answered")]);
    await h.initiateFlow("open", { fromUserId: 5 });
    expect(await h.sendUser("anyone", { fromUserId: 6 })).toBe("handled");
  });
});

describe("menu mode (reuseMessage)", () => {
  test("redirectCC menus edit one message in place instead of stacking", async () => {
    const h = TestHarness.create();
    h.register("menu", [
      storeCC("menu"),
      prompt.buttons("Main menu", {
        reuseMessage: true,
        buttons: [
          btn(
            "Settings",
            prompt.buttons("Settings menu", {
              reuseMessage: true,
              buttons: [btn("Back", redirectCC("menu"))],
            }),
          ),
        ],
      }),
    ]);
    await h.initiateFlow("menu");

    expect(h.sent).toHaveLength(1); // the only sendMessage ever
    const menuMessageId = h.sent[0]!.message_id;

    await h.clickButton("Settings");
    // settings menu was rendered by editing the same message
    const settingsEdit = h.edits.find((e) => e.text === "Settings menu");
    expect(settingsEdit?.messageId).toBe(menuMessageId);
    expect(h.sent).toHaveLength(1);

    await h.clickButton("Back");
    const backEdit = h.edits.filter((e) => e.text === "Main menu").at(-1);
    expect(backEdit?.messageId).toBe(menuMessageId);
    expect(h.sent).toHaveLength(1);

    // still a working menu after two in-place renders
    expect(await h.clickButton("Settings")).toBe("handled");
  });
});
