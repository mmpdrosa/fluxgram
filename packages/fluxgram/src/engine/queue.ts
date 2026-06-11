/**
 * Per-chat execution serialization: at most one job runs per chat, FIFO,
 * bounded queue. Across chats, jobs run concurrently. This is what makes
 * button double-press / handler-clearing races impossible by construction.
 */
export class ChatQueue {
  private chains = new Map<number, { tail: Promise<unknown>; queued: number }>();
  private maxQueuedPerChat: number;

  constructor(opts?: { maxQueuedPerChat?: number }) {
    this.maxQueuedPerChat = opts?.maxQueuedPerChat ?? 100;
  }

  /** Number of jobs running or queued for a chat. */
  size(chatId: number): number {
    return this.chains.get(chatId)?.queued ?? 0;
  }

  /** Resolves when all jobs currently running or queued have settled. */
  async onIdle(): Promise<void> {
    await Promise.all([...this.chains.values()].map((chain) => chain.tail));
  }

  run<T>(chatId: number, job: () => Promise<T> | T): Promise<T> {
    const chain = this.chains.get(chatId) ?? { tail: Promise.resolve(), queued: 0 };
    if (chain.queued >= this.maxQueuedPerChat + 1) {
      return Promise.reject(
        new Error(`Chat ${chatId} execution queue is full (${this.maxQueuedPerChat} queued)`),
      );
    }

    chain.queued++;
    const result = chain.tail.then(job, job);
    chain.tail = result
      .catch(() => undefined)
      .finally(() => {
        chain.queued--;
        if (chain.queued === 0) this.chains.delete(chatId);
      });
    this.chains.set(chatId, chain);
    return result;
  }
}
