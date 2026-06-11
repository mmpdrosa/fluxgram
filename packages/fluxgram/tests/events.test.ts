import { describe, expect, test } from "bun:test";
import { makeFluxgram, msgUpdate } from "../testing/grammy-kit";
import { InProcessEventBus } from "../src/events/inprocess";
import { FluxgramClient } from "../src/client";
import { send } from "../src/steps";
import { prompt } from "../src/steps/prompt";
import type { FlowContext } from "../src/engine/executor";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function makeWithEvents() {
  const bus = new InProcessEventBus();
  const made = await makeFluxgram({ events: bus });
  const client = new FluxgramClient({ events: bus });
  return { ...made, bus, client };
}

describe("events: in-process bus", () => {
  test("emit delivers payload to the registered handler", async () => {
    const { fx, client } = await makeWithEvents();
    const got: unknown[] = [];
    fx.onEvent("payout-done", (payload) => void got.push(payload));
    await client.emit("payout-done", { amount: 42 });
    expect(got).toEqual([{ amount: 42 }]);
  });

  test("uniqueKey delivers exactly once; publish reports the duplicate", async () => {
    const { fx, client } = await makeWithEvents();
    let runs = 0;
    fx.onEvent("once", () => void runs++);
    expect(await client.emit("once", {}, { uniqueKey: "k1" })).toBe(true);
    expect(await client.emit("once", {}, { uniqueKey: "k1" })).toBe(false);
    expect(await client.emit("once", {}, { uniqueKey: "k2" })).toBe(true);
    expect(runs).toBe(2);
  });

  test("oneAtATimeKey serializes handlers: never concurrent, all eventually run", async () => {
    const { fx, client } = await makeWithEvents();
    let concurrent = 0;
    let maxConcurrent = 0;
    let runs = 0;
    fx.onEvent("slow", async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(15);
      concurrent--;
      runs++;
    });
    await Promise.all([
      client.emit("slow", {}, { oneAtATimeKey: "job" }),
      client.emit("slow", {}, { oneAtATimeKey: "job" }),
      client.emit("slow", {}, { oneAtATimeKey: "job" }),
    ]);
    await sleep(80);
    expect(maxConcurrent).toBe(1);
    expect(runs).toBe(3);
  });

  test("unknown event names resolve silently without crashing", async () => {
    const { client } = await makeWithEvents();
    expect(await client.emit("nobody-listens", { x: 1 })).toBe(true);
  });

  test("a throwing handler does not break later events", async () => {
    const { fx, client } = await makeWithEvents();
    const got: string[] = [];
    fx.onEvent("boom", () => {
      throw new Error("handler exploded");
    });
    fx.onEvent("fine", () => void got.push("fine"));
    await client.emit("boom", {});
    await client.emit("fine", {});
    expect(got).toEqual(["fine"]);
  });
});

describe("events: cross-process helpers", () => {
  test("client.sendMessage sends through the bot process", async () => {
    const { client, sentTexts } = await makeWithEvents();
    await client.sendMessage(7, "hello from a cron job");
    expect(sentTexts()).toEqual(["hello from a cron job"]);
  });

  test("client.sendMessage with uniqueKey sends once", async () => {
    const { client, sentTexts } = await makeWithEvents();
    await client.sendMessage(7, "ping", { uniqueKey: "daily-ping" });
    await client.sendMessage(7, "ping", { uniqueKey: "daily-ping" });
    expect(sentTexts()).toEqual(["ping"]);
  });

  test("client.sendMessage with clearWaiters kills the waiting prompt first", async () => {
    const { bot, fx, client, sentTexts } = await makeWithEvents();
    fx.command("start", fx.flow("ask", [prompt.text("Q?", { store: "a" }), send("never")]));
    await bot.handleUpdate(msgUpdate(7, "/start"));
    await client.sendMessage(7, "interrupted!", { clearWaiters: true });
    expect(sentTexts()).toEqual(["Q?", "interrupted!"]);
    await bot.handleUpdate(msgUpdate(7, "stray"));
    expect(sentTexts()).toEqual(["Q?", "interrupted!"]); // prompt is dead
  });

  test("client.initiateFlow starts a registered flow with a seeded store", async () => {
    const { fx, client, sentTexts } = await makeWithEvents();
    fx.flow("notify", [(ctx: FlowContext) => send(`v=${ctx.store["v"]}`)]);
    await client.initiateFlow("notify", 7, { store: { v: 9 } });
    expect(sentTexts()).toEqual(["v=9"]);
  });

  test("event-scoped middleware can block an event-initiated flow", async () => {
    const { fx, client, sentTexts } = await makeWithEvents();
    fx.flow("notify", [send("should not run")]);
    fx.use((mw, _next) => void mw.block(), { scope: "initiate_flow" });
    await client.initiateFlow("notify", 7);
    expect(sentTexts()).toEqual([]);
  });
});

if (process.env["MONGO_URL"]) {
  const { MongoEventBus } = await import("../src/events/mongo");

  describe("events: mongo bus", () => {
    async function makeMongoBus() {
      const db = `fluxgram_events_${Math.random().toString(36).slice(2)}`;
      const bus = await MongoEventBus.connect(process.env["MONGO_URL"]!, {
        botId: 42,
        db,
        pollIntervalMs: 25,
      });
      return bus;
    }

    test("publish/subscribe round-trip with uniqueKey dedupe", async () => {
      const bus = await makeMongoBus();
      try {
        const got: unknown[] = [];
        bus.subscribe(async (e) => void got.push(`${e.name}:${JSON.stringify(e.payload)}`));
        expect(await bus.publish({ name: "hi", payload: { n: 1 }, uniqueKey: "u1" })).toBe(true);
        expect(await bus.publish({ name: "hi", payload: { n: 2 }, uniqueKey: "u1" })).toBe(false);
        await sleep(150);
        expect(got).toEqual(['hi:{"n":1}']);
      } finally {
        await bus.destroy();
      }
    });

    test("cleanup deletes old resolved events but keeps uniqueKey events for dedup", async () => {
      const db = `fluxgram_events_${Math.random().toString(36).slice(2)}`;
      const bus = await MongoEventBus.connect(process.env["MONGO_URL"]!, {
        botId: 42,
        db,
        pollIntervalMs: 25,
        resolvedRetentionMs: 60_000,
      });
      try {
        const old = {
          botId: 42,
          payload: {},
          oneAtATimeKey: null,
          invoked: true,
          invokedTs: Date.now() - 100_000,
          resolved: true,
          resolvedTs: Date.now() - 90_000,
        };
        await bus.collection.insertMany([
          { ...old, name: "plain", uniqueKey: null },
          { ...old, name: "keyed", uniqueKey: "k1" },
          // recent resolved event stays
          { ...old, name: "fresh", uniqueKey: null, resolvedTs: Date.now() },
        ] as never[]);

        await bus.cleanup();

        const names = (await bus.collection.find({ botId: 42 }).toArray()).map((d) => d.name);
        expect(names.sort()).toEqual(["fresh", "keyed"]);
        // dedup against the kept uniqueKey event still works
        expect(await bus.publish({ name: "keyed", payload: {}, uniqueKey: "k1" })).toBe(false);
      } finally {
        await bus.destroy();
      }
    });

    test("crash recovery: invoked-but-unresolved events from before startup are re-delivered", async () => {
      const bus = await makeMongoBus();
      try {
        // simulate a previous process that died mid-handling
        await bus.collection.insertOne({
          botId: 42,
          name: "orphan",
          payload: { rescued: true },
          uniqueKey: null,
          oneAtATimeKey: null,
          invoked: true,
          invokedTs: Date.now() - 60_000,
          resolved: false,
          resolvedTs: null,
        } as never);
        const got: unknown[] = [];
        bus.subscribe(async (e) => void got.push(e.payload));
        await sleep(150);
        expect(got).toEqual([{ rescued: true }]);
      } finally {
        await bus.destroy();
      }
    });
  });
}

if (process.env["REDIS_URL"]) {
  const { RedisEventBus } = await import("../src/events/redis");

  describe("events: redis bus", () => {
    async function makeRedisBus() {
      return RedisEventBus.connect(process.env["REDIS_URL"]!, {
        botId: 42,
        prefix: `fxevt_${Math.random().toString(36).slice(2)}`,
        pollIntervalMs: 25,
      });
    }

    test("publish/subscribe round-trip with uniqueKey dedupe", async () => {
      const bus = await makeRedisBus();
      try {
        const got: string[] = [];
        bus.subscribe(async (e) => void got.push(`${e.name}:${JSON.stringify(e.payload)}`));
        expect(await bus.publish({ name: "hi", payload: { n: 1 }, uniqueKey: "u1" })).toBe(true);
        expect(await bus.publish({ name: "hi", payload: { n: 2 }, uniqueKey: "u1" })).toBe(false);
        await sleep(200);
        expect(got).toEqual(['hi:{"n":1}']);
      } finally {
        await bus.destroy();
      }
    });

    test("crash recovery: events stuck in processing are requeued on subscribe", async () => {
      const prefix = `fxevt_${Math.random().toString(36).slice(2)}`;
      const bus = await RedisEventBus.connect(process.env["REDIS_URL"]!, {
        botId: 42,
        prefix,
        pollIntervalMs: 25,
      });
      try {
        // simulate a previous process that died mid-handling
        const { RedisClient } = await import("bun");
        const raw = new RedisClient(process.env["REDIS_URL"]!);
        await raw.connect();
        await raw.send("RPUSH", [
          `${prefix}:events:42:processing`,
          JSON.stringify({ id: "orphan", name: "orphan", payload: { rescued: true } }),
        ]);
        raw.close();

        const got: unknown[] = [];
        bus.subscribe(async (e) => void got.push(e.payload));
        await sleep(200);
        expect(got).toEqual([{ rescued: true }]);
      } finally {
        await bus.destroy();
      }
    });
  });
}
