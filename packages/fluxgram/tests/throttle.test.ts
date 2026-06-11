import { describe, expect, test } from "bun:test";
import { createThrottle } from "../src/transformers/throttle";

type Call = { method: string; payload: Record<string, unknown> };

function makeThrottle(limits?: Parameters<typeof createThrottle>[0]) {
  let now = 1_000_000;
  const sleeps: number[] = [];
  const calls: Call[] = [];
  const transformer = createThrottle({
    now: () => now,
    sleepFn: async (ms) => {
      sleeps.push(ms);
      now += ms; // sleeping advances the fake clock
    },
    ...limits,
  });
  const invoke = async (method: string, payload: Record<string, unknown>) => {
    await transformer(
      async (m: string, p: Record<string, unknown>) => {
        calls.push({ method: m, payload: p });
        return { ok: true, result: {} };
      },
      method,
      payload,
    );
  };
  return { invoke, sleeps, calls, advance: (ms: number) => void (now += ms) };
}

describe("throttle transformer", () => {
  test("lets calls through under the limits without sleeping", async () => {
    const t = makeThrottle();
    for (let i = 0; i < 3; i++) await t.invoke("sendMessage", { chat_id: 1, text: "x" });
    expect(t.sleeps).toHaveLength(0);
    expect(t.calls).toHaveLength(3);
  });

  test("throttles per-chat sends beyond the burst limit", async () => {
    const t = makeThrottle({ perChat: [2, 10, 15, 20] });
    await t.invoke("sendMessage", { chat_id: 1, text: "a" });
    await t.invoke("sendMessage", { chat_id: 1, text: "b" });
    await t.invoke("sendMessage", { chat_id: 1, text: "c" }); // 3rd within 1s -> must wait
    expect(t.sleeps.length).toBeGreaterThan(0);
    expect(t.calls).toHaveLength(3); // still delivered, just delayed
  });

  test("different chats do not throttle each other at the per-chat level", async () => {
    const t = makeThrottle({ perChat: [1, 10, 15, 20] });
    await t.invoke("sendMessage", { chat_id: 1, text: "a" });
    await t.invoke("sendMessage", { chat_id: 2, text: "b" });
    expect(t.sleeps).toHaveLength(0);
  });

  test("global window throttles across chats", async () => {
    const t = makeThrottle({ global: [3, 100, 300, 500] });
    for (let i = 0; i < 4; i++) await t.invoke("sendMessage", { chat_id: i, text: "x" });
    expect(t.sleeps.length).toBeGreaterThan(0);
  });

  test("getUpdates is exempt", async () => {
    const t = makeThrottle({ global: [1, 1, 1, 1] });
    for (let i = 0; i < 5; i++) await t.invoke("getUpdates", {});
    expect(t.sleeps).toHaveLength(0);
  });

  test("windows expire: after time passes, calls flow freely again", async () => {
    const t = makeThrottle({ perChat: [2, 10, 15, 20] });
    await t.invoke("sendMessage", { chat_id: 1, text: "a" });
    await t.invoke("sendMessage", { chat_id: 1, text: "b" });
    t.advance(2000); // burst window cleared
    await t.invoke("sendMessage", { chat_id: 1, text: "c" });
    expect(t.sleeps).toHaveLength(0);
  });
});
