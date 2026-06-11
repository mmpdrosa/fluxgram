import { describe, expect, test } from "bun:test";
import { PostgresStorage, type PostgresQueryExecutor } from "../src/storage/postgres";

describe("PostgresStorage query executor", () => {
  test("runs storage operations through query(text, params)", async () => {
    const calls: { text: string; params: unknown[] }[] = [];
    const executor: PostgresQueryExecutor = {
      async query(text, params = []) {
        calls.push({ text, params });
        if (text.includes("SELECT value")) return [{ value: JSON.stringify({ ok: true }) }];
        return [];
      },
    };
    const storage = new PostgresStorage(executor, { tablePrefix: "fgtest" });

    await storage.kvSet("k", { ok: true });
    expect(calls[0]?.text).toContain("INSERT INTO fgtest_kv");
    expect(calls[0]?.params).toEqual(["k", JSON.stringify({ ok: true })]);

    expect(await storage.kvGet("k")).toEqual({ ok: true });
    expect(calls[1]?.text).toContain("SELECT value FROM fgtest_kv");
    expect(calls[1]?.params).toEqual(["k"]);
  });
});
