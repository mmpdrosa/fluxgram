import type { FlowStateDoc } from "../engine/state";
import type { FlowStateQuery, StorageAdapter } from "./adapter";

/** Deep-copy via JSON — doubles as a dev-time guard that docs stay JSON-safe. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class MemoryStorage implements StorageAdapter {
  private states = new Map<string, FlowStateDoc>();
  private waiters = new Map<string, string>();
  private kv = new Map<string, unknown>();

  async getFlowState(id: string): Promise<FlowStateDoc | null> {
    const doc = this.states.get(id);
    return doc ? clone(doc) : null;
  }

  async putFlowState(doc: FlowStateDoc, expectedRev?: number): Promise<boolean> {
    const existing = this.states.get(doc.id);
    if (expectedRev !== undefined) {
      if (!existing || existing.rev !== expectedRev) return false;
      this.states.set(doc.id, clone({ ...doc, rev: expectedRev + 1 }));
      return true;
    }
    this.states.set(doc.id, clone(doc));
    return true;
  }

  async deleteFlowStates(ids: string[]): Promise<void> {
    for (const id of ids) this.states.delete(id);
  }

  async listFlowStates(q: FlowStateQuery): Promise<FlowStateDoc[]> {
    const out: FlowStateDoc[] = [];
    for (const doc of this.states.values()) {
      if (doc.botId !== q.botId) continue;
      if (q.status !== undefined && doc.status !== q.status) continue;
      if (q.chatId !== undefined && doc.chatId !== q.chatId) continue;
      if (q.wakeBefore !== undefined && !(doc.wakeAt !== undefined && doc.wakeAt < q.wakeBefore))
        continue;
      if (q.updatedBefore !== undefined && doc.meta.updatedAt >= q.updatedBefore) continue;
      out.push(clone(doc));
    }
    return out;
  }

  async claimWaiter(key: string): Promise<string | null> {
    const id = this.waiters.get(key);
    if (id === undefined) return null;
    this.waiters.delete(key);
    return id;
  }

  async putWaiter(key: string, flowStateId: string): Promise<void> {
    this.waiters.set(key, flowStateId);
  }

  async deleteWaiters(keys: string[]): Promise<void> {
    for (const key of keys) this.waiters.delete(key);
  }

  async kvGet(key: string): Promise<unknown> {
    return this.kv.get(key);
  }

  async kvSet(key: string, value: unknown): Promise<void> {
    this.kv.set(key, value);
  }

  async kvDelete(key: string): Promise<void> {
    this.kv.delete(key);
  }

  async kvSetIfAbsent(key: string, value: unknown): Promise<boolean> {
    if (this.kv.has(key)) return false;
    this.kv.set(key, value);
    return true;
  }
}
