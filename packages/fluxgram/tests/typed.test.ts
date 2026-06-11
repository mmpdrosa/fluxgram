import { describe, expect, test } from "bun:test";
import { TestHarness } from "../testing/harness";
import { flowKit } from "../src/steps/typed";
import { send } from "../src/steps";

interface Store {
  name: string;
  count: number;
  tags: string[];
}

const k = flowKit<Store>();

describe("flowKit (typed store)", () => {
  test("typed factories produce working steps", async () => {
    const h = TestHarness.create();
    h.register("typed", [
      k.set("count", 2),
      k.prompt.text("Name?", { store: "name" }),
      k.branch(
        (ctx) => ctx.store["count"] === 2,
        k.step((ctx) => send(`hi ${ctx.store["name"]} x${ctx.store["count"]}`)),
        send("nope"),
      ),
    ]);
    await h.initiateFlow("typed");
    await h.sendUser("john");
    expect(h.sentTexts()).toContain("hi john x2");
  });

  test("store keys and value types are enforced at compile time", () => {
    // @ts-expect-error wrong value type for key
    k.set("count", "two");
    // @ts-expect-error unknown key
    k.set("missing", 1);
    // @ts-expect-error count is not a string key
    k.prompt.text("Q?", { store: "count" });
    // @ts-expect-error name is not an array key
    k.prompt.multiSelect("Pick", { store: "name", choices: ["a"] });
    // valid usages compile:
    k.prompt.multiSelect("Pick", { store: "tags", choices: ["a"] });
    k.ret.fromStore("name");
    // @ts-expect-error unknown key in ret.fromStore
    k.ret.fromStore("nope");
    expect(true).toBe(true);
  });
});
