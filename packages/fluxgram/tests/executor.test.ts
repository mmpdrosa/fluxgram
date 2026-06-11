import { describe, expect, test } from "bun:test";
import { Engine, type FlowErrorContext } from "../src/engine/executor";
import { FlowRegistry } from "../src/engine/registry";
import { MemoryStorage } from "../src/storage/memory";
import { branch, send, set, steps } from "../src/steps";
import type { FlowContext } from "../src/engine/executor";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Sent {
  chatId: number;
  text: string;
}

function makeFakeApi() {
  const sent: Sent[] = [];
  let nextId = 1;
  return {
    sent,
    api: {
      async sendMessage(chatId: number, text: string) {
        sent.push({ chatId, text });
        return { message_id: nextId++, chat: { id: chatId }, text };
      },
    },
  };
}

function makeEngine(opts?: { onFlowError?: (e: FlowErrorContext) => unknown }) {
  const registry = new FlowRegistry();
  const storage = new MemoryStorage();
  const { sent, api } = makeFakeApi();
  const engine = new Engine({ botId: 42, registry, storage, api, ...opts });
  return { registry, storage, engine, sent };
}

describe("Engine: basic execution", () => {
  test("runs send steps in order and completes", async () => {
    const { registry, engine, sent } = makeEngine();
    registry.register("hello", [send("one"), send("two")]);
    await engine.initiateFlow("hello", 100);
    expect(sent.map((s) => s.text)).toEqual(["one", "two"]);
  });

  test("set writes to the store; dynamic steps read and mutate it", async () => {
    const { registry, engine, sent } = makeEngine();
    registry.register("storey", [
      set("name", "john"),
      (ctx: FlowContext) => {
        ctx.store["name"] = `${ctx.store["name"]}!`;
      },
      (ctx: FlowContext) => send(`hi ${ctx.store["name"]}`),
    ]);
    await engine.initiateFlow("storey", 100);
    expect(sent.map((s) => s.text)).toEqual(["hi john!"]);
  });

  test("initiateFlow seeds the store", async () => {
    const { registry, engine, sent } = makeEngine();
    registry.register("seeded", [(ctx: FlowContext) => send(`v=${ctx.store["v"]}`)]);
    await engine.initiateFlow("seeded", 100, { store: { v: 7 } });
    expect(sent.map((s) => s.text)).toEqual(["v=7"]);
  });

  test("nested steps execute depth-first in order", async () => {
    const { registry, engine, sent } = makeEngine();
    registry.register("nested", [
      send("a"),
      steps([send("b"), steps([send("c")]), send("d")]),
      send("e"),
    ]);
    await engine.initiateFlow("nested", 100);
    expect(sent.map((s) => s.text)).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("throws when initiating an unregistered flow", async () => {
    const { engine } = makeEngine();
    await expect(engine.initiateFlow("nope", 100)).rejects.toThrow(/not registered/);
  });
});

describe("Engine: branch", () => {
  test("takes the true arm", async () => {
    const { registry, engine, sent } = makeEngine();
    registry.register("b", [branch(() => true, send("t"), send("f"))]);
    await engine.initiateFlow("b", 100);
    expect(sent.map((s) => s.text)).toEqual(["t"]);
  });

  test("takes the false arm; missing false arm is a no-op", async () => {
    const { registry, engine, sent } = makeEngine();
    registry.register("b1", [branch(() => false, send("t"), send("f")), send("after")]);
    registry.register("b2", [branch(() => false, send("t")), send("after")]);
    await engine.initiateFlow("b1", 100);
    await engine.initiateFlow("b2", 100);
    expect(sent.map((s) => s.text)).toEqual(["f", "after", "after"]);
  });

  test("condition reads the store", async () => {
    const { registry, engine, sent } = makeEngine();
    registry.register("b", [
      set("x", 10),
      branch((ctx) => (ctx as FlowContext).store["x"] === 10, send("yes"), send("no")),
    ]);
    await engine.initiateFlow("b", 100);
    expect(sent.map((s) => s.text)).toEqual(["yes"]);
  });

  test("a throwing condition runs the error arm when present", async () => {
    const { registry, engine, sent } = makeEngine();
    registry.register("b", [
      branch(
        () => {
          throw new Error("cond boom");
        },
        send("t"),
        send("f"),
        send("err"),
      ),
      send("after"),
    ]);
    await engine.initiateFlow("b", 100);
    expect(sent.map((s) => s.text)).toEqual(["err", "after"]);
  });
});

describe("Engine: dynamic steps", () => {
  test("a dynamic step returning an array of steps executes them", async () => {
    const { registry, engine, sent } = makeEngine();
    registry.register("dyn", [() => [send("one"), send("two")], send("three")]);
    await engine.initiateFlow("dyn", 100);
    expect(sent.map((s) => s.text)).toEqual(["one", "two", "three"]);
  });

  test("a dynamic step returning void just continues", async () => {
    const { registry, engine, sent } = makeEngine();
    registry.register("dyn", [() => undefined, send("after")]);
    await engine.initiateFlow("dyn", 100);
    expect(sent.map((s) => s.text)).toEqual(["after"]);
  });

  test("async dynamic steps are awaited", async () => {
    const { registry, engine, sent } = makeEngine();
    registry.register("dyn", [
      async () => {
        await sleep(5);
        return send("slow");
      },
      send("after"),
    ]);
    await engine.initiateFlow("dyn", 100);
    expect(sent.map((s) => s.text)).toEqual(["slow", "after"]);
  });
});

describe("Engine: durability (write-through per step)", () => {
  test("completed flows are persisted with status done", async () => {
    const { registry, engine, storage } = makeEngine();
    registry.register("f", [send("x"), set("k", 1)]);
    await engine.initiateFlow("f", 100);
    const docs = await storage.listFlowStates({ botId: 42, status: "done" });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.store["k"]).toBe(1);
    expect(docs[0]!.flowName).toBe("f");
    expect(docs[0]!.treeHash).toBeTruthy();
  });

  test("a crash mid-flow leaves a running doc whose path points at the failing step", async () => {
    const { registry, engine, storage } = makeEngine({ onFlowError: () => undefined });
    registry.register("f", [
      send("ok"), // [0]
      () => {
        throw new Error("boom");
      }, // [1]
      send("never"), // [2]
    ]);
    await engine.initiateFlow("f", 100);
    const docs = await storage.listFlowStates({ botId: 42, status: "running" });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.path).toEqual([1]);
  });

  test("store changes are persisted as steps complete", async () => {
    const { registry, engine, storage } = makeEngine({ onFlowError: () => undefined });
    registry.register("f", [
      set("progress", "started"),
      () => {
        throw new Error("boom");
      },
    ]);
    await engine.initiateFlow("f", 100);
    const docs = await storage.listFlowStates({ botId: 42, status: "running" });
    expect(docs[0]!.store["progress"]).toBe("started");
  });
});

describe("Engine: error handling", () => {
  test("uncaught step errors invoke onFlowError with flow/path/error", async () => {
    let captured: FlowErrorContext | undefined;
    const { registry, engine } = makeEngine({
      onFlowError: (e) => {
        captured = e;
      },
    });
    registry.register("f", [
      send("ok"),
      () => {
        throw new Error("boom");
      },
    ]);
    await engine.initiateFlow("f", 100);
    expect(captured?.flowName).toBe("f");
    expect(captured?.path).toEqual([1]);
    expect((captured!.error as Error).message).toBe("boom");
  });

  test("a step returned by onFlowError runs (in the same chat)", async () => {
    const { registry, engine, sent } = makeEngine({
      onFlowError: () => send("recovered"),
    });
    registry.register("f", [
      () => {
        throw new Error("boom");
      },
    ]);
    await engine.initiateFlow("f", 100);
    expect(sent.map((s) => s.text)).toEqual(["recovered"]);
  });

  test("without a handler, initiateFlow rejects", async () => {
    const { registry, engine } = makeEngine();
    registry.register("f", [
      () => {
        throw new Error("boom");
      },
    ]);
    await expect(engine.initiateFlow("f", 100)).rejects.toThrow("boom");
  });
});

describe("Engine: per-chat serialization", () => {
  test("two flows in the same chat do not interleave; different chats do run concurrently", async () => {
    const { registry, engine, sent } = makeEngine();
    registry.register("slow", [
      async () => {
        await sleep(25);
      },
      send("slow done"),
    ]);
    registry.register("fast", [send("fast done")]);

    const a = engine.initiateFlow("slow", 100);
    const b = engine.initiateFlow("fast", 100); // same chat: must wait for slow
    const c = engine.initiateFlow("fast", 200); // other chat: should finish first
    await Promise.all([a, b, c]);

    expect(sent.map((s) => `${s.chatId}:${s.text}`)).toEqual([
      "200:fast done",
      "100:slow done",
      "100:fast done",
    ]);
  });
});

describe("Engine: callback vs reply race", () => {
  test("simultaneous text reply and button click advance the flow only once", async () => {
    const { TestHarness } = await import("../testing/harness");
    const { prompt, btn } = await import("../src/steps/prompt");
    const h = TestHarness.create();
    h.register("race", [
      prompt.text("Pick or type", {
        store: "answer",
        buttons: [btn("Skip", send("skipped"))],
      }),
      send("done"),
    ]);
    await h.initiateFlow("race");

    // both claims succeed (different waiter keys); only one may advance the flow
    await Promise.all([h.sendUser("typed"), h.clickButton("Skip")]);

    expect(h.sentTexts().filter((t) => t === "done")).toHaveLength(1);
  });
});

describe("empty sends", () => {
  test("send('') throws at authoring time", () => {
    expect(() => send("")).toThrow(/non-empty/);
  });

  test("a raw empty send step fails loudly at runtime instead of hitting Telegram", async () => {
    const { registry, engine } = makeEngine();
    registry.register("empty", [{ kind: "send", text: "" } as never]);
    await expect(engine.initiateFlow("empty", 100)).rejects.toThrow(/empty/);
  });

  test("captionless media is fine", async () => {
    const { TestHarness } = await import("../testing/harness");
    const h = TestHarness.create();
    h.register("pic", [send.photo("file-id")]);
    await h.initiateFlow("pic");
    expect(h.mediaSent).toHaveLength(1);
  });
});

describe("dynamic expansion depth", () => {
  test("a dynamic step that keeps returning functions fails with a clear error", async () => {
    const { registry, engine } = makeEngine();
    const loop: () => unknown = () => loop;
    registry.register("looper", [loop]);
    await expect(engine.initiateFlow("looper", 100)).rejects.toThrow(/dynamic/i);
  });
});
