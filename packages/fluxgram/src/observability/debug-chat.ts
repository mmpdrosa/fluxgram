import type { FlowEvent, ObservabilitySink } from "./events";

const DIGEST_LIMIT = 4096;
const SINGLE_ENTRY_LIMIT = 3500; // longer single entries get truncated + shipped as a document
const SEEN_KEYS_LIMIT = 10_000; // uniqueKey dedup horizon; oldest evicted first

export interface DebugChatApi {
  sendMessage(chatId: number, text: string): Promise<{ message_id: number }>;
  forwardMessage?(
    toChatId: number,
    fromChatId: number,
    messageId: number,
  ): Promise<{ message_id: number }>;
  sendDocument?(chatId: number, content: unknown, opts?: Record<string, unknown>): Promise<unknown>;
}

export interface DebugChatSinkOptions {
  api: DebugChatApi;
  /** the Telegram debug channel all digests go to */
  chatId: number;
  /** escalation channel: digests with notify events get forwarded here */
  notifyChatId?: number;
  /** tags appended to notify lines, e.g. ["@oncall"] */
  tags?: string[];
  ctxFormatter?: (e: FlowEvent) => string;
  /** auto-flush cadence; omit to flush manually */
  autoFlushMs?: number;
}

/**
 * The debug-chat sink batches FlowEvents into per-chat
 * digests (≤4096 chars), posts them to the debug chat, forwards referenced
 * messages, escalates notify digests to the notify chat, and overflows
 * oversized entries to a document.
 */
export class DebugChatSink implements ObservabilitySink {
  private opts: DebugChatSinkOptions;
  private queue: FlowEvent[] = [];
  private seenKeys = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: DebugChatSinkOptions) {
    this.opts = opts;
    if (opts.autoFlushMs !== undefined) {
      this.timer = setInterval(() => void this.flush(), opts.autoFlushMs);
    }
  }

  handle(e: FlowEvent): void {
    this.queue.push(e);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  async flush(): Promise<void> {
    const events = this.queue.splice(0);
    if (events.length === 0) return;

    const byChat = new Map<number, FlowEvent[]>();
    for (const e of events) {
      const group = byChat.get(e.chatId) ?? [];
      group.push(e);
      byChat.set(e.chatId, group);
    }

    for (const [originChat, group] of byChat) {
      await this.postChatDigests(originChat, group);
    }
  }

  private formatLine(action: FlowEvent["actions"][number]): string {
    const tagBit = action.notify && this.opts.tags?.length ? ` [${this.opts.tags.join(", ")}]` : "";
    const time = new Date(action.ts).toISOString().slice(11, 19);
    return `${time}${tagBit} ${action.kind}${action.text === undefined ? "" : `: ${action.text}`}`;
  }

  private async postChatDigests(originChat: number, group: FlowEvent[]): Promise<void> {
    const header = this.opts.ctxFormatter?.(group[0]!) ?? `Chat ${originChat}`;
    const lines: string[] = [];
    const overflows: string[] = [];
    const forwardIds: number[] = [];
    let notify = false;

    for (const e of group) {
      if (e.notify) notify = true;
      for (const action of e.actions) {
        if (action.uniqueKey !== undefined) {
          if (this.seenKeys.has(action.uniqueKey)) continue;
          this.seenKeys.add(action.uniqueKey);
          if (this.seenKeys.size > SEEN_KEYS_LIMIT) {
            this.seenKeys.delete(this.seenKeys.values().next().value!);
          }
        }
        let line = this.formatLine(action);
        if (line.length > SINGLE_ENTRY_LIMIT) {
          overflows.push(line);
          line = `${line.slice(0, SINGLE_ENTRY_LIMIT)} [...]`;
        }
        lines.push(line);
        if (action.forwardMessageId !== undefined) forwardIds.push(action.forwardMessageId);
      }
      if (e.error) lines.push(`OUTCOME ${e.outcome}: ${e.error.message}`);
    }
    if (lines.length === 0) return;

    // pack lines into ≤4096-char digests, header first in each
    const digests: string[] = [];
    let current = `${header}\n----------`;
    for (const line of lines) {
      if (current.length + 1 + line.length > DIGEST_LIMIT) {
        digests.push(current);
        current = `${header}\n----------`;
      }
      current += `\n${line}`;
    }
    digests.push(current);

    let firstDigestId: number | undefined;
    for (const digest of digests) {
      try {
        const msg = await this.opts.api.sendMessage(this.opts.chatId, digest);
        firstDigestId ??= msg.message_id;
      } catch {
        // observability must never throw into flows
      }
    }

    for (const overflow of overflows) {
      try {
        await this.opts.api.sendDocument?.(this.opts.chatId, overflow, {
          file_name: "truncated.txt",
        });
      } catch {
        // best-effort
      }
    }

    for (const messageId of forwardIds) {
      try {
        await this.opts.api.forwardMessage?.(this.opts.chatId, originChat, messageId);
      } catch {
        // the message may not be forwardable because of privacy settings
      }
    }

    if (notify && this.opts.notifyChatId !== undefined && firstDigestId !== undefined) {
      try {
        await this.opts.api.forwardMessage?.(
          this.opts.notifyChatId,
          this.opts.chatId,
          firstDigestId,
        );
      } catch {
        // best-effort escalation
      }
    }
  }
}
