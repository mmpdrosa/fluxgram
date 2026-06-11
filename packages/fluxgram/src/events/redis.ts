import {
  connectRedisCommandClient,
  type RedisCommandClient,
  type RedisDriver,
} from "../util/redis-client";
import type { EventBus, EventDoc, EventEnvelope } from "./bus";

export interface RedisEventBusOptions {
  botId: number;
  prefix?: string;
  /** poll cadence (default 1000ms) */
  pollIntervalMs?: number;
  /** force a client implementation; default: Bun's built-in on Bun, `redis` pkg on Node */
  driver?: RedisDriver;
}

/**
 * Redis-backed bus using the reliable-queue pattern: events are LMOVE'd from
 * the pending list to a processing list, and removed once the handler
 * resolves. On startup, leftovers in processing (a previous process crashed
 * mid-handling) are requeued — at-least-once, like the Mongo bus.
 */
export class RedisEventBus implements EventBus {
  private redis: RedisCommandClient;
  private prefix: string;
  private botId: number;
  private pollIntervalMs: number;
  private handler: ((e: EventDoc) => Promise<void>) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  static async connect(url: string, opts: RedisEventBusOptions): Promise<RedisEventBus> {
    const client = await connectRedisCommandClient(
      url,
      opts.driver === undefined ? undefined : { driver: opts.driver },
    );
    return new RedisEventBus(client, opts);
  }

  constructor(redis: RedisCommandClient, opts: RedisEventBusOptions) {
    this.redis = redis;
    this.botId = opts.botId;
    this.prefix = opts.prefix ?? "fx";
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
  }

  private get pending(): string {
    return `${this.prefix}:events:${this.botId}:pending`;
  }

  private get processing(): string {
    return `${this.prefix}:events:${this.botId}:processing`;
  }

  private uniqueKey(name: string, key: string): string {
    return `${this.prefix}:events:${this.botId}:unique:${name}:${key}`;
  }

  async publish(e: EventEnvelope): Promise<boolean> {
    if (e.uniqueKey !== undefined) {
      const won = (await this.redis.sendCommand([
        "SET",
        this.uniqueKey(e.name, e.uniqueKey),
        "1",
        "NX",
      ])) as string | null;
      if (won !== "OK") return false;
    }
    const doc: EventDoc = { ...e, id: crypto.randomUUID() };
    await this.redis.sendCommand(["RPUSH", this.pending, JSON.stringify(doc)]);
    return true;
  }

  subscribe(handler: (e: EventDoc) => Promise<void>): void {
    this.handler = handler;
    void this.requeueProcessing().then(() => {
      this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
      void this.poll();
    });
  }

  /** crash recovery: push a dead process's in-flight events back onto pending */
  private async requeueProcessing(): Promise<void> {
    while (true) {
      const moved = await this.redis.sendCommand([
        "LMOVE",
        this.processing,
        this.pending,
        "RIGHT",
        "LEFT",
      ]);
      if (moved === null) return;
    }
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.handler) return;
    this.polling = true;
    try {
      while (true) {
        const raw = (await this.redis.sendCommand([
          "LMOVE",
          this.pending,
          this.processing,
          "LEFT",
          "RIGHT",
        ])) as string | null;
        if (raw === null) break;
        try {
          await this.handler(JSON.parse(raw) as EventDoc);
        } finally {
          await this.redis.sendCommand(["LREM", this.processing, "1", raw]);
        }
      }
    } catch {
      // next poll retries
    } finally {
      this.polling = false;
    }
  }

  /** Stop polling and close the connection (production shutdown). */
  close(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.redis.close();
  }

  /** close() + drop this bus's keys — test teardown helper. */
  async destroy(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.redis.sendCommand(["DEL", this.pending, this.processing]).catch(() => undefined);
    this.redis.close();
  }
}
