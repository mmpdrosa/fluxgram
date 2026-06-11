import { describe, expect, test } from "bun:test";
import type { StorageAdapter } from "../src/storage/adapter";
import type { FlowStateDoc } from "../src/engine/state";

export function makeDoc(over: Partial<FlowStateDoc> = {}): FlowStateDoc {
  return {
    id: over.id ?? `fs-${Math.random().toString(36).slice(2)}`,
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

export interface AdapterFactory {
  (): Promise<{ adapter: StorageAdapter; cleanup?: () => Promise<void> }>;
}

/**
 * Storage adapter conformance suite. Every adapter must pass it unchanged —
 * including the atomicity guarantees (claimWaiter, putFlowState CAS) that the
 * engine's race-safety is built on.
 */
export function conformance(name: string, factory: AdapterFactory): void {
  describe(`storage conformance: ${name}`, () => {
    async function withAdapter(fn: (s: StorageAdapter) => Promise<void>): Promise<void> {
      const { adapter, cleanup } = await factory();
      try {
        await fn(adapter);
      } finally {
        await cleanup?.();
      }
    }

    test("flow state round-trips as JSON, including nested structures", () =>
      withAdapter(async (s) => {
        const doc = makeDoc({
          id: "x",
          path: [1, 2, 0],
          frames: [{ returnPath: [1], store: { a: 1 }, storeResult: "r" }],
          store: { nested: { deep: [1, "two", null] } },
          waiting: { kind: "either", cbToken: "tok", promptMessageId: 7 },
          savedCC: { menu: { path: [0], frames: [] } },
          dynamicHashes: { "0": "h1" },
        });
        await s.putFlowState(doc);
        const got = await s.getFlowState("x");
        expect(got).toEqual(doc);
      }));

    test("getFlowState returns null for unknown ids", () =>
      withAdapter(async (s) => {
        expect(await s.getFlowState("missing")).toBeNull();
      }));

    test("plain put overwrites; CAS put succeeds once and bumps rev", () =>
      withAdapter(async (s) => {
        await s.putFlowState(makeDoc({ id: "x" }));
        const got = (await s.getFlowState("x"))!;
        expect(await s.putFlowState({ ...got, status: "waiting" }, got.rev)).toBe(true);
        const after = (await s.getFlowState("x"))!;
        expect(after.rev).toBe(got.rev + 1);
        expect(after.status).toBe("waiting");
      }));

    test("CAS with a stale rev fails and leaves the document untouched", () =>
      withAdapter(async (s) => {
        await s.putFlowState(makeDoc({ id: "x" }));
        const got = (await s.getFlowState("x"))!;
        await s.putFlowState({ ...got, status: "waiting" }, got.rev);
        expect(await s.putFlowState({ ...got, status: "done" }, got.rev)).toBe(false);
        expect((await s.getFlowState("x"))!.status).toBe("waiting");
      }));

    test("deleteFlowStates removes documents", () =>
      withAdapter(async (s) => {
        await s.putFlowState(makeDoc({ id: "x" }));
        await s.putFlowState(makeDoc({ id: "y" }));
        await s.deleteFlowStates(["x", "y"]);
        expect(await s.getFlowState("x")).toBeNull();
        expect(await s.getFlowState("y")).toBeNull();
      }));

    test("listFlowStates filters by botId, status, chatId, wakeBefore and updatedBefore", () =>
      withAdapter(async (s) => {
        await s.putFlowState(makeDoc({ id: "a", status: "waiting", chatId: 1 }));
        await s.putFlowState(
          makeDoc({ id: "b", status: "running", chatId: 1, meta: { startedAt: 1, updatedAt: 50 } }),
        );
        await s.putFlowState(makeDoc({ id: "c", status: "timer", chatId: 2, wakeAt: 50 }));
        await s.putFlowState(makeDoc({ id: "d", status: "timer", chatId: 2, wakeAt: 500 }));
        await s.putFlowState(makeDoc({ id: "e", botId: 7, status: "waiting", chatId: 1 }));

        expect((await s.listFlowStates({ botId: 42, status: "waiting" })).map((d) => d.id)).toEqual(
          ["a"],
        );
        expect((await s.listFlowStates({ botId: 42, chatId: 1 })).map((d) => d.id).sort()).toEqual([
          "a",
          "b",
        ]);
        expect(
          (await s.listFlowStates({ botId: 42, status: "timer", wakeBefore: 100 })).map(
            (d) => d.id,
          ),
        ).toEqual(["c"]);
        expect(
          (await s.listFlowStates({ botId: 42, status: "running", updatedBefore: 100 })).map(
            (d) => d.id,
          ),
        ).toEqual(["b"]);
      }));

    test("claimWaiter returns the id exactly once", () =>
      withAdapter(async (s) => {
        await s.putWaiter("chat:1", "fs1");
        expect(await s.claimWaiter("chat:1")).toBe("fs1");
        expect(await s.claimWaiter("chat:1")).toBeNull();
      }));

    test("claimWaiter is atomic: N concurrent claims yield exactly one winner", () =>
      withAdapter(async (s) => {
        await s.putWaiter("cb:tok", "fs1");
        const results = await Promise.all(
          Array.from({ length: 10 }, () => s.claimWaiter("cb:tok")),
        );
        expect(results.filter((r) => r === "fs1")).toHaveLength(1);
        expect(results.filter((r) => r === null)).toHaveLength(9);
      }));

    test("putWaiter overwrites an existing key", () =>
      withAdapter(async (s) => {
        await s.putWaiter("chat:1", "old");
        await s.putWaiter("chat:1", "new");
        expect(await s.claimWaiter("chat:1")).toBe("new");
      }));

    test("deleteWaiters clears keys silently (missing keys ok)", () =>
      withAdapter(async (s) => {
        await s.putWaiter("a", "1");
        await s.deleteWaiters(["a", "never-existed"]);
        expect(await s.claimWaiter("a")).toBeNull();
      }));

    test("kv round-trips JSON values; delete removes; setIfAbsent wins once", () =>
      withAdapter(async (s) => {
        await s.kvSet("k", { v: [1, 2, 3] });
        expect(await s.kvGet("k")).toEqual({ v: [1, 2, 3] });
        await s.kvDelete("k");
        expect(await s.kvGet("k")).toBeUndefined();
        expect(await s.kvSetIfAbsent("once", "first")).toBe(true);
        expect(await s.kvSetIfAbsent("once", "second")).toBe(false);
        expect(await s.kvGet("once")).toBe("first");
      }));
  });
}
