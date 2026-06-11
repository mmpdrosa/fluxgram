import { describe, expect, test } from "bun:test";
import { MemoryStorage } from "../src/storage/memory";
import type { FlowStateDoc } from "../src/engine/state";

function doc(over: Partial<FlowStateDoc> = {}): FlowStateDoc {
  return {
    id: over.id ?? "fs1",
    botId: 42,
    rev: 0,
    flowName: "f",
    version: 1,
    treeHash: "abc",
    chatId: 100,
    status: "running",
    path: [0],
    frames: [],
    store: {},
    waiting: null,
    savedCC: {},
    meta: { startedAt: 1, updatedAt: 1 },
    ...over,
  };
}

describe("MemoryStorage flow states", () => {
  test("put then get round-trips a document", async () => {
    const s = new MemoryStorage();
    await s.putFlowState(doc({ id: "x", store: { a: 1 } }));
    const got = await s.getFlowState("x");
    expect(got?.store).toEqual({ a: 1 });
  });

  test("get returns a copy — mutating the result does not corrupt storage", async () => {
    const s = new MemoryStorage();
    await s.putFlowState(doc({ id: "x", store: { a: 1 } }));
    const got = await s.getFlowState("x");
    got!.store["a"] = 999;
    expect((await s.getFlowState("x"))?.store["a"]).toBe(1);
  });

  test("CAS: putFlowState with matching expectedRev succeeds and bumps rev", async () => {
    const s = new MemoryStorage();
    await s.putFlowState(doc({ id: "x" }));
    const got = (await s.getFlowState("x"))!;
    expect(await s.putFlowState({ ...got, status: "waiting" }, got.rev)).toBe(true);
    expect((await s.getFlowState("x"))?.rev).toBe(got.rev + 1);
  });

  test("CAS: putFlowState with stale expectedRev fails and leaves doc untouched", async () => {
    const s = new MemoryStorage();
    await s.putFlowState(doc({ id: "x" }));
    const got = (await s.getFlowState("x"))!;
    await s.putFlowState({ ...got, status: "waiting" }, got.rev); // winner
    expect(await s.putFlowState({ ...got, status: "done" }, got.rev)).toBe(false);
    expect((await s.getFlowState("x"))?.status).toBe("waiting");
  });

  test("deleteFlowStates removes documents", async () => {
    const s = new MemoryStorage();
    await s.putFlowState(doc({ id: "x" }));
    await s.deleteFlowStates(["x"]);
    expect(await s.getFlowState("x")).toBeNull();
  });

  test("listFlowStates filters by botId, status, chatId and wakeBefore", async () => {
    const s = new MemoryStorage();
    await s.putFlowState(doc({ id: "a", status: "waiting", chatId: 1 }));
    await s.putFlowState(doc({ id: "b", status: "running", chatId: 1 }));
    await s.putFlowState(doc({ id: "c", status: "timer", chatId: 2, wakeAt: 50 }));
    await s.putFlowState(doc({ id: "d", status: "timer", chatId: 2, wakeAt: 500 }));
    await s.putFlowState(doc({ id: "e", botId: 7, status: "waiting", chatId: 1 }));

    const waiting = await s.listFlowStates({ botId: 42, status: "waiting" });
    expect(waiting.map((d) => d.id)).toEqual(["a"]);

    const chat1 = await s.listFlowStates({ botId: 42, chatId: 1 });
    expect(chat1.map((d) => d.id).sort()).toEqual(["a", "b"]);

    const due = await s.listFlowStates({ botId: 42, status: "timer", wakeBefore: 100 });
    expect(due.map((d) => d.id)).toEqual(["c"]);
  });
});

describe("MemoryStorage waiters", () => {
  test("claimWaiter returns the flowStateId exactly once (atomic get-and-delete)", async () => {
    const s = new MemoryStorage();
    await s.putWaiter("chat:100", "fs1");
    expect(await s.claimWaiter("chat:100")).toBe("fs1");
    expect(await s.claimWaiter("chat:100")).toBeNull();
  });

  test("deleteWaiters clears keys", async () => {
    const s = new MemoryStorage();
    await s.putWaiter("cb:tok", "fs1");
    await s.deleteWaiters(["cb:tok"]);
    expect(await s.claimWaiter("cb:tok")).toBeNull();
  });
});

describe("MemoryStorage kv", () => {
  test("kvSet / kvGet / kvDelete round-trip", async () => {
    const s = new MemoryStorage();
    await s.kvSet("k", { v: 1 });
    expect(await s.kvGet("k")).toEqual({ v: 1 });
    await s.kvDelete("k");
    expect(await s.kvGet("k")).toBeUndefined();
  });

  test("kvSetIfAbsent returns true once per key", async () => {
    const s = new MemoryStorage();
    expect(await s.kvSetIfAbsent("dedupe", 1)).toBe(true);
    expect(await s.kvSetIfAbsent("dedupe", 2)).toBe(false);
    expect(await s.kvGet("dedupe")).toBe(1);
  });
});
