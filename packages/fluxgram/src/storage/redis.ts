import {
  connectRedisCommandClient,
  type RedisCommandClient,
  type RedisDriver,
} from "../util/redis-client";
import type { FlowStateDoc } from "../engine/state";
import type { FlowStateQuery, StorageAdapter } from "./adapter";

/**
 * Redis adapter. Runs on Bun (built-in RedisClient) and Node (optional
 * `redis` package). Atomicity: claimWaiter = GETDEL, CAS = a small Lua script
 * comparing a rev mirror key, kvSetIfAbsent = SET NX. Queries scan the
 * per-bot id set and filter client-side — fine for the
 * thousands-of-active-flows scale this library targets.
 */

const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[2])
if cur == ARGV[2] then
  redis.call('SET', KEYS[1], ARGV[1])
  redis.call('SET', KEYS[2], ARGV[3])
  redis.call('SADD', KEYS[3], ARGV[4])
  return 1
end
return 0
`;

export class RedisStorage implements StorageAdapter {
  private redis: RedisCommandClient;
  private prefix: string;

  static async connect(
    url: string,
    opts?: { prefix?: string; driver?: RedisDriver },
  ): Promise<RedisStorage> {
    const client = await connectRedisCommandClient(
      url,
      opts?.driver === undefined ? undefined : { driver: opts.driver },
    );
    return new RedisStorage(client, opts);
  }

  constructor(redis: RedisCommandClient, opts?: { prefix?: string }) {
    this.redis = redis;
    this.prefix = opts?.prefix ?? "fx";
  }

  close(): void {
    this.redis.close();
  }

  private key(...parts: (string | number)[]): string {
    return `${this.prefix}:${parts.join(":")}`;
  }

  private statesSet(botId: number): string {
    return this.key("states", botId);
  }

  async getFlowState(id: string): Promise<FlowStateDoc | null> {
    const raw = (await this.redis.sendCommand(["GET", this.key("state", id)])) as string | null;
    return raw === null ? null : (JSON.parse(raw) as FlowStateDoc);
  }

  async putFlowState(doc: FlowStateDoc, expectedRev?: number): Promise<boolean> {
    const stateKey = this.key("state", doc.id);
    const revKey = this.key("rev", doc.id);
    if (expectedRev !== undefined) {
      const stored = { ...doc, rev: expectedRev + 1 };
      const result = (await this.redis.sendCommand([
        "EVAL",
        CAS_SCRIPT,
        "3",
        stateKey,
        revKey,
        this.statesSet(doc.botId),
        JSON.stringify(stored),
        String(expectedRev),
        String(stored.rev),
        doc.id,
      ])) as number;
      return result === 1;
    }
    await this.redis.sendCommand(["SET", stateKey, JSON.stringify(doc)]);
    await this.redis.sendCommand(["SET", revKey, String(doc.rev)]);
    await this.redis.sendCommand(["SADD", this.statesSet(doc.botId), doc.id]);
    return true;
  }

  async deleteFlowStates(ids: string[]): Promise<void> {
    for (const id of ids) {
      const doc = await this.getFlowState(id);
      if (doc) await this.redis.sendCommand(["SREM", this.statesSet(doc.botId), id]);
      await this.redis.sendCommand(["DEL", this.key("state", id), this.key("rev", id)]);
    }
  }

  async listFlowStates(q: FlowStateQuery): Promise<FlowStateDoc[]> {
    const ids = (await this.redis.sendCommand(["SMEMBERS", this.statesSet(q.botId)])) as string[];
    if (ids.length === 0) return [];
    const raws = (await this.redis.sendCommand([
      "MGET",
      ...ids.map((id) => this.key("state", id)),
    ])) as (string | null)[];

    const out: FlowStateDoc[] = [];
    const dangling: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const raw = raws[i];
      if (raw === null || raw === undefined) {
        dangling.push(ids[i]!);
        continue;
      }
      const doc = JSON.parse(raw) as FlowStateDoc;
      if (doc.botId !== q.botId) continue;
      if (q.status !== undefined && doc.status !== q.status) continue;
      if (q.chatId !== undefined && doc.chatId !== q.chatId) continue;
      if (q.wakeBefore !== undefined && !(doc.wakeAt !== undefined && doc.wakeAt < q.wakeBefore))
        continue;
      if (q.updatedBefore !== undefined && doc.meta.updatedAt >= q.updatedBefore) continue;
      out.push(doc);
    }
    if (dangling.length > 0) {
      await this.redis.sendCommand(["SREM", this.statesSet(q.botId), ...dangling]);
    }
    return out;
  }

  async claimWaiter(key: string): Promise<string | null> {
    const value = (await this.redis.sendCommand(["GETDEL", this.key("waiter", key)])) as
      | string
      | null;
    return value ?? null;
  }

  async putWaiter(key: string, flowStateId: string): Promise<void> {
    await this.redis.sendCommand(["SET", this.key("waiter", key), flowStateId]);
  }

  async deleteWaiters(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.redis.sendCommand(["DEL", ...keys.map((k) => this.key("waiter", k))]);
  }

  async kvGet(key: string): Promise<unknown> {
    const raw = (await this.redis.sendCommand(["GET", this.key("kv", key)])) as string | null;
    return raw === null ? undefined : JSON.parse(raw);
  }

  async kvSet(key: string, value: unknown): Promise<void> {
    await this.redis.sendCommand(["SET", this.key("kv", key), JSON.stringify(value)]);
  }

  async kvDelete(key: string): Promise<void> {
    await this.redis.sendCommand(["DEL", this.key("kv", key)]);
  }

  async kvSetIfAbsent(key: string, value: unknown): Promise<boolean> {
    const result = (await this.redis.sendCommand([
      "SET",
      this.key("kv", key),
      JSON.stringify(value),
      "NX",
    ])) as string | null;
    return result === "OK";
  }
}
