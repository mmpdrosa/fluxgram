import { createRequire } from "node:module";
import type { FlowStateDoc } from "../engine/state";
import type { FlowStateQuery, StorageAdapter } from "./adapter";

/**
 * SQLite adapter — the zero-infra single-process production option. Runs on
 * Bun (bun:sqlite) and Node 22.5+ (node:sqlite), picked at runtime.
 * Atomicity comes from single-statement SQL (DELETE..RETURNING, conditional UPDATE).
 */

/** the minimal surface both runtimes' sqlite drivers are adapted to */
interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, params: unknown[]): { changes: number };
  get(sql: string, params: unknown[]): unknown;
  all(sql: string, params: unknown[]): unknown[];
  close(): void;
}

const requireRuntime = createRequire(import.meta.url);

function openDatabase(filename: string): SqlDriver {
  if (process.versions.bun) {
    const { Database } = requireRuntime("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(filename);
    return {
      exec: (sql) => db.run(sql),
      run: (sql, params) => db.query(sql).run(...(params as never[])),
      get: (sql, params) => db.query(sql).get(...(params as never[])),
      all: (sql, params) => db.query(sql).all(...(params as never[])),
      close: () => db.close(),
    };
  }

  interface NodeStatement {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  interface NodeDatabase {
    exec(sql: string): void;
    prepare(sql: string): NodeStatement;
    close(): void;
  }
  const { DatabaseSync } = requireRuntime("node:sqlite") as {
    DatabaseSync: new (filename: string) => NodeDatabase;
  };
  const db = new DatabaseSync(filename);
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => {
      const result = db.prepare(sql).run(...params);
      return { changes: Number(result.changes) };
    },
    get: (sql, params) => db.prepare(sql).get(...params) ?? null,
    all: (sql, params) => db.prepare(sql).all(...params),
    close: () => db.close(),
  };
}

export class SqliteStorage implements StorageAdapter {
  private db: SqlDriver;

  constructor(filename: string = ":memory:") {
    this.db = openDatabase(filename);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS flow_states (
        id TEXT PRIMARY KEY,
        bot_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        wake_at REAL,
        updated_at REAL NOT NULL,
        rev INTEGER NOT NULL,
        doc TEXT NOT NULL
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_flow_states_query ON flow_states (bot_id, status, chat_id)",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS waiters (
        key TEXT PRIMARY KEY,
        flow_state_id TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  close(): void {
    this.db.close();
  }

  async getFlowState(id: string): Promise<FlowStateDoc | null> {
    const row = this.db.get("SELECT doc FROM flow_states WHERE id = ?", [id]) as {
      doc: string;
    } | null;
    return row ? (JSON.parse(row.doc) as FlowStateDoc) : null;
  }

  async putFlowState(doc: FlowStateDoc, expectedRev?: number): Promise<boolean> {
    if (expectedRev !== undefined) {
      const stored = { ...doc, rev: expectedRev + 1 };
      const result = this.db.run(
        `UPDATE flow_states
         SET bot_id = ?, status = ?, chat_id = ?, wake_at = ?, updated_at = ?, rev = ?, doc = ?
         WHERE id = ? AND rev = ?`,
        [
          stored.botId,
          stored.status,
          stored.chatId,
          stored.wakeAt ?? null,
          stored.meta.updatedAt,
          stored.rev,
          JSON.stringify(stored),
          stored.id,
          expectedRev,
        ],
      );
      return result.changes === 1;
    }
    this.db.run(
      `INSERT OR REPLACE INTO flow_states (id, bot_id, status, chat_id, wake_at, updated_at, rev, doc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        doc.id,
        doc.botId,
        doc.status,
        doc.chatId,
        doc.wakeAt ?? null,
        doc.meta.updatedAt,
        doc.rev,
        JSON.stringify(doc),
      ],
    );
    return true;
  }

  async deleteFlowStates(ids: string[]): Promise<void> {
    for (const id of ids) this.db.run("DELETE FROM flow_states WHERE id = ?", [id]);
  }

  async listFlowStates(q: FlowStateQuery): Promise<FlowStateDoc[]> {
    const clauses = ["bot_id = ?"];
    const params: (string | number)[] = [q.botId];
    if (q.status !== undefined) {
      clauses.push("status = ?");
      params.push(q.status);
    }
    if (q.chatId !== undefined) {
      clauses.push("chat_id = ?");
      params.push(q.chatId);
    }
    if (q.wakeBefore !== undefined) {
      clauses.push("wake_at IS NOT NULL AND wake_at < ?");
      params.push(q.wakeBefore);
    }
    if (q.updatedBefore !== undefined) {
      clauses.push("updated_at < ?");
      params.push(q.updatedBefore);
    }
    const rows = this.db.all(
      `SELECT doc FROM flow_states WHERE ${clauses.join(" AND ")}`,
      params,
    ) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as FlowStateDoc);
  }

  async claimWaiter(key: string): Promise<string | null> {
    const row = this.db.get("DELETE FROM waiters WHERE key = ? RETURNING flow_state_id", [key]) as {
      flow_state_id: string;
    } | null;
    return row?.flow_state_id ?? null;
  }

  async putWaiter(key: string, flowStateId: string): Promise<void> {
    this.db.run("INSERT OR REPLACE INTO waiters (key, flow_state_id) VALUES (?, ?)", [
      key,
      flowStateId,
    ]);
  }

  async deleteWaiters(keys: string[]): Promise<void> {
    for (const key of keys) this.db.run("DELETE FROM waiters WHERE key = ?", [key]);
  }

  async kvGet(key: string): Promise<unknown> {
    const row = this.db.get("SELECT value FROM kv WHERE key = ?", [key]) as {
      value: string;
    } | null;
    return row ? JSON.parse(row.value) : undefined;
  }

  async kvSet(key: string, value: unknown): Promise<void> {
    this.db.run("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", [
      key,
      JSON.stringify(value),
    ]);
  }

  async kvDelete(key: string): Promise<void> {
    this.db.run("DELETE FROM kv WHERE key = ?", [key]);
  }

  async kvSetIfAbsent(key: string, value: unknown): Promise<boolean> {
    const result = this.db.run("INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)", [
      key,
      JSON.stringify(value),
    ]);
    return result.changes === 1;
  }
}
