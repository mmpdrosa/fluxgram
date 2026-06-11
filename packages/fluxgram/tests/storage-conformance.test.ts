import { conformance } from "../testing/conformance";
import { MemoryStorage } from "../src/storage/memory";
import { SqliteStorage } from "../src/storage/sqlite";

conformance("memory", async () => ({ adapter: new MemoryStorage() }));

conformance("bun-sqlite (in-memory db)", async () => {
  const adapter = new SqliteStorage(":memory:");
  return { adapter, cleanup: async () => adapter.close() };
});

// Redis conformance runs only when a server is provided:
//   REDIS_URL=redis://localhost:6379 bun test tests/storage-conformance.test.ts
if (process.env["REDIS_URL"]) {
  const { RedisStorage } = await import("../src/storage/redis");
  // both client drivers: Bun's built-in and the node-redis package (Node's path)
  for (const driver of ["bun", "node-redis"] as const) {
    conformance(`redis (${driver} driver)`, async () => {
      const adapter = await RedisStorage.connect(process.env["REDIS_URL"]!, {
        prefix: `fxtest_${Math.random().toString(36).slice(2)}`,
        driver,
      });
      return { adapter, cleanup: async () => adapter.close() };
    });
  }
}

// Postgres conformance runs only when a server is provided:
//   POSTGRES_URL=postgres://user:pass@localhost:5432/db bun test tests/storage-conformance.test.ts
if (process.env["POSTGRES_URL"]) {
  const { PostgresStorage } = await import("../src/storage/postgres");
  // both client drivers: Bun's built-in SQL and the pg package (Node's path)
  for (const driver of ["bun", "pg"] as const) {
    conformance(`postgres (${driver} driver)`, async () => {
      const adapter = await PostgresStorage.connect(process.env["POSTGRES_URL"]!, {
        tablePrefix: `fxtest_${Math.random().toString(36).slice(2)}`,
        driver,
      });
      return {
        adapter,
        cleanup: async () => {
          await adapter.dropTables();
          await adapter.close();
        },
      };
    });
  }
}

// Mongo conformance runs only when a server is provided:
//   MONGO_URL=mongodb://localhost:27017 bun test tests/storage-conformance.test.ts
if (process.env["MONGO_URL"]) {
  const { MongoStorage } = await import("../src/storage/mongo");
  conformance("mongodb", async () => {
    const adapter = await MongoStorage.connect(process.env["MONGO_URL"]!, {
      db: `fluxgram_conformance_${Math.random().toString(36).slice(2)}`,
    });
    return {
      adapter,
      cleanup: async () => {
        await adapter.dropDatabase();
        await adapter.close();
      },
    };
  });
}
