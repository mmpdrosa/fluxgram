import type { FlowStateDoc } from "../engine/state";
import type { FlowStateQuery, StorageAdapter } from "./adapter";

export interface PostgresQueryExecutor {
  query(text: string, params?: unknown[]): Promise<unknown[]>;
  close?(): Promise<void> | void;
}

export type PostgresDriver = "bun" | "pg";

export interface PostgresStorageOptions {
  tablePrefix?: string;
}

export interface PostgresConnectOptions extends PostgresStorageOptions {
  driver?: PostgresDriver;
}

interface BunSqlClient {
  unsafe(text: string, params?: unknown[]): Promise<unknown[]>;
  end(): Promise<void> | void;
}

interface PgPoolClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

/**
 * Postgres adapter. Bun uses its built-in SQL client; Node uses the optional
 * `pg` package. Atomicity from single statements: claimWaiter =
 * DELETE..RETURNING, CAS = conditional UPDATE, kvSetIfAbsent = ON CONFLICT DO
 * NOTHING.
 */
export class PostgresStorage implements StorageAdapter {
  private executor: PostgresQueryExecutor;
  private table: string;

  static async connect(url: string, opts?: PostgresConnectOptions): Promise<PostgresStorage> {
    const driver = opts?.driver ?? (process.versions.bun ? "bun" : "pg");
    const executor =
      driver === "bun" ? await connectBunPostgres(url) : await connectPgPostgres(url);
    const storage = new PostgresStorage(executor, opts);
    await storage.ensureTables();
    return storage;
  }

  constructor(executor: PostgresQueryExecutor, opts?: PostgresStorageOptions) {
    this.executor = executor;
    this.table = opts?.tablePrefix ?? "fluxgram";
  }

  async ensureTables(): Promise<void> {
    await this.executor.query(`
      CREATE TABLE IF NOT EXISTS ${this.table}_flow_states (
        id TEXT PRIMARY KEY,
        bot_id BIGINT NOT NULL,
        status TEXT NOT NULL,
        chat_id BIGINT NOT NULL,
        wake_at DOUBLE PRECISION,
        updated_at DOUBLE PRECISION NOT NULL,
        rev INTEGER NOT NULL,
        doc JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${this.table}_flow_states_query
        ON ${this.table}_flow_states (bot_id, status, chat_id);
      CREATE TABLE IF NOT EXISTS ${this.table}_waiters (
        key TEXT PRIMARY KEY,
        flow_state_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${this.table}_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  async close(): Promise<void> {
    await this.executor.close?.();
  }

  /** Drop this adapter's tables — test teardown helper. */
  async dropTables(): Promise<void> {
    await this.executor.query(`
      DROP TABLE IF EXISTS ${this.table}_flow_states;
      DROP TABLE IF EXISTS ${this.table}_waiters;
      DROP TABLE IF EXISTS ${this.table}_kv;
    `);
  }

  async getFlowState(id: string): Promise<FlowStateDoc | null> {
    const rows = (await this.executor.query(
      `SELECT doc FROM ${this.table}_flow_states WHERE id = $1`,
      [id],
    )) as { doc: unknown }[];
    return rows[0] ? this.parseDoc(rows[0].doc) : null;
  }

  async putFlowState(doc: FlowStateDoc, expectedRev?: number): Promise<boolean> {
    if (expectedRev !== undefined) {
      const stored = { ...doc, rev: expectedRev + 1 };
      const rows = (await this.executor.query(
        `UPDATE ${this.table}_flow_states
         SET bot_id = $1, status = $2, chat_id = $3, wake_at = $4, updated_at = $5, rev = $6, doc = $7::jsonb
         WHERE id = $8 AND rev = $9
         RETURNING id`,
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
      )) as { id: string }[];
      return rows.length === 1;
    }
    await this.executor.query(
      `INSERT INTO ${this.table}_flow_states (id, bot_id, status, chat_id, wake_at, updated_at, rev, doc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         bot_id = EXCLUDED.bot_id, status = EXCLUDED.status, chat_id = EXCLUDED.chat_id,
         wake_at = EXCLUDED.wake_at, updated_at = EXCLUDED.updated_at, rev = EXCLUDED.rev,
         doc = EXCLUDED.doc`,
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

  /** $1,$2,… placeholder list for an IN clause (Bun sql lacks array params). */
  private placeholders(count: number): string {
    return Array.from({ length: count }, (_, i) => `$${i + 1}`).join(", ");
  }

  async deleteFlowStates(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.executor.query(
      `DELETE FROM ${this.table}_flow_states WHERE id IN (${this.placeholders(ids.length)})`,
      ids,
    );
  }

  async listFlowStates(q: FlowStateQuery): Promise<FlowStateDoc[]> {
    const clauses = ["bot_id = $1"];
    const params: unknown[] = [q.botId];
    if (q.status !== undefined) {
      params.push(q.status);
      clauses.push(`status = $${params.length}`);
    }
    if (q.chatId !== undefined) {
      params.push(q.chatId);
      clauses.push(`chat_id = $${params.length}`);
    }
    if (q.wakeBefore !== undefined) {
      params.push(q.wakeBefore);
      clauses.push(`wake_at IS NOT NULL AND wake_at < $${params.length}`);
    }
    if (q.updatedBefore !== undefined) {
      params.push(q.updatedBefore);
      clauses.push(`updated_at < $${params.length}`);
    }
    const rows = (await this.executor.query(
      `SELECT doc FROM ${this.table}_flow_states WHERE ${clauses.join(" AND ")}`,
      params,
    )) as { doc: unknown }[];
    return rows.map((r) => this.parseDoc(r.doc));
  }

  async claimWaiter(key: string): Promise<string | null> {
    const rows = (await this.executor.query(
      `DELETE FROM ${this.table}_waiters WHERE key = $1 RETURNING flow_state_id`,
      [key],
    )) as { flow_state_id: string }[];
    return rows[0]?.flow_state_id ?? null;
  }

  async putWaiter(key: string, flowStateId: string): Promise<void> {
    await this.executor.query(
      `INSERT INTO ${this.table}_waiters (key, flow_state_id) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET flow_state_id = EXCLUDED.flow_state_id`,
      [key, flowStateId],
    );
  }

  async deleteWaiters(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.executor.query(
      `DELETE FROM ${this.table}_waiters WHERE key IN (${this.placeholders(keys.length)})`,
      keys,
    );
  }

  async kvGet(key: string): Promise<unknown> {
    const rows = (await this.executor.query(`SELECT value FROM ${this.table}_kv WHERE key = $1`, [
      key,
    ])) as { value: string }[];
    return rows.length === 0 ? undefined : JSON.parse(rows[0]!.value);
  }

  async kvSet(key: string, value: unknown): Promise<void> {
    await this.executor.query(
      `INSERT INTO ${this.table}_kv (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  }

  async kvDelete(key: string): Promise<void> {
    await this.executor.query(`DELETE FROM ${this.table}_kv WHERE key = $1`, [key]);
  }

  async kvSetIfAbsent(key: string, value: unknown): Promise<boolean> {
    const rows = (await this.executor.query(
      `INSERT INTO ${this.table}_kv (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [key, JSON.stringify(value)],
    )) as { key: string }[];
    return rows.length === 1;
  }

  private parseDoc(value: unknown): FlowStateDoc {
    return (typeof value === "string" ? JSON.parse(value) : value) as FlowStateDoc;
  }
}

async function connectBunPostgres(url: string): Promise<PostgresQueryExecutor> {
  const { SQL } = (await import("bun")) as unknown as {
    SQL: new (url: string) => BunSqlClient;
  };
  const sql = new SQL(url);
  return {
    query: (text, params = []) => sql.unsafe(text, params),
    close: () => sql.end(),
  };
}

async function connectPgPostgres(url: string): Promise<PostgresQueryExecutor> {
  let Pool: new (opts: { connectionString: string }) => PgPoolClient;
  try {
    ({ Pool } = (await import("pg")) as unknown as {
      Pool: new (opts: { connectionString: string }) => PgPoolClient;
    });
  } catch {
    throw new Error("fluxgram's Postgres adapter needs the 'pg' package on Node: npm install pg");
  }
  const pool = new Pool({ connectionString: url });
  return {
    query: async (text, params = []) => (await pool.query(text, params)).rows,
    close: () => pool.end(),
  };
}
