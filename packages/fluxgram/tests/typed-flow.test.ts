import { describe, expect, test } from "bun:test";
import { TestHarness } from "../testing/harness";
import { makeFluxgram, msgUpdate } from "../testing/grammy-kit";
import { defineFlow } from "../src/steps/typed";
import { callFlow, ret, send } from "../src/steps";
import type { FlowContext } from "../src/engine/executor";
import type { Fluxgram } from "../src/fluxgram";

interface Store {
  name: string;
  greeting: string;
  r: number;
}

describe("defineFlow", () => {
  test("builder form receives a typed kit and produces a working flow", async () => {
    const spec = defineFlow<Store>("greet", (k) => [
      k.set("greeting", "hi"),
      k.step((ctx) => send(`${ctx.store.greeting}!`)),
    ]);
    const h = TestHarness.create();
    h.register(spec.name, spec.root);
    await h.initiateFlow(spec.name);
    expect(h.sentTexts()).toEqual(["hi!"]);
  });

  test("array form works without a builder", async () => {
    const spec = defineFlow("plain", [send("yo")]);
    const h = TestHarness.create();
    h.register(spec.name, spec.root);
    await h.initiateFlow(spec.name);
    expect(h.sentTexts()).toEqual(["yo"]);
  });
});

describe("callFlow with a flow reference", () => {
  test("callFlow accepts a defineFlow spec and runs its root as an isolated subflow", async () => {
    const double = defineFlow<{ n: number }>("double", (k) => [
      k.step((ctx) => ret((ctx.store.n ?? 0) * 2)),
    ]);
    const h = TestHarness.create();
    h.register("main", [
      callFlow(double, { args: { n: 21 }, storeResult: "r" }),
      (ctx: FlowContext) => send(`r=${ctx.store["r"]}`),
    ]);
    await h.initiateFlow("main");
    expect(h.sentTexts()).toEqual(["r=42"]);
  });
});

describe("typed Fluxgram registration (runtime)", () => {
  test("fx.flow(spec) registers and the typed def starts the flow", async () => {
    const { bot, fx, sentTexts } = await makeFluxgram();
    const hello = fx.flow(defineFlow<Store>("hello", (k) => [k.step(() => send("typed welcome"))]));
    fx.command("start", hello);
    await bot.handleUpdate(msgUpdate(7, "/start"));
    expect(sentTexts()).toEqual(["typed welcome"]);
  });

  test("fx.initiateFlow seeds a typed store", async () => {
    const { fx, sentTexts } = await makeFluxgram();
    const echo = fx.flow(
      defineFlow<Store>("echo", (k) => [k.step((ctx) => send(`hi ${ctx.store.name}`))]),
    );
    await fx.initiateFlow(echo, 7, { store: { name: "ada", greeting: "", r: 0 } });
    expect(sentTexts()).toEqual(["hi ada"]);
  });
});

// Compile-time only: never invoked, exists so `tsc` checks the typed wiring.
async function _typeChecks(fx: Fluxgram): Promise<void> {
  const def = fx.flow(defineFlow<Store>("tc", (k) => [k.step(() => send("x"))]));
  // a correctly-shaped seed compiles
  await fx.initiateFlow(def, 1, { store: { name: "a", greeting: "b", r: 1 } });
  // @ts-expect-error wrong value type in the seeded store
  await fx.initiateFlow(def, 1, { store: { name: 1, greeting: "b", r: 1 } });
  // a registered FlowDef can still wire commands
  fx.command("start", def);
}
void _typeChecks;
