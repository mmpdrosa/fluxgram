import assert from "node:assert/strict";

const { MemoryStorage, send, prompt, Fluxgram } = await import("../dist/src/index.js");
const { RedisStorage } = await import("../dist/src/storage/redis.js");
const { PostgresStorage } = await import("../dist/src/storage/postgres.js");

assert.equal(typeof Fluxgram, "function");
assert.equal(typeof send, "function");
assert.equal(typeof prompt.text, "function");

const doc = {
  id: "node-smoke-memory",
  botId: 1,
  rev: 0,
  flowName: "smoke",
  version: 1,
  treeHash: "hash",
  chatId: 10,
  status: "running",
  path: [0],
  frames: [],
  store: { runtime: "node" },
  waiting: null,
  savedCC: {},
  meta: { startedAt: 1, updatedAt: 1 },
};

const memory = new MemoryStorage();
await memory.putFlowState(doc);
assert.deepEqual((await memory.getFlowState(doc.id)).store, { runtime: "node" });

if (process.env.REDIS_URL) {
  const redis = await RedisStorage.connect(process.env.REDIS_URL, {
    prefix: `fxnodesmoke_${Date.now()}`,
  });
  try {
    assert.equal(await redis.kvSetIfAbsent("once", "first"), true);
    assert.equal(await redis.kvSetIfAbsent("once", "second"), false);
    assert.equal(await redis.kvGet("once"), "first");
  } finally {
    await redis.close();
  }
}

if (process.env.POSTGRES_URL) {
  const postgres = await PostgresStorage.connect(process.env.POSTGRES_URL, {
    tablePrefix: `fxnodesmoke_${Date.now()}`,
  });
  try {
    await postgres.kvSet("json", { ok: true });
    assert.deepEqual(await postgres.kvGet("json"), { ok: true });
    await postgres.putFlowState({ ...doc, id: "node-smoke-postgres" });
    assert.equal((await postgres.getFlowState("node-smoke-postgres")).store.runtime, "node");
  } finally {
    await postgres.dropTables();
    await postgres.close();
  }
}

console.log("Node smoke passed");
