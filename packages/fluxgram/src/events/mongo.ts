import { MongoClient, type Collection, type Db } from "mongodb";
import type { EventBus, EventDoc, EventEnvelope } from "./bus";

export interface MongoEventDoc {
  botId: number;
  name: string;
  payload: Record<string, unknown>;
  uniqueKey: string | null;
  oneAtATimeKey: string | null;
  invoked: boolean;
  invokedTs: number | null;
  resolved: boolean;
  resolvedTs: number | null;
}

export interface MongoEventBusOptions {
  botId: number;
  db?: string;
  collection?: string;
  /** poll cadence (default 1000ms) */
  pollIntervalMs?: number;
  /**
   * resolved events without a uniqueKey are deleted after this long (default
   * 24h). uniqueKey events are kept — deleting them would reopen dedup.
   */
  resolvedRetentionMs?: number;
}

/**
 * MongoDB-backed bus. Polling by default; on startup, events that were invoked
 * but never resolved by a previous process are re-delivered (crash recovery —
 * same recovery query used by the event invoker).
 * SPEC §7.1: change streams need a replica set; polling is the universal fallback.
 */
export class MongoEventBus implements EventBus {
  readonly collection: Collection<MongoEventDoc>;
  private client: MongoClient;
  private db: Db;
  private botId: number;
  private pollIntervalMs: number;
  private handler: ((e: EventDoc) => Promise<void>) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private startTs = Date.now();
  private resolvedRetentionMs: number;
  private lastCleanupTs = 0;

  static async connect(url: string, opts: MongoEventBusOptions): Promise<MongoEventBus> {
    const client = new MongoClient(url);
    await client.connect();
    const bus = new MongoEventBus(client, opts);
    await bus.collection.createIndex({ botId: 1, invoked: 1, resolved: 1 });
    await bus.collection.createIndex(
      { botId: 1, name: 1, uniqueKey: 1 },
      { unique: true, partialFilterExpression: { uniqueKey: { $type: "string" } } },
    );
    return bus;
  }

  constructor(client: MongoClient, opts: MongoEventBusOptions) {
    this.client = client;
    this.db = opts.db ? client.db(opts.db) : client.db();
    this.collection = this.db.collection(opts.collection ?? "fluxgram_events");
    this.botId = opts.botId;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.resolvedRetentionMs = opts.resolvedRetentionMs ?? 86_400_000;
  }

  /** Delete resolved non-uniqueKey events older than the retention window. */
  async cleanup(): Promise<void> {
    this.lastCleanupTs = Date.now();
    await this.collection.deleteMany({
      botId: this.botId,
      resolved: true,
      uniqueKey: null,
      resolvedTs: { $lt: Date.now() - this.resolvedRetentionMs },
    });
  }

  async publish(e: EventEnvelope): Promise<boolean> {
    const base = {
      botId: this.botId,
      name: e.name,
      payload: e.payload,
      uniqueKey: e.uniqueKey ?? null,
      oneAtATimeKey: e.oneAtATimeKey ?? null,
      invoked: false,
      invokedTs: null,
      resolved: false,
      resolvedTs: null,
    };
    if (e.uniqueKey !== undefined) {
      const result = await this.collection.updateOne(
        { botId: this.botId, name: e.name, uniqueKey: e.uniqueKey },
        { $setOnInsert: base },
        { upsert: true },
      );
      return result.upsertedCount === 1;
    }
    await this.collection.insertOne(base as never);
    return true;
  }

  subscribe(handler: (e: EventDoc) => Promise<void>): void {
    this.handler = handler;
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.handler) return;
    this.polling = true;
    try {
      const docs = await this.collection
        .find({
          botId: this.botId,
          $or: [
            { invoked: { $ne: true } },
            // crash recovery: invoked before this process started, never resolved
            { invoked: true, invokedTs: { $lt: this.startTs }, resolved: { $ne: true } },
          ],
        })
        .sort({ _id: 1 })
        .toArray();

      for (const doc of docs) {
        await this.collection.updateOne(
          { _id: doc._id },
          { $set: { invoked: true, invokedTs: Date.now() } },
        );
        try {
          await this.handler({
            id: String(doc._id),
            name: doc.name,
            payload: doc.payload,
            ...(doc.uniqueKey === null ? {} : { uniqueKey: doc.uniqueKey }),
            ...(doc.oneAtATimeKey === null ? {} : { oneAtATimeKey: doc.oneAtATimeKey }),
          });
        } finally {
          await this.collection.updateOne(
            { _id: doc._id },
            { $set: { resolved: true, resolvedTs: Date.now() } },
          );
        }
      }
    } catch {
      // next poll retries; observability hooks land in phase 7
    } finally {
      this.polling = false;
    }
    if (Date.now() - this.lastCleanupTs > 60_000) {
      await this.cleanup().catch(() => undefined);
    }
  }

  /** Stop polling and close the connection (production shutdown). */
  async close(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.client.close();
  }

  /** close() + drop the database — test teardown helper. */
  async destroy(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.db.dropDatabase().catch(() => undefined);
    await this.client.close();
  }
}
