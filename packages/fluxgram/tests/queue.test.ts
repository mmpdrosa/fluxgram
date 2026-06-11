import { describe, expect, test } from "bun:test";
import { ChatQueue } from "../src/engine/queue";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("ChatQueue", () => {
  test("runs jobs for the same chat strictly FIFO, one at a time", async () => {
    const q = new ChatQueue();
    const order: string[] = [];
    void q.run(1, async () => {
      await sleep(20);
      order.push("a");
    });
    void q.run(1, async () => {
      order.push("b");
    });
    const last = q.run(1, async () => {
      order.push("c");
    });
    await last;
    expect(order).toEqual(["a", "b", "c"]);
  });

  test("different chats run concurrently", async () => {
    const q = new ChatQueue();
    let slowStarted = false;
    let fastDone = false;
    const slow = q.run(1, async () => {
      slowStarted = true;
      await sleep(30);
    });
    await tick();
    await q.run(2, async () => {
      fastDone = true;
    });
    expect(slowStarted).toBe(true);
    expect(fastDone).toBe(true); // chat 2 finished while chat 1 was still busy
    await slow;
  });

  test("a throwing job does not break the chat queue; next job still runs", async () => {
    const q = new ChatQueue();
    const ran: string[] = [];
    const failed = q.run(1, async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    await q.run(1, async () => {
      ran.push("after");
    });
    expect(ran).toEqual(["after"]);
  });

  test("rejects new jobs beyond maxQueuedPerChat", async () => {
    const q = new ChatQueue({ maxQueuedPerChat: 1 });
    void q.run(1, () => sleep(30)); // running
    void q.run(1, async () => {}); // queued (1 = at cap)
    await expect(q.run(1, async () => {})).rejects.toThrow(/queue.*full/i);
  });

  test("onIdle waits for active and queued jobs", async () => {
    const q = new ChatQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];

    const first = q.run(1, async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    const second = q.run(1, () => {
      order.push("second");
    });

    let idle = false;
    const idlePromise = q.onIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);

    release();
    await Promise.all([first, second, idlePromise]);
    expect(idle).toBe(true);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  test("reports active size for introspection", async () => {
    const q = new ChatQueue();
    expect(q.size(1)).toBe(0);
    const p = q.run(1, () => sleep(20));
    void q.run(1, async () => {});
    expect(q.size(1)).toBe(2);
    await p;
  });
});
