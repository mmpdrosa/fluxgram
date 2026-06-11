import type { FlowStateDoc, FlowStatus } from "../engine/state";

export interface FlowStateQuery {
  botId: number;
  status?: FlowStatus;
  chatId?: number;
  wakeBefore?: number;
  updatedBefore?: number;
}

/**
 * Narrow on purpose. All implementations must provide:
 * - claimWaiter as an ATOMIC get-and-delete
 * - putFlowState CAS when expectedRev is given (false on conflict)
 * Values are JSON documents; adapters must not require richer codecs.
 */
export interface StorageAdapter {
  getFlowState(id: string): Promise<FlowStateDoc | null>;
  putFlowState(doc: FlowStateDoc, expectedRev?: number): Promise<boolean>;
  deleteFlowStates(ids: string[]): Promise<void>;
  listFlowStates(q: FlowStateQuery): Promise<FlowStateDoc[]>;

  claimWaiter(key: string): Promise<string | null>;
  putWaiter(key: string, flowStateId: string): Promise<void>;
  deleteWaiters(keys: string[]): Promise<void>;

  kvGet(key: string): Promise<unknown>;
  kvSet(key: string, value: unknown): Promise<void>;
  kvDelete(key: string): Promise<void>;
  kvSetIfAbsent(key: string, value: unknown): Promise<boolean>;
}
