import { describe, expect, test } from "bun:test";
import { TestHarness } from "../testing/harness";
import { send, sleep, waitFor } from "../src/steps";
import { prompt } from "../src/steps/prompt";
import { humanDelay } from "../src/util/humandelay";

describe("version mismatch policies", () => {
  test("default 'restart': a reshaped flow restarts from the top, keeping the store", async () => {
    const h = TestHarness.create();
    h.register("onboard", [prompt.text("Q1?", { store: "a" }), send("done A")]);
    await h.initiateFlow("onboard", { store: { keep: "x" } });
    expect(h.sentTexts()).toEqual(["Q1?"]);

    // a deploy changed the flow's shape while the user was mid-conversation
    h.redefine("onboard", [send("v2 intro"), prompt.text("Q2?", { store: "b" })]);
    expect(await h.sendUser("hello")).toBe("handled");
    expect(h.sentTexts()).toEqual(["Q1?", "v2 intro", "Q2?"]);
    expect(await h.flowStore()).toMatchObject({ keep: "x" }); // store survives the restart

    await h.sendUser("answer"); // the new prompt is live
    expect(await h.flowStore()).toMatchObject({ b: "answer" });
  });

  test("'drop': the in-flight conversation is discarded silently", async () => {
    const h = TestHarness.create({ versionMismatch: "drop" });
    h.register("onboard", [prompt.text("Q1?", { store: "a" }), send("done A")]);
    await h.initiateFlow("onboard");
    h.redefine("onboard", [send("v2"), prompt.text("Q2?", { store: "b" })]);
    expect(await h.sendUser("hello")).toBe("handled");
    expect(h.sentTexts()).toEqual(["Q1?"]); // nothing new sent
    expect(await h.storage.listFlowStates({ botId: h.botId })).toHaveLength(0);
  });

  test("an explicit version bump triggers the policy even with an identical shape", async () => {
    const h = TestHarness.create();
    h.register("f", [prompt.text("Q?", { store: "a" }), send("after")], { version: 1 });
    await h.initiateFlow("f");
    h.redefine("f", [prompt.text("Q?", { store: "a" }), send("after")], { version: 2 });
    await h.sendUser("x");
    expect(h.sentTexts()).toEqual(["Q?", "Q?"]); // restarted from the top
  });
});

describe("durable sleep", () => {
  test("a long sleep suspends as a timer; sweep after wakeAt resumes — across a restart", async () => {
    const h = TestHarness.create();
    h.register("nap", [send("before"), sleep(60), send("after")]);
    await h.initiateFlow("nap");
    expect(h.sentTexts()).toEqual(["before"]);

    const docs = await h.storage.listFlowStates({ botId: h.botId, status: "timer" });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.wakeAt).toBe(h.clock.now() + 60_000);

    await h.sweep(); // too early — nothing happens
    expect(h.sentTexts()).toEqual(["before"]);

    await h.restart();
    h.clock.advance(61_000);
    await h.sweep();
    expect(h.sentTexts()).toEqual(["before", "after"]);
  });

  test("a short sleep just delays inline", async () => {
    const h = TestHarness.create();
    h.register("blink", [send("a"), sleep(0.01), send("b")]);
    await h.initiateFlow("blink");
    expect(h.sentTexts()).toEqual(["a", "b"]);
  });
});

describe("waitFor", () => {
  test("polls via durable timers until the check passes", async () => {
    let ready = false;
    const h = TestHarness.create();
    h.register("poll", [
      send("waiting"),
      waitFor(() => ready, { everySecs: 60, timeoutSecs: 600 }),
      send("it happened"),
    ]);
    await h.initiateFlow("poll");
    expect(h.sentTexts()).toEqual(["waiting"]);

    h.clock.advance(61_000);
    await h.sweep(); // check still false -> re-arms the timer
    expect(h.sentTexts()).toEqual(["waiting"]);

    ready = true;
    h.clock.advance(61_000);
    await h.sweep();
    expect(h.sentTexts()).toEqual(["waiting", "it happened"]);
  });

  test("runs onTimeout when the deadline passes, then continues", async () => {
    const h = TestHarness.create();
    h.register("poll", [
      waitFor(() => false, { everySecs: 60, timeoutSecs: 120, onTimeout: send("timed out") }),
      send("after"),
    ]);
    await h.initiateFlow("poll");
    h.clock.advance(61_000);
    await h.sweep(); // 61s in: not yet timed out, re-arms
    h.clock.advance(61_000);
    await h.sweep(); // 122s in: deadline passed
    expect(h.sentTexts()).toEqual(["timed out", "after"]);
  });
});

describe("crash recovery sweep", () => {
  test("a stale 'running' doc is resumed by re-running the step in flight (at-least-once)", async () => {
    let attempts = 0;
    const h = TestHarness.create({ onFlowError: () => undefined });
    h.register("flaky", [
      send("start"),
      () => {
        attempts++;
        if (attempts === 1) throw new Error("simulated crash");
      },
      send("end"),
    ]);
    await h.initiateFlow("flaky"); // dies at step [1], doc left status=running
    expect(h.sentTexts()).toEqual(["start"]);

    h.clock.advance(31_000); // past the running grace period
    await h.sweep();
    expect(attempts).toBe(2); // the in-flight step re-ran
    expect(h.sentTexts()).toEqual(["start", "end"]);
  });

  test("a waiting doc whose prompt was never sent (crash mid-suspend) gets its prompt re-sent", async () => {
    const h = TestHarness.create();
    h.register("ask", [prompt.text("Q?", { store: "a" }), send("got it")]);
    await h.initiateFlow("ask");

    // simulate a crash between waiter registration and the sendMessage
    const doc = (await h.storage.listFlowStates({ botId: h.botId, status: "waiting" }))[0]!;
    delete doc.waiting!.promptMessageId;
    await h.storage.putFlowState(doc);

    h.clock.advance(31_000);
    await h.sweep();
    expect(h.sentTexts()).toEqual(["Q?", "Q?"]); // prompt re-sent
    await h.sendUser("hi"); // and it works
    await h.expectMessage("got it");
  });
});

describe("humanDelay", () => {
  test("clamps into [0.1, 2*avg] and is deterministic under a fixed rng", () => {
    const low = humanDelay(10, () => 0.0001); // extreme gaussian tail -> clamped low
    const high = humanDelay(10, () => 0.9999);
    expect(low).toBeGreaterThanOrEqual(0.1);
    expect(high).toBeLessThanOrEqual(20);
    expect(humanDelay(10, () => 0.5)).toBeCloseTo(humanDelay(10, () => 0.5));
  });
});

describe("done-doc GC", () => {
  test("sweep deletes completed docs after the retention window", async () => {
    const { TestHarness } = await import("../testing/harness");
    const { send } = await import("../src/steps");
    const h = TestHarness.create();
    h.register("quick", [send("hi")]);
    await h.initiateFlow("quick");

    // still there within retention (default 1h)
    await h.sweep();
    expect(await h.storage.listFlowStates({ botId: h.botId, status: "done" })).toHaveLength(1);

    h.clock.advance(3_600_001);
    await h.sweep();
    expect(await h.storage.listFlowStates({ botId: h.botId, status: "done" })).toHaveLength(0);
  });
});

describe("optimistic concurrency (rev CAS)", () => {
  test("a concurrent out-of-band write makes the engine's next persist fail loudly", async () => {
    const { TestHarness } = await import("../testing/harness");
    const { send } = await import("../src/steps");
    const { prompt } = await import("../src/steps/prompt");
    const h = TestHarness.create();
    h.register("conflict", [
      prompt.text("Q?", { store: "a" }),
      async () => {
        // simulate another process writing this doc while we hold it in memory
        const [doc] = await h.storage.listFlowStates({ botId: h.botId });
        await h.storage.putFlowState({ ...doc!, rev: doc!.rev + 1 });
      },
      send("after"),
    ]);
    await h.initiateFlow("conflict");

    await expect(h.sendUser("answer")).rejects.toThrow(/modified concurrently/);
    expect(h.sentTexts()).not.toContain("after");
  });

  test("normal flows persist with monotonically increasing revs", async () => {
    const { TestHarness } = await import("../testing/harness");
    const { send } = await import("../src/steps");
    const h = TestHarness.create();
    h.register("plain", [send("one"), send("two")]);
    await h.initiateFlow("plain");
    const [doc] = await h.storage.listFlowStates({ botId: h.botId });
    expect(doc!.rev).toBeGreaterThan(1);
  });
});
