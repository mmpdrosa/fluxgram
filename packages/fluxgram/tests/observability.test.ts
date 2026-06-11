import { describe, expect, test } from "bun:test";
import { TestHarness } from "../testing/harness";
import { send, sleep } from "../src/steps";
import { btn, prompt } from "../src/steps/prompt";
import { isChatDead } from "../src/errors";
import { jsonSink, evlogSink } from "../src/observability/sinks";
import { DebugChatSink } from "../src/observability/debug-chat";
import type { FlowEvent, ObservabilitySink } from "../src/observability/events";
import type { FlowContext } from "../src/engine/executor";

function collector(): { sink: ObservabilitySink; events: FlowEvent[] } {
  const events: FlowEvent[] = [];
  return { sink: { handle: (e) => void events.push(e) }, events };
}

describe("wide events: one per execution cycle", () => {
  test("a completed flow emits one event with actions and api call counts", async () => {
    const { sink, events } = collector();
    const h = TestHarness.create({ sinks: [sink] });
    h.register("hello", [send("one"), send("two")]);
    await h.initiateFlow("hello");

    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({
      flow: "hello",
      chatId: h.defaultChatId,
      trigger: "initiate",
      outcome: "completed",
      level: "info",
    });
    expect(e.apiCalls).toBe(2);
    expect(e.actions.filter((a) => a.kind === "send").map((a) => a.text)).toEqual(["one", "two"]);
    expect(e.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("a prompt cycle suspends; the reply cycle completes", async () => {
    const { sink, events } = collector();
    const h = TestHarness.create({ sinks: [sink] });
    h.register("ask", [prompt.text("Q?", { store: "a" }), send("done")]);
    await h.initiateFlow("ask");
    await h.sendUser("hi");

    expect(events.map((e) => `${e.trigger}:${e.outcome}`)).toEqual([
      "initiate:suspended",
      "reply:completed",
    ]);
    expect(events[0]!.actions.some((a) => a.kind === "prompt" && a.text === "Q?")).toBe(true);
    expect(events[1]!.actions.some((a) => a.kind === "reply" && a.text === "hi")).toBe(true);
  });

  test("button clicks produce a button-triggered event with the label", async () => {
    const { sink, events } = collector();
    const h = TestHarness.create({ sinks: [sink] });
    h.register("pick", [
      prompt.buttons("Pick", { buttons: [btn("Jane", send("ok"))] }),
      send("after"),
    ]);
    await h.initiateFlow("pick");
    await h.clickButton("Jane");

    const click = events.find((e) => e.trigger === "button")!;
    expect(click.outcome).toBe("completed");
    expect(click.actions.some((a) => a.kind === "button" && a.text === "Jane")).toBe(true);
  });

  test("validation failures are recorded; the cycle stays suspended", async () => {
    const { sink, events } = collector();
    const h = TestHarness.create({ sinks: [sink] });
    h.register("age", [
      prompt.text("Age?", {
        store: "age",
        validate: {
          "~standard": {
            validate: (v: unknown) =>
              Number.isNaN(Number(v))
                ? { issues: [{ message: "Not a number" }] }
                : { value: Number(v) },
          },
        },
      }),
    ]);
    await h.initiateFlow("age");
    await h.sendUser("abc");

    const replyCycle = events.at(-1)!;
    expect(replyCycle.outcome).toBe("suspended");
    expect(
      replyCycle.actions.some((a) => a.kind === "validation-failed" && a.text === "Not a number"),
    ).toBe(true);
  });

  test("flow errors produce an error event with the message", async () => {
    const { sink, events } = collector();
    const h = TestHarness.create({ sinks: [sink], onFlowError: () => undefined });
    h.register("boom", [
      send("ok"),
      () => {
        throw new Error("kapow");
      },
    ]);
    await h.initiateFlow("boom");

    const e = events[0]!;
    expect(e.outcome).toBe("error");
    expect(e.level).toBe("error");
    expect(e.error?.message).toContain("kapow");
  });

  test("ctx.debug appends actions; notify propagates to the event", async () => {
    const { sink, events } = collector();
    const h = TestHarness.create({ sinks: [sink] });
    h.register("dbg", [
      (ctx: FlowContext) => {
        ctx.debug("checkpoint reached", { notify: true });
      },
      send("done"),
    ]);
    await h.initiateFlow("dbg");

    const e = events[0]!;
    expect(e.notify).toBe(true);
    expect(e.actions.some((a) => a.kind === "debug" && a.text === "checkpoint reached")).toBe(true);
  });

  test("timer resumes from the sweep are their own cycles with trigger 'timer'", async () => {
    const { sink, events } = collector();
    const h = TestHarness.create({ sinks: [sink] });
    h.register("nap", [sleep(60), send("woke")]);
    await h.initiateFlow("nap");
    h.clock.advance(61_000);
    await h.sweep();

    expect(events.map((e) => `${e.trigger}:${e.outcome}`)).toEqual([
      "initiate:suspended",
      "timer:completed",
    ]);
  });
});

describe("dead-chat detection", () => {
  test("isChatDead matches Telegram's fatal descriptions and nothing else", () => {
    expect(isChatDead(new Error("Forbidden: bot was blocked by the user"))).toBe(true);
    expect(isChatDead(new Error("Bad Request: chat not found"))).toBe(true);
    expect(isChatDead(new Error("Forbidden: bot was kicked from the supergroup chat"))).toBe(true);
    expect(isChatDead(new Error("Bad Request: group chat was deleted"))).toBe(true);
    expect(isChatDead(new Error("Bad Request: can't parse entities"))).toBe(false);
    expect(isChatDead(new Error("anything else"))).toBe(false);
  });

  test("a dead chat ends the conversation: no recovery flow, states cleaned, outcome dead-chat", async () => {
    const { sink, events } = collector();
    let recoveryRan = false;
    const h = TestHarness.create({
      sinks: [sink],
      onFlowError: () => {
        recoveryRan = true;
        return send("recovered");
      },
    });
    h.onSend(() => {
      throw new Error("Forbidden: bot was blocked by the user");
    });
    h.register("doomed", [send("hi"), send("never")]);
    await h.initiateFlow("doomed");

    expect(events[0]!.outcome).toBe("dead-chat");
    expect(recoveryRan).toBe(false);
    expect(await h.storage.listFlowStates({ botId: h.botId })).toHaveLength(0);
  });
});

describe("sinks", () => {
  test("jsonSink writes one parseable JSON line per event", async () => {
    const lines: string[] = [];
    const h = TestHarness.create({ sinks: [jsonSink((l) => void lines.push(l))] });
    h.register("hello", [send("hi")]);
    await h.initiateFlow("hello");

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as FlowEvent;
    expect(parsed.flow).toBe("hello");
    expect(parsed.outcome).toBe("completed");
  });

  test("evlogSink emits without throwing (smoke)", async () => {
    const h = TestHarness.create({ sinks: [evlogSink({ service: "test-bot" })] });
    h.register("hello", [send("hi")]);
    await h.initiateFlow("hello");
  });

  test("a failing sink never breaks the flow", async () => {
    const h = TestHarness.create({
      sinks: [
        {
          handle: () => {
            throw new Error("sink exploded");
          },
        },
      ],
    });
    h.register("hello", [send("hi")]);
    await h.initiateFlow("hello");
    expect(h.sentTexts()).toEqual(["hi"]);
  });
});

describe("DebugChatSink", () => {
  function makeEvent(over: Partial<FlowEvent> = {}): FlowEvent {
    return {
      ts: 1_000,
      level: "info",
      botId: 42,
      chatId: 7,
      flow: "f",
      trigger: "initiate",
      path: [],
      actions: [{ ts: 1_000, kind: "send", text: "hello user" }],
      outcome: "completed",
      durationMs: 5,
      apiCalls: 1,
      notify: false,
      ...over,
    };
  }

  function makeSink(opts?: { notifyChatId?: number; tags?: string[] }) {
    const sends: { chatId: number; text: string }[] = [];
    const forwards: { to: number; from: number; messageId: number }[] = [];
    const documents: { chatId: number; content: unknown }[] = [];
    let nextId = 1;
    const sink = new DebugChatSink({
      chatId: -999,
      ...opts,
      api: {
        sendMessage: async (chatId, text) => {
          sends.push({ chatId, text });
          return { message_id: nextId++ };
        },
        forwardMessage: async (to, from, messageId) => {
          forwards.push({ to, from, messageId });
          return { message_id: nextId++ };
        },
        sendDocument: async (chatId, content) => {
          documents.push({ chatId, content });
          return { message_id: nextId++ };
        },
      },
    });
    return { sink, sends, forwards, documents };
  }

  test("batches events into per-chat digests posted to the debug chat", async () => {
    const { sink, sends } = makeSink();
    sink.handle(makeEvent({ chatId: 7 }));
    sink.handle(
      makeEvent({ chatId: 7, actions: [{ ts: 2_000, kind: "reply", text: "user said hi" }] }),
    );
    sink.handle(makeEvent({ chatId: 8 }));
    await sink.flush();

    expect(sends).toHaveLength(2); // one digest per origin chat
    expect(sends[0]!.chatId).toBe(-999);
    expect(sends[0]!.text).toContain("Chat 7");
    expect(sends[0]!.text).toContain("hello user");
    expect(sends[0]!.text).toContain("user said hi");
    expect(sends[1]!.text).toContain("Chat 8");
  });

  test("digests never exceed 4096 characters", async () => {
    const { sink, sends } = makeSink();
    for (let i = 0; i < 100; i++) {
      sink.handle(
        makeEvent({ actions: [{ ts: i, kind: "send", text: `line ${i} ${"x".repeat(100)}` }] }),
      );
    }
    await sink.flush();
    expect(sends.length).toBeGreaterThan(1);
    for (const s of sends) expect(s.text.length).toBeLessThanOrEqual(4096);
  });

  test("a single oversized entry is truncated and shipped as a document", async () => {
    const { sink, sends, documents } = makeSink();
    sink.handle(makeEvent({ actions: [{ ts: 1, kind: "send", text: "y".repeat(6000) }] }));
    await sink.flush();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text.length).toBeLessThanOrEqual(4096);
    expect(documents).toHaveLength(1);
  });

  test("notify events forward the digest to the notify chat with tags in the line", async () => {
    const { sink, sends, forwards } = makeSink({ notifyChatId: -111, tags: ["@oncall"] });
    sink.handle(
      makeEvent({
        notify: true,
        actions: [{ ts: 1, kind: "debug", text: "alert!", notify: true }],
      }),
    );
    await sink.flush();
    expect(sends[0]!.text).toContain("@oncall");
    expect(forwards).toEqual([{ to: -111, from: -999, messageId: 1 }]);
  });

  test("forwardMessageId actions get the original message forwarded into the debug chat", async () => {
    const { sink, forwards } = makeSink();
    sink.handle(
      makeEvent({
        chatId: 7,
        actions: [{ ts: 1, kind: "debug", text: "see this", forwardMessageId: 555 }],
      }),
    );
    await sink.flush();
    expect(forwards).toEqual([{ to: -999, from: 7, messageId: 555 }]);
  });

  test("uniqueKey actions are posted once ever", async () => {
    const { sink, sends } = makeSink();
    sink.handle(makeEvent({ actions: [{ ts: 1, kind: "debug", text: "once", uniqueKey: "k1" }] }));
    sink.handle(makeEvent({ actions: [{ ts: 2, kind: "debug", text: "once", uniqueKey: "k1" }] }));
    await sink.flush();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text.match(/once/g)).toHaveLength(1);
  });
});
