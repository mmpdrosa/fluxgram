import { MongoClient, type Collection, type Db } from "mongodb";
import type { FlowStateDoc } from "../engine/state";
import type { FlowStateQuery, StorageAdapter } from "./adapter";

interface WaiterDoc {
  _id: string;
  flowStateId: string;
}

interface KvDoc {
  _id: string;
  value: unknown;
}

/**
 * MongoDB adapter. Atomicity: claimWaiter = findOneAndDelete; CAS = conditional
 * replaceOne on (id, rev); kvSetIfAbsent = $setOnInsert upsert.
 */
export class MongoStorage implements StorageAdapter {
  private client: MongoClient;
  private db: Db;
  private states: Collection<FlowStateDoc & { _id: string }>;
  private waiters: Collection<WaiterDoc>;
  private kv: Collection<KvDoc>;

  static async connect(url: string, opts?: { db?: string }): Promise<MongoStorage> {
    const client = new MongoClient(url);
    await client.connect();
    const storage = new MongoStorage(client, opts?.db);
    await storage.ensureIndexes();
    return storage;
  }

  constructor(client: MongoClient, dbName?: string) {
    this.client = client;
    this.db = dbName ? client.db(dbName) : client.db();
    this.states = this.db.collection("fluxgram_flow_states");
    this.waiters = this.db.collection("fluxgram_waiters");
    this.kv = this.db.collection("fluxgram_kv");
  }

  async ensureIndexes(): Promise<void> {
    await this.states.createIndex({ botId: 1, status: 1, chatId: 1 });
    await this.states.createIndex({ botId: 1, status: 1, wakeAt: 1 });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async dropDatabase(): Promise<void> {
    await this.db.dropDatabase();
  }

  private strip(doc: (FlowStateDoc & { _id?: string }) | null): FlowStateDoc | null {
    if (!doc) return null;
    const { _id, ...rest } = doc;
    void _id;
    return rest as FlowStateDoc;
  }

  async getFlowState(id: string): Promise<FlowStateDoc | null> {
    return this.strip(await this.states.findOne({ _id: id }));
  }

  async putFlowState(doc: FlowStateDoc, expectedRev?: number): Promise<boolean> {
    if (expectedRev !== undefined) {
      const stored = { ...doc, rev: expectedRev + 1 };
      const result = await this.states.replaceOne({ _id: doc.id, rev: expectedRev }, stored);
      return result.modifiedCount === 1;
    }
    await this.states.replaceOne({ _id: doc.id }, doc, { upsert: true });
    return true;
  }

  async deleteFlowStates(ids: string[]): Promise<void> {
    await this.states.deleteMany({ _id: { $in: ids } });
  }

  async listFlowStates(q: FlowStateQuery): Promise<FlowStateDoc[]> {
    const filter: Record<string, unknown> = { botId: q.botId };
    if (q.status !== undefined) filter["status"] = q.status;
    if (q.chatId !== undefined) filter["chatId"] = q.chatId;
    if (q.wakeBefore !== undefined) filter["wakeAt"] = { $lt: q.wakeBefore };
    if (q.updatedBefore !== undefined) filter["meta.updatedAt"] = { $lt: q.updatedBefore };
    const docs = await this.states.find(filter).toArray();
    return docs.map((d) => this.strip(d)!);
  }

  async claimWaiter(key: string): Promise<string | null> {
    const doc = await this.waiters.findOneAndDelete({ _id: key });
    return doc?.flowStateId ?? null;
  }

  async putWaiter(key: string, flowStateId: string): Promise<void> {
    await this.waiters.replaceOne({ _id: key }, { flowStateId }, { upsert: true });
  }

  async deleteWaiters(keys: string[]): Promise<void> {
    await this.waiters.deleteMany({ _id: { $in: keys } });
  }

  async kvGet(key: string): Promise<unknown> {
    const doc = await this.kv.findOne({ _id: key });
    return doc ? doc.value : undefined;
  }

  async kvSet(key: string, value: unknown): Promise<void> {
    await this.kv.replaceOne({ _id: key }, { value }, { upsert: true });
  }

  async kvDelete(key: string): Promise<void> {
    await this.kv.deleteOne({ _id: key });
  }

  async kvSetIfAbsent(key: string, value: unknown): Promise<boolean> {
    const result = await this.kv.updateOne(
      { _id: key },
      { $setOnInsert: { value } },
      { upsert: true },
    );
    return result.upsertedCount === 1;
  }
}
