import { describe, expect, test } from "bun:test";
import {
  cbUpdate,
  lastKeyboard,
  makeBot,
  makeFluxgram,
  memberUpdate,
  msgUpdate,
} from "../testing/grammy-kit";
import { Fluxgram } from "../src/fluxgram";
import { FluxgramClient } from "../src/client";
import { InProcessEventBus } from "../src/events/inprocess";
import { MemoryStorage } from "../src/storage/memory";
import { send, set } from "../src/steps";
import { btn, prompt } from "../src/steps/prompt";
import type { FlowContext } from "../src/engine/executor";

describe("Fluxgram over grammY", () => {
  test("a command starts its flow", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    fx.command("start", fx.flow("hello", [send("Welcome!")]));
    await bot.handleUpdate(msgUpdate(7, "/start"));
    expect(sentTexts()).toEqual(["Welcome!"]);
  });

  test("commands with @botname and arguments still match", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    fx.command("start", fx.flow("hello", [send("Welcome!")]));
    await bot.handleUpdate(msgUpdate(7, "/start@testbot some args"));
    expect(sentTexts()).toEqual(["Welcome!"]);
  });

  test("prompt suspend/resume through real updates", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    fx.command(
      "start",
      fx.flow("ask", [
        prompt.text("Name?", { store: "name" }),
        (ctx: FlowContext) => send(`hi ${ctx.store["name"]}`),
      ]),
    );
    await bot.handleUpdate(msgUpdate(7, "/start"));
    await bot.handleUpdate(msgUpdate(7, "matheus"));
    expect(sentTexts()).toEqual(["Name?", "hi matheus"]);
  });

  test("non-text messages do not answer text prompts", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    fx.command(
      "start",
      fx.flow("ask", [
        prompt.text("Name?", { store: "name" }),
        (ctx: FlowContext) => send(`hi ${ctx.store["name"]}`),
      ]),
    );

    await bot.handleUpdate(msgUpdate(7, "/start"));
    await bot.handleUpdate(
      msgUpdate(7, "", {
        text: undefined,
        photo: [{ file_id: "p", file_unique_id: "u", width: 1, height: 1 }],
      }),
    );

    const [active] = await fx.listActive();
    expect(active?.status).toBe("waiting");

    await bot.handleUpdate(msgUpdate(7, "matheus"));
    expect(sentTexts()).toEqual(["Name?", "Please send a text message to answer.", "hi matheus"]);
    expect(await fx.listActive()).toHaveLength(0);
  });

  test("button clicks route via callback_query updates and get answered", async () => {
    const { bot, fx, calls, sentTexts } = await makeFluxgram();
    fx.command(
      "start",
      fx.flow("pick", [
        prompt.buttons("Pick", { buttons: [btn("Jane", set("n", "jane"))] }),
        (ctx: FlowContext) => send(`picked ${ctx.store["n"]}`),
      ]),
    );
    await bot.handleUpdate(msgUpdate(7, "/start"));
    const [button] = lastKeyboard(calls);
    await bot.handleUpdate(cbUpdate(7, button!.callback_data));
    expect(sentTexts()).toContain("picked jane");
    expect(calls.some((c) => c.method === "answerCallbackQuery")).toBe(true);
  });

  test("a non-override command during a prompt is treated as the reply", async () => {
    const { bot, fx } = await makeFluxgram();
    fx.command("start", fx.flow("ask", [prompt.text("Name?", { store: "name" }), send("done")]));
    fx.command("other", fx.flow("other", [send("other ran")]));
    await bot.handleUpdate(msgUpdate(7, "/start"));
    await bot.handleUpdate(msgUpdate(7, "/other"));
    const [active] = await fx.listActive();
    expect(active).toBeUndefined(); // flow finished: /other was consumed as the answer
  });

  test("an overrideActive command kills the waiting conversation and runs instead", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    fx.command("start", fx.flow("ask", [prompt.text("Name?", { store: "name" }), send("never")]));
    fx.command("cancel", fx.flow("cancel", [send("cancelled")]), { overrideActive: true });
    await bot.handleUpdate(msgUpdate(7, "/start"));
    await bot.handleUpdate(msgUpdate(7, "/cancel"));
    expect(sentTexts()).toEqual(["Name?", "cancelled"]);
    expect(await fx.listActive()).toHaveLength(0);
    await bot.handleUpdate(msgUpdate(7, "stray reply"));
    expect(sentTexts()).toEqual(["Name?", "cancelled"]); // old prompt is dead
  });

  test("onMessage regex triggers when nothing is waiting", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    fx.onMessage({ regex: /hello/i }, fx.flow("greet", [send("hey there")]));
    await bot.handleUpdate(msgUpdate(7, "Hello bot!"));
    expect(sentTexts()).toEqual(["hey there"]);
  });

  test("initiateFlow starts a flow programmatically", async () => {
    const { fx, sentTexts } = await makeFluxgram();
    fx.flow("notify", [send("ping")]);
    await fx.initiateFlow("notify", 7);
    expect(sentTexts()).toEqual(["ping"]);
  });
});

describe("middleware", () => {
  test("block() silently stops a command flow", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    fx.command("start", fx.flow("hello", [send("Welcome!")]));
    fx.use((mw, _next) => void mw.block(), { scope: "commands" });
    await bot.handleUpdate(msgUpdate(7, "/start"));
    expect(sentTexts()).toEqual([]);
  });

  test("scoping: 'command:/x' applies only to that command; initiate_flow is separate", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    fx.command("a", fx.flow("a", [send("a ran")]));
    fx.command("b", fx.flow("b", [send("b ran")]));
    fx.flow("c", [send("c ran")]);
    fx.use((mw, _next) => void mw.block(), { scope: "command:/a" });
    await bot.handleUpdate(msgUpdate(7, "/a"));
    await bot.handleUpdate(msgUpdate(7, "/b"));
    await fx.initiateFlow("c", 7);
    expect(sentTexts()).toEqual(["b ran", "c ran"]);
  });

  test("replaceFlow swaps the flow before it starts", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    fx.command("start", fx.flow("orig", [send("original")]));
    const replacement = fx.flow("repl", [send("replaced")]);
    fx.use((mw, next) => {
      mw.replaceFlow(replacement);
      next();
    });
    await bot.handleUpdate(msgUpdate(7, "/start"));
    expect(sentTexts()).toEqual(["replaced"]);
  });

  test("middleware runs in registration order and next() continues the chain", async () => {
    const order: string[] = [];
    const { bot, fx } = await makeFluxgram();
    fx.command("start", fx.flow("hello", [send("hi")]));
    fx.use((_mw, next) => {
      order.push("first");
      next();
    });
    fx.use((_mw, next) => {
      order.push("second");
      next();
    });
    await bot.handleUpdate(msgUpdate(7, "/start"));
    expect(order).toEqual(["first", "second"]);
  });
});

describe("group lifecycle", () => {
  test("onAddedToGroup fires when the bot joins", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    fx.onAddedToGroup(fx.flow("joined", [send("hello group")]));
    await bot.handleUpdate(memberUpdate(-100500, "left", "member"));
    expect(sentTexts()).toEqual(["hello group"]);
  });

  test("onBecameAdmin and onLostAdmin fire on status transitions", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    fx.onBecameAdmin(fx.flow("promoted", [send("now admin")]));
    fx.onLostAdmin(fx.flow("demoted", [send("lost admin")]));
    await bot.handleUpdate(memberUpdate(-100500, "member", "administrator"));
    await bot.handleUpdate(memberUpdate(-100500, "administrator", "member"));
    expect(sentTexts()).toEqual(["now admin", "lost admin"]);
  });
});

describe("chat migrations", () => {
  test("outgoing calls to a migrated chat id are rewritten to the new id", async () => {
    const { bot, fx, calls } = await makeFluxgram();
    fx.flow("notify", [send("after migration")]);
    await bot.handleUpdate(msgUpdate(-100, "", { migrate_to_chat_id: -100999, text: undefined }));
    await fx.initiateFlow("notify", -100);
    const sendCall = calls.find((c) => c.method === "sendMessage")!;
    expect(sendCall.payload["chat_id"]).toBe(-100999);
  });

  test("a prompt waiting in the old chat resumes from a message in the new chat", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    fx.command(
      "start",
      fx.flow("ask", [
        prompt.text("Q?", { store: "a" }),
        (ctx: FlowContext) => send(`got ${ctx.store["a"]}`),
      ]),
    );
    await bot.handleUpdate(msgUpdate(-100, "/start"));
    await bot.handleUpdate(msgUpdate(-100, "", { migrate_to_chat_id: -100999, text: undefined }));
    await bot.handleUpdate(msgUpdate(-100999, "answer from new chat"));
    expect(sentTexts()).toEqual(["Q?", "got answer from new chat"]);
  });

  test("migration mappings persist across restarts (KV)", async () => {
    const storage = new MemoryStorage();
    const first = makeBot();
    const fx1 = new Fluxgram(first.bot, { storage });
    await fx1.init();
    await first.bot.handleUpdate(
      msgUpdate(-100, "", { migrate_to_chat_id: -100999, text: undefined }),
    );

    const second = makeBot();
    const fx2 = new Fluxgram(second.bot, { storage });
    await fx2.init();
    fx2.flow("notify", [send("hi")]);
    await fx2.initiateFlow("notify", -100);
    const sendCall = second.calls.find((c) => c.method === "sendMessage")!;
    expect(sendCall.payload["chat_id"]).toBe(-100999);
  });

  test("cancel in a migrated chat clears a prompt stored under the old chat", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    fx.command("start", fx.flow("ask", [prompt.text("Q?", { store: "a" }), send("never")]));
    fx.cancelCommand("cancel");

    await bot.handleUpdate(msgUpdate(-100, "/start"));
    await bot.handleUpdate(msgUpdate(-100, "", { migrate_to_chat_id: -200, text: undefined }));
    await bot.handleUpdate(msgUpdate(-200, "/cancel"));

    expect(sentTexts()).toEqual(["Q?", "Cancelled."]);
    expect(await fx.listActive()).toHaveLength(0);

    await bot.handleUpdate(msgUpdate(-200, "stray"));
    expect(sentTexts()).toEqual(["Q?", "Cancelled."]);
  });

  test("overrideActive in a migrated chat clears the old waiting flow", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    fx.command("start", fx.flow("ask", [prompt.text("Q?", { store: "a" }), send("never")]));
    fx.command("reset", fx.flow("reset", [send("reset ran")]), { overrideActive: true });

    await bot.handleUpdate(msgUpdate(-100, "/start"));
    await bot.handleUpdate(msgUpdate(-100, "", { migrate_to_chat_id: -200, text: undefined }));
    await bot.handleUpdate(msgUpdate(-200, "/reset"));

    expect(sentTexts()).toEqual(["Q?", "reset ran"]);
    expect(await fx.listActive()).toHaveLength(0);
  });

  test("listActive for a migrated chat includes flows stored under the old chat", async () => {
    const { bot, fx } = await makeFluxgram();
    fx.command("start", fx.flow("ask", [prompt.text("Q?", { store: "a" }), send("done")]));

    await bot.handleUpdate(msgUpdate(-100, "/start"));
    await bot.handleUpdate(msgUpdate(-100, "", { migrate_to_chat_id: -200, text: undefined }));

    const active = await fx.listActive({ chatId: -200 });
    expect(active).toHaveLength(1);
    expect(active[0]?.chatId).toBe(-100);
  });

  test("event clearWaiters in a migrated chat clears old-chat waiting flows", async () => {
    const events = new InProcessEventBus();
    const { bot, fx, sentTexts } = await makeFluxgram({ events });
    const client = new FluxgramClient({ events });
    fx.command("start", fx.flow("ask", [prompt.text("Q?", { store: "a" }), send("never")]));

    await bot.handleUpdate(msgUpdate(-100, "/start"));
    await bot.handleUpdate(msgUpdate(-100, "", { migrate_to_chat_id: -200, text: undefined }));
    await client.sendMessage(-200, "cleared", { clearWaiters: true });

    expect(sentTexts()).toEqual(["Q?", "cleared"]);
    expect(await fx.listActive()).toHaveLength(0);
  });
});

describe("hooks", () => {
  test("onBotSentMessage and onBotHandledMessage fire", async () => {
    const sentHook: unknown[] = [];
    const handledHook: unknown[] = [];
    const { bot, fx } = await makeFluxgram();
    fx.onBotSentMessage((m) => void sentHook.push(m));
    fx.onBotHandledMessage((m) => void handledHook.push(m));
    fx.command("start", fx.flow("ask", [prompt.text("Q?", { store: "a" }), send("done")]));
    await bot.handleUpdate(msgUpdate(7, "/start"));
    await bot.handleUpdate(msgUpdate(7, "reply"));
    expect(sentHook.length).toBeGreaterThanOrEqual(2); // Q? and done
    expect(handledHook.length).toBe(2); // the command and the reply
  });
});

describe("review fixes: routing & construction", () => {
  test("a /g-flagged onMessage regex matches every matching message, not every other one", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    fx.onMessage({ regex: /hi/g }, fx.flow("greet", [send("hey")]));
    await bot.handleUpdate(msgUpdate(7, "hi"));
    await bot.handleUpdate(msgUpdate(7, "hi"));
    await bot.handleUpdate(msgUpdate(7, "hi"));
    expect(sentTexts()).toEqual(["hey", "hey", "hey"]);
  });

  test("constructing Fluxgram with an uninitialized bot throws a clear error", async () => {
    const { Bot } = await import("grammy");
    const raw = new Bot("42:TEST"); // no botInfo, never inited
    expect(() => new Fluxgram(raw, { storage: new MemoryStorage() })).toThrow(/bot\.init\(\)/);
  });

  test("middleware mutations of params.store reach the started flow", async () => {
    const { fx, sentTexts } = await makeFluxgram();
    fx.flow("show", [(ctx: FlowContext) => send(`v=${ctx.store["injected"]}`)]);
    fx.use(async (mw, next) => {
      if (mw.params["store"] === undefined) mw.params["store"] = { injected: "yes" };
      await next();
    });
    await fx.initiateFlow("show", 7);
    expect(sentTexts()).toEqual(["v=yes"]);
  });

  test("event handler errors are reported through onEventError", async () => {
    const { InProcessEventBus } = await import("../src/events/inprocess");
    const errors: unknown[] = [];
    const { fx } = await makeFluxgram({
      events: new InProcessEventBus(),
      onEventError: (error) => errors.push(error),
    });
    fx.onEvent("explode", () => {
      throw new Error("kaboom");
    });
    const { FluxgramClient } = await import("../src/client");
    const client = new FluxgramClient({ events: fx["events"] as never });
    await client.emit("explode");
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as Error).message)).toBe("kaboom");
  });
});

describe("observability through the facade", () => {
  test("sinks passed to FluxgramOptions receive flow events", async () => {
    const events: unknown[] = [];
    const { bot, fx } = await makeFluxgram({
      sinks: [{ handle: (e) => void events.push(e) }],
    });
    fx.command("go", fx.flow("hello", [send("hi")]));
    await bot.handleUpdate(msgUpdate(7, "/go"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ flow: "hello", outcome: "completed" });
  });
});

describe("chained migrations", () => {
  test("a waiter two migrations back still receives the answer", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    fx.command(
      "start",
      fx.flow("ask", [
        prompt.text("Q?", { store: "a" }),
        (ctx: FlowContext) => send(`got ${ctx.store["a"]}`),
      ]),
    );
    await bot.handleUpdate(msgUpdate(-100, "/start"));
    // A → B → C
    await bot.handleUpdate(msgUpdate(-100, "", { migrate_to_chat_id: -200, text: undefined }));
    await bot.handleUpdate(msgUpdate(-200, "", { migrate_to_chat_id: -300, text: undefined }));
    await bot.handleUpdate(msgUpdate(-300, "answer"));
    expect(sentTexts()).toEqual(["Q?", "got answer"]);
  });
});

describe("cancelCommand", () => {
  test("cancels the waiting conversation and confirms", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    fx.command("start", fx.flow("ask", [prompt.text("Name?", { store: "n" }), send("never")]));
    fx.cancelCommand("cancel");
    await bot.handleUpdate(msgUpdate(7, "/start"));
    await bot.handleUpdate(msgUpdate(7, "/cancel"));
    expect(sentTexts()).toEqual(["Name?", "Cancelled."]);
    expect(await fx.listActive()).toHaveLength(0);
    await bot.handleUpdate(msgUpdate(7, "stray"));
    expect(sentTexts()).toEqual(["Name?", "Cancelled."]); // prompt is dead
  });

  test("reports when nothing was active, with custom texts", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    fx.cancelCommand("cancel", { text: "Stopped!", notActiveText: "Idle." });
    await bot.handleUpdate(msgUpdate(7, "/cancel"));
    expect(sentTexts()).toEqual(["Idle."]);
  });
});

describe("broadcast", () => {
  test("sends to every chat, reports dead chats and gcs their flows", async () => {
    const { bot, fx, calls } = await makeFluxgram();
    // chat 666 dies (user blocks the bot) after the flow below starts waiting
    let chat666Dead = false;
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (
        chat666Dead &&
        method === "sendMessage" &&
        (payload as { chat_id?: number }).chat_id === 666
      ) {
        throw new Error("Forbidden: bot was blocked by the user");
      }
      return prev(method, payload, signal);
    });

    // a waiting flow in the soon-dead chat that must get cleaned up
    fx.flow("ask", [prompt.text("Q?", { store: "a" }), send("done")]);
    await fx.initiateFlow("ask", 666);
    expect(await fx.listActive({ chatId: 666 })).toHaveLength(1);
    chat666Dead = true;

    const progress: number[] = [];
    const result = await fx.broadcast([1, 666, 3], "hello all", {
      onProgress: (done) => progress.push(done),
    });

    expect(result.sent).toEqual([1, 3]);
    expect(result.dead).toEqual([666]);
    expect(result.failed).toEqual([]);
    expect(progress).toEqual([1, 2, 3]);
    expect(await fx.listActive({ chatId: 666 })).toHaveLength(0);
    expect(
      calls.filter((c) => c.method === "sendMessage" && c.payload["text"] === "hello all"),
    ).toHaveLength(2); // 666 rejected at the transport
  });
});
