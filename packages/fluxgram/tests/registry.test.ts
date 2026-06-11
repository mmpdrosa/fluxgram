import { describe, expect, test } from "bun:test";
import { FlowRegistry, structuralHash, walkPath } from "../src/engine/registry";
import { branch, noop, send, set, steps } from "../src/steps";

describe("FlowRegistry", () => {
  test("registers and retrieves a flow by name", () => {
    const reg = new FlowRegistry();
    const def = reg.register("onboarding", [send("hi")]);
    expect(def.name).toBe("onboarding");
    expect(reg.get("onboarding")).toBe(def);
  });

  test("rejects duplicate flow names", () => {
    const reg = new FlowRegistry();
    reg.register("a", [noop()]);
    expect(() => reg.register("a", [noop()])).toThrow(/already registered/);
  });

  test("defaults version to 1 and accepts explicit versions", () => {
    const reg = new FlowRegistry();
    expect(reg.register("a", [noop()]).version).toBe(1);
    expect(reg.register("b", [noop()], { version: 3 }).version).toBe(3);
  });

  test("normalizes arrays to steps nodes and functions to dynamic nodes", () => {
    const reg = new FlowRegistry();
    const fn = () => send("dyn");
    const def = reg.register("a", [send("x"), [send("y"), fn]]);
    expect(def.root.kind).toBe("steps");
    const nested = walkPath(def.root, [1]);
    expect(nested?.kind).toBe("steps");
    const dyn = walkPath(def.root, [1, 1]);
    expect(dyn?.kind).toBe("dynamic");
  });
});

describe("walkPath", () => {
  const tree = steps([
    send("a"), // [0]
    steps([send("b"), send("c")]), // [1] -> [1,0], [1,1]
    branch(() => true, send("t"), send("f")), // [2] -> [2,0] true, [2,1] false
  ]);

  test("resolves the root with an empty path", () => {
    expect(walkPath(tree, [])).toBe(tree);
  });

  test("resolves nested steps positions", () => {
    const node = walkPath(tree, [1, 1]);
    expect(node).toMatchObject({ kind: "send", text: "c" });
  });

  test("resolves branch arms (0 = true arm, 1 = false arm)", () => {
    expect(walkPath(tree, [2, 0])).toMatchObject({ kind: "send", text: "t" });
    expect(walkPath(tree, [2, 1])).toMatchObject({ kind: "send", text: "f" });
  });

  test("returns null for out-of-bounds paths", () => {
    expect(walkPath(tree, [9])).toBeNull();
    expect(walkPath(tree, [0, 0])).toBeNull(); // send has no children
  });
});

describe("structuralHash", () => {
  test("identical shapes hash identically", () => {
    const a = steps([send("hello"), set("k", 1)]);
    const b = steps([send("hello"), set("k", 1)]);
    expect(structuralHash(a)).toBe(structuralHash(b));
  });

  test("text/copy changes do not change the hash", () => {
    const a = steps([send("hello")]);
    const b = steps([send("goodbye, completely different text")]);
    expect(structuralHash(a)).toBe(structuralHash(b));
  });

  test("shape changes change the hash", () => {
    const a = steps([send("x")]);
    const added = steps([send("x"), send("x")]);
    const swapped = steps([noop()]);
    expect(structuralHash(a)).not.toBe(structuralHash(added));
    expect(structuralHash(a)).not.toBe(structuralHash(swapped));
  });

  test("branch arm shapes participate in the hash", () => {
    const a = branch(() => true, send("t"), send("f"));
    const b = branch(() => true, send("t"), steps([send("f"), noop()]));
    expect(structuralHash(a)).not.toBe(structuralHash(b));
  });
});
