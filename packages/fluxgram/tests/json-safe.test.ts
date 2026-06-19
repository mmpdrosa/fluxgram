import { describe, expect, test } from "bun:test";
import { TestHarness } from "../testing/harness";
import { assertJsonSafe } from "../src/util/jsonsafe";
import { set } from "../src/steps";

describe("assertJsonSafe", () => {
  test("accepts JSON-compatible values", () => {
    expect(() =>
      assertJsonSafe({ a: 1, b: "x", c: [1, 2, { d: true }], e: null }, "store"),
    ).not.toThrow();
  });

  test("rejects Date, Map, functions, bigint, and non-finite numbers", () => {
    expect(() => assertJsonSafe({ when: new Date() }, "store")).toThrow(/JSON/i);
    expect(() => assertJsonSafe({ m: new Map() }, "store")).toThrow(/JSON/i);
    expect(() => assertJsonSafe({ f: () => 1 }, "store")).toThrow(/JSON/i);
    expect(() => assertJsonSafe({ n: 10n }, "store")).toThrow(/JSON/i);
    expect(() => assertJsonSafe({ bad: Number.NaN }, "store")).toThrow(/JSON/i);
  });

  test("error names the offending path", () => {
    expect(() => assertJsonSafe({ a: { b: [new Date()] } }, "store")).toThrow(/store\.a\.b\[0\]/);
  });
});

describe("engine store JSON validation", () => {
  test("storing a non-JSON value surfaces a clear error (dev default on)", async () => {
    const errors: unknown[] = [];
    const h = TestHarness.create({ onFlowError: (e) => void errors.push(e.error) });
    h.register("f", [set("when", new Date())]);
    await h.initiateFlow("f");
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/JSON/i);
  });

  test("validation can be disabled", async () => {
    const errors: unknown[] = [];
    const h = TestHarness.create({
      onFlowError: (e) => void errors.push(e.error),
      validateStoreJson: false,
    });
    h.register("f", [set("when", new Date())]);
    await h.initiateFlow("f");
    expect(errors).toHaveLength(0);
  });
});
