import type { EventBus, EventDoc, EventEnvelope } from "./bus";

/**
 * Single-process bus: publish() delivers directly to the subscriber (and
 * resolves once handling finishes). Makes single-process deployments a no-op —
 * the same FluxgramClient code works unchanged against mongo/redis buses.
 */
export class InProcessEventBus implements EventBus {
  private handler: ((e: EventDoc) => Promise<void>) | undefined;
  private pending: EventDoc[] = [];
  private usedKeys = new Set<string>();

  async publish(e: EventEnvelope): Promise<boolean> {
    if (e.uniqueKey !== undefined) {
      const key = `${e.name}:${e.uniqueKey}`;
      if (this.usedKeys.has(key)) return false;
      this.usedKeys.add(key);
    }
    const doc: EventDoc = { ...e, id: crypto.randomUUID() };
    if (!this.handler) {
      this.pending.push(doc);
      return true;
    }
    await this.handler(doc);
    return true;
  }

  subscribe(handler: (e: EventDoc) => Promise<void>): void {
    this.handler = handler;
    const buffered = this.pending;
    this.pending = [];
    for (const doc of buffered) void handler(doc);
  }
}
