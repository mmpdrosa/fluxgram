import {
  normalize,
  type MultiSelectStep,
  type PinStep,
  type PromptStep,
  type SendStep,
  type Step,
} from "../steps";
import { isChatDead, ValidationError } from "../errors";
import { humanDelay } from "../util/humandelay";
import { splitText } from "../util/chunk";
import { CycleRecorder, type FlowTrigger, type ObservabilitySink } from "../observability/events";
import type { StorageAdapter } from "../storage/adapter";
import type { FlowStateDoc, Frame } from "./state";
import { ChatQueue } from "./queue";
import { childrenOf, structuralHash, type FlowDef, type FlowRegistry } from "./registry";

/** Thrown by `ret(...)`: unwinds to the nearest enclosing callFlow frame. */
class ReturnSignal {
  constructor(readonly value: unknown) {}
}

/** Thrown by `redirectCC(...)` after doc.path/frames were repointed: the drive loop re-enters there. */
class JumpSignal {}

/**
 * Minimal Bot API surface the engine needs. In production this is satisfied by a
 * grammY Api (wired in a later phase); the test harness provides a fake.
 * SPEC: §2 — grammY owns transport; the engine depends only on this interface.
 */
export interface SentMessageLike {
  message_id: number;
  [k: string]: unknown;
}

export interface BotApi {
  sendMessage(
    chatId: number,
    text: string,
    opts?: Record<string, unknown>,
  ): Promise<SentMessageLike>;
  editMessageText?(
    chatId: number,
    messageId: number,
    text: string,
    opts?: Record<string, unknown>,
  ): Promise<unknown>;
  answerCallbackQuery?(queryId: string, opts?: { text?: string }): Promise<unknown>;
  sendPhoto?(
    chatId: number,
    file: unknown,
    opts?: Record<string, unknown>,
  ): Promise<SentMessageLike>;
  sendVideo?(
    chatId: number,
    file: unknown,
    opts?: Record<string, unknown>,
  ): Promise<SentMessageLike>;
  sendDocument?(
    chatId: number,
    file: unknown,
    opts?: Record<string, unknown>,
  ): Promise<SentMessageLike>;
  forwardMessage?(
    toChatId: number,
    fromChatId: number,
    messageId: number,
  ): Promise<SentMessageLike>;
  pinChatMessage?(
    chatId: number,
    messageId: number,
    opts?: { disable_notification?: boolean },
  ): Promise<unknown>;
  unpinChatMessage?(chatId: number, messageId: number): Promise<unknown>;
  getChat?(chatId: number): Promise<{ permissions?: { can_pin_messages?: boolean } }>;
  getChatMember?(
    chatId: number,
    userId: number,
  ): Promise<{ status?: string; can_pin_messages?: boolean }>;
  editMessageReplyMarkup?(chatId: number, messageId: number, markup?: unknown): Promise<unknown>;
}

function isParseEntitiesError(error: unknown): boolean {
  const text = String(
    (error as { description?: string })?.description ?? (error as Error)?.message ?? error,
  );
  return text.includes("can't parse entities");
}

function countingApi(api: BotApi, cycle: CycleRecorder): BotApi {
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(api)) {
    wrapped[key] =
      typeof value === "function"
        ? (...args: unknown[]) => {
            cycle.apiCalls++;
            return (value as (...a: unknown[]) => unknown).apply(api, args);
          }
        : value;
  }
  return wrapped as unknown as BotApi;
}

export interface IncomingMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number };
  text?: string;
  [k: string]: unknown;
}

export interface FlowContext<S = Record<string, unknown>> {
  store: S extends Record<string, unknown> ? S : Record<string, unknown>;
  chatId: number;
  api: BotApi;
  message?: IncomingMessage;
  botMessage?: object;
  /** append a debug action to this cycle's wide event (and the debug chat, if configured) */
  debug(
    msg: string,
    opts?: { notify?: boolean; forwardMessageId?: number; uniqueKey?: string },
  ): void;
  debugException(msg: string, error: unknown, opts?: { notify?: boolean }): void;
  /** @internal the current cycle recorder, when executing inside one */
  cycle?: CycleRecorder;
}

export interface FlowErrorContext {
  flowName: string;
  path: number[];
  chatId: number;
  error: unknown;
  ctx: FlowContext;
}

export type FlowErrorHandler = (e: FlowErrorContext) => unknown | Promise<unknown>; // may return a StepLike to run as recovery

/** What to do with an in-flight conversation whose flow version/shape changed (§4.2). */
export type VersionMismatchPolicy =
  | "restart"
  | "drop"
  | ((
      doc: FlowStateDoc,
      def: FlowDef,
    ) => FlowStateDoc | "restart" | "drop" | Promise<FlowStateDoc | "restart" | "drop">);

export interface EngineOptions {
  botId: number;
  registry: FlowRegistry;
  storage: StorageAdapter;
  api: BotApi;
  onFlowError?: FlowErrorHandler;
  versionMismatch?: VersionMismatchPolicy;
  maxQueuedPerChat?: number;
  /** sleeps at/above this many seconds become durable timers (default 30) */
  timerThresholdSecs?: number;
  /** 'running' docs untouched for this long are considered crashed (default 30s) */
  runningGraceMs?: number;
  /** pause between chunks of an over-limit message (default 1000ms) */
  interChunkDelayMs?: number;
  /** completed docs are deleted by the sweep after this long (default 1h; Infinity = keep) */
  doneRetentionMs?: number;
  /** wide-event consumers: evlogSink(), DebugChatSink, jsonSink(), custom */
  sinks?: ObservabilitySink[];
  now?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

type RunResult = "done" | "suspended";

export interface ActiveFlowInfo {
  id: string;
  chatId: number;
  flowName: string;
  status: "running" | "waiting" | "timer";
  path: number[];
  waitingKind?: "reply" | "button" | "either";
  startedAt: number;
  updatedAt: number;
}

export interface FlowHandle {
  id: string;
  chatId: number;
  flowName: string;
  editText(newText: string): Promise<void>;
  editButtonText(newText: string, buttonIndex: number): Promise<void>;
  terminate(opts?: { continueNextSteps?: boolean }): Promise<void>;
}

const DEFAULT_REQUIRE_BUTTON_TEXT = "Please click one of the buttons to answer.";

export class Engine {
  private botId: number;
  private registry: FlowRegistry;
  private storage: StorageAdapter;
  private api: BotApi;
  private onFlowError: FlowErrorHandler | undefined;
  private versionMismatch: VersionMismatchPolicy;
  private queue: ChatQueue;
  private timerThresholdSecs: number;
  private runningGraceMs: number;
  private interChunkDelayMs: number;
  private doneRetentionMs: number;
  private sinks: ObservabilitySink[];
  private now: () => number;
  private sleepFn: (ms: number) => Promise<void>;

  constructor(opts: EngineOptions) {
    this.botId = opts.botId;
    this.registry = opts.registry;
    this.storage = opts.storage;
    this.api = opts.api;
    this.onFlowError = opts.onFlowError;
    this.versionMismatch = opts.versionMismatch ?? "restart";
    const queueOpts =
      opts.maxQueuedPerChat === undefined ? undefined : { maxQueuedPerChat: opts.maxQueuedPerChat };
    this.queue = new ChatQueue(queueOpts);
    this.timerThresholdSecs = opts.timerThresholdSecs ?? 30;
    this.runningGraceMs = opts.runningGraceMs ?? 30_000;
    this.interChunkDelayMs = opts.interChunkDelayMs ?? 1000;
    this.doneRetentionMs = opts.doneRetentionMs ?? 3_600_000;
    this.sinks = opts.sinks ?? [];
    this.now = opts.now ?? (() => Date.now());
    this.sleepFn = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private newCycle(chatId: number, trigger: FlowTrigger): CycleRecorder {
    return new CycleRecorder({ botId: this.botId, chatId, trigger, now: this.now });
  }

  /** Graceful shutdown hook: wait for in-flight per-chat executions to finish. */
  async drain(): Promise<void> {
    await this.queue.onIdle();
  }

  /** Emit the cycle's wide event to every sink; sinks must never break flows. */
  private async emitCycle(cycle: CycleRecorder, doc: FlowStateDoc | null): Promise<void> {
    if (this.sinks.length === 0) return;
    if (doc) {
      cycle.flow = doc.flowName;
      cycle.version = doc.version;
      cycle.path = doc.path;
    }
    const event = cycle.finish(doc?.status);
    for (const sink of this.sinks) {
      try {
        await sink.handle(event);
      } catch {
        // a broken sink must never affect the conversation
      }
    }
  }

  /** Build a flow context bound to a cycle: api calls are counted, ctx.debug records actions. */
  private buildCtx(
    doc: FlowStateDoc,
    cycle: CycleRecorder | undefined,
    extra?: Partial<FlowContext>,
  ): FlowContext {
    const api = cycle ? countingApi(this.api, cycle) : this.api;
    return {
      store: doc.store,
      chatId: doc.chatId,
      api,
      debug: (msg, opts) => cycle?.add({ kind: "debug", text: msg, ...opts }),
      debugException: (msg, error, opts) =>
        cycle?.add({
          kind: "exception",
          text: `${msg}: ${String((error as Error)?.message ?? error)}`,
          notify: opts?.notify ?? true,
        }),
      ...(cycle === undefined ? {} : { cycle }),
      ...extra,
    };
  }

  async initiateFlow(
    flowName: string,
    chatId: number,
    opts?: { store?: Record<string, unknown>; startMessage?: IncomingMessage },
  ): Promise<void> {
    const def = this.registry.get(flowName);
    if (!def) throw new Error(`Flow '${flowName}' is not registered`);

    return this.queue.run(chatId, async () => {
      const cycle = this.newCycle(chatId, "initiate");
      const ts = this.now();
      const doc: FlowStateDoc = {
        id: crypto.randomUUID(),
        botId: this.botId,
        rev: 0,
        flowName: def.name,
        version: def.version,
        treeHash: def.treeHash,
        chatId,
        status: "running",
        path: [],
        frames: [],
        // takes ownership of the caller's object: it becomes the live ctx.store
        store: opts?.store ?? {},
        waiting: null,
        savedCC: {},
        dynamicHashes: {},
        meta: {
          startedAt: ts,
          updatedAt: ts,
          ...(opts?.startMessage === undefined
            ? {}
            : { startMessageId: opts.startMessage.message_id, lastMessage: opts.startMessage }),
          ...(opts?.startMessage?.from === undefined
            ? {}
            : { fromUserId: opts.startMessage.from.id }),
        },
      };
      const ctx = this.buildCtx(
        doc,
        cycle,
        opts?.startMessage === undefined ? undefined : { message: opts.startMessage },
      );

      try {
        const result = await this.drive(def, doc, ctx, () => this.runNode(def.root, [], doc, ctx));
        if (result === "done" && doc.status !== "done") {
          doc.status = "done";
          await this.persist(doc);
        }
      } catch (error) {
        await this.handleFlowError(def.name, doc, ctx, error);
      } finally {
        await this.emitCycle(cycle, doc);
      }
    });
  }

  /**
   * Route an incoming user message to a suspended prompt.
   * Returns "unhandled" when no flow is waiting in this chat (free for command routing).
   */
  async handleMessage(chatId: number, message: IncomingMessage): Promise<"handled" | "unhandled"> {
    const flowStateId = await this.storage.claimWaiter(`chat:${chatId}`);
    if (!flowStateId) return "unhandled";

    // onlyFrom scoping: someone else's message is not this prompt's answer
    const peek = await this.storage.getFlowState(flowStateId);
    const restrictTo = peek?.status === "waiting" ? peek.waiting?.fromUserId : undefined;
    if (restrictTo !== undefined && message.from?.id !== restrictTo) {
      await this.storage.putWaiter(`chat:${chatId}`, flowStateId);
      return "unhandled";
    }

    await this.queue.run(chatId, async () => {
      const doc = await this.storage.getFlowState(flowStateId);
      if (!doc || doc.status !== "waiting") return;
      const cycle = this.newCycle(chatId, "reply");
      const doneEmit = async (): Promise<void> => this.emitCycle(cycle, doc);
      const def = this.registry.get(doc.flowName);
      const ctx = this.buildCtx(doc, cycle, { message });
      cycle.add({ kind: "reply", text: message.text ?? "<non-text message>" });
      if (!def) {
        await this.handleFlowError(
          doc.flowName,
          doc,
          ctx,
          new Error(`Flow '${doc.flowName}' is not registered`),
        );
        await doneEmit();
        return;
      }

      try {
        if ((await this.applyVersionPolicy(def, doc, ctx)) === "consumed") return;
        const nodes = await this.materialize(def, doc, ctx);
        const node = nodes.at(-1);
        if (node?.kind !== "prompt" && node?.kind !== "multiselect") {
          throw new Error(
            `Flow '${def.name}' was waiting but path [${doc.path.join(",")}] is not a prompt`,
          );
        }

        if (node.kind === "multiselect" || node.mode === "buttons") {
          // buttons-only: bounce and keep waiting
          await ctx.api.sendMessage(chatId, node.requireButtonText ?? DEFAULT_REQUIRE_BUTTON_TEXT);
          await this.storage.putWaiter(`chat:${chatId}`, doc.id);
          await this.persist(doc);
          return;
        }

        let value: unknown = node.mode === "text" ? message.text : message;
        if (node.validate) {
          try {
            value = await this.runValidation(node, ctx, message, value);
          } catch (error) {
            if (error instanceof ValidationError) {
              cycle.add({ kind: "validation-failed", text: error.message });
              if (!error.ignoreMessage) await ctx.api.sendMessage(chatId, error.message);
              await this.storage.putWaiter(`chat:${chatId}`, doc.id);
              await this.persist(doc);
              return;
            }
            throw error;
          }
        }

        if (node.store) doc.store[node.store] = value;
        if (doc.waiting?.cbToken) await this.storage.deleteWaiters([`cb:${doc.waiting.cbToken}`]);
        doc.meta.lastMessage = message;
        doc.waiting = null;
        doc.status = "running";
        delete doc.wakeAt;
        await this.persist(doc);
        await this.drive(def, doc, ctx, () => this.continueAfter(nodes, doc, ctx));
      } catch (error) {
        await this.handleFlowError(def.name, doc, ctx, error);
      } finally {
        await doneEmit();
      }
    });
    return "handled";
  }

  /**
   * Route a callback query (button press) by its callback_data.
   * "stale" = the button's waiter was already consumed or never existed.
   */
  async handleCallback(
    data: string,
    opts?: { queryId?: string; fromUserId?: number },
  ): Promise<"handled" | "stale" | "forbidden" | "invalid"> {
    const match = /^fx:([^:]+):(.+)$/.exec(data);
    if (!match) return "invalid";
    const [, token, code] = match;

    const flowStateId = await this.storage.claimWaiter(`cb:${token}`);
    if (!flowStateId) {
      if (opts?.queryId)
        await this.api.answerCallbackQuery?.(opts.queryId, { text: "This menu has expired" });
      return "stale";
    }
    const peek = await this.storage.getFlowState(flowStateId);
    if (!peek || peek.status !== "waiting") return "stale";

    // onlyFrom scoping: someone else's click bounces and the prompt keeps waiting
    const restrictTo = peek.waiting?.fromUserId;
    if (
      restrictTo !== undefined &&
      opts?.fromUserId !== undefined &&
      opts.fromUserId !== restrictTo
    ) {
      await this.storage.putWaiter(`cb:${token}`, flowStateId);
      if (opts.queryId)
        await this.api.answerCallbackQuery?.(opts.queryId, { text: "This isn't for you" });
      return "forbidden";
    }

    await this.queue.run(peek.chatId, async () => {
      // re-read inside the queue: an earlier job (e.g. a near-simultaneous text
      // reply) may have already consumed this prompt and advanced the flow
      const doc = await this.storage.getFlowState(flowStateId);
      if (!doc || doc.status !== "waiting" || doc.waiting?.cbToken !== token) {
        if (opts?.queryId)
          await this.api.answerCallbackQuery?.(opts.queryId, { text: "This menu has expired" });
        return;
      }
      const cycle = this.newCycle(doc.chatId, "button");
      const def = this.registry.get(doc.flowName);
      const ctx = this.buildCtx(doc, cycle);
      if (!def) {
        await this.handleFlowError(
          doc.flowName,
          doc,
          ctx,
          new Error(`Flow '${doc.flowName}' is not registered`),
        );
        await this.emitCycle(cycle, doc);
        return;
      }

      try {
        if ((await this.applyVersionPolicy(def, doc, ctx)) === "consumed") return;
        const nodes = await this.materialize(def, doc, ctx);
        const node = nodes.at(-1);

        if (node?.kind === "multiselect" && (code === "s" || code!.startsWith("t"))) {
          await this.handleMultiSelectCallback(node, nodes, doc, ctx, token!, code!, opts);
          return;
        }
        if (node?.kind !== "prompt" && node?.kind !== "multiselect") {
          throw new Error(
            `Flow '${def.name}' was waiting but path [${doc.path.join(",")}] is not a prompt`,
          );
        }

        // a regular button child (prompt buttons, or multiselect extraButtons)
        const childIndex = Number(code);
        const layout = node.kind === "prompt" ? node.layout : node.extraLayout;
        const button = layout.flat().find((b) => b.childIndex === childIndex);
        const child = node.children[childIndex];
        if (!button || !child) throw new Error(`Button index ${childIndex} out of range`);
        const label = doc.waiting?.buttonLabels?.[String(childIndex)] ?? button.text;
        cycle.add({ kind: "button", text: label });

        // the chat (reply) waiter belongs to this prompt too — consume it
        await this.storage.deleteWaiters([`chat:${doc.chatId}`]);

        if (opts?.queryId) await ctx.api.answerCallbackQuery?.(opts.queryId, { text: label });

        // strip the keyboard and show the choice on the prompt message (best-effort)
        if (doc.waiting?.promptMessageId !== undefined && ctx.api.editMessageText) {
          const text = `${node.text}\n\n"${label}"`;
          try {
            await ctx.api.editMessageText(
              doc.chatId,
              doc.waiting.promptMessageId,
              text,
              node.parseMode === undefined ? undefined : { parse_mode: node.parseMode },
            );
          } catch (error) {
            // the label may break the parse mode — retry plain before giving up
            if (node.parseMode !== undefined && isParseEntitiesError(error)) {
              await ctx.api
                .editMessageText(doc.chatId, doc.waiting.promptMessageId, text)
                .catch(() => undefined);
            }
            // the message may be gone or unchanged; never fail the flow over it
          }
        }

        doc.waiting = null;
        doc.status = "running";
        delete doc.wakeAt;
        const promptPath = doc.path;
        const childPath = [...promptPath, childIndex];
        doc.path = childPath;
        await this.persist(doc); // crash recovery points at the button child

        doc.path = promptPath; // continueAfter's spine is anchored at the prompt
        await this.drive(def, doc, ctx, () =>
          this.continueAfter(nodes, doc, ctx, { node: child, path: childPath }),
        );
      } catch (error) {
        await this.handleFlowError(def.name, doc, ctx, error);
      } finally {
        await this.emitCycle(cycle, doc);
      }
    });
    return "handled";
  }

  private async handleMultiSelectCallback(
    node: MultiSelectStep,
    nodes: Step[],
    doc: FlowStateDoc,
    ctx: FlowContext,
    token: string,
    code: string,
    opts?: { queryId?: string },
  ): Promise<void> {
    const waiting = doc.waiting!;
    waiting.multiSelect ??= { selected: [] };
    const selected = waiting.multiSelect.selected;
    const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

    if (code.startsWith("t")) {
      // toggle: stays waiting — re-register the cb waiter we claimed
      const idx = Number(code.slice(1));
      const value = node.values[idx];
      const at = selected.findIndex((v) => sameValue(v, value));
      if (at === -1) selected.push(structuredClone(value));
      else selected.splice(at, 1);
      await this.persist(doc);
      await this.storage.putWaiter(`cb:${token}`, doc.id);

      if (opts?.queryId) await ctx.api.answerCallbackQuery?.(opts.queryId, {});
      if (waiting.promptMessageId !== undefined && ctx.api.editMessageReplyMarkup) {
        try {
          await ctx.api.editMessageReplyMarkup(
            doc.chatId,
            waiting.promptMessageId,
            this.buildMultiSelectMarkup(node, token, selected),
          );
        } catch {
          // best-effort
        }
      }
      return;
    }

    // submit
    await this.storage.deleteWaiters([`chat:${doc.chatId}`]);
    if (opts?.queryId) await ctx.api.answerCallbackQuery?.(opts.queryId, { text: node.submitText });

    if (selected.length === 0 && node.emptySelectionText !== undefined) {
      // SPEC §5.2: empty submit announces emptySelectionText, stores [], continues
      await ctx.api.sendMessage(doc.chatId, node.emptySelectionText);
    }
    doc.store[node.store] = structuredClone(selected);

    if (waiting.promptMessageId !== undefined && ctx.api.editMessageReplyMarkup) {
      try {
        await ctx.api.editMessageReplyMarkup(doc.chatId, waiting.promptMessageId, undefined);
      } catch {
        // best-effort keyboard strip
      }
    }

    doc.waiting = null;
    doc.status = "running";
    delete doc.wakeAt;
    await this.persist(doc);
    const def = this.registry.get(doc.flowName)!;
    await this.drive(def, doc, ctx, () => this.continueAfter(nodes, doc, ctx));
  }

  // ---- internals ----

  /**
   * Remove the doc's waiters. cb waiters are doc-unique so they go
   * unconditionally; the chat waiter is a shared per-chat key, so it is only
   * removed when it still points at this doc (another flow may own it now).
   */
  private async releaseWaiters(doc: FlowStateDoc): Promise<void> {
    if (doc.waiting?.cbToken) await this.storage.deleteWaiters([`cb:${doc.waiting.cbToken}`]);
    const owner = await this.storage.claimWaiter(`chat:${doc.chatId}`);
    if (owner !== null && owner !== doc.id) {
      await this.storage.putWaiter(`chat:${doc.chatId}`, owner);
    }
  }

  /**
   * Persist the doc as the program counter / store change (write-through, §4.4).
   * rev 0 = never written (plain insert); after that every write is a CAS on
   * rev, so a concurrent writer (another bot process resuming the same
   * conversation) is detected instead of silently clobbered.
   */
  private async persist(doc: FlowStateDoc): Promise<void> {
    doc.meta.updatedAt = this.now();
    if (doc.rev === 0) {
      doc.rev = 1;
      await this.storage.putFlowState(doc);
      return;
    }
    const ok = await this.storage.putFlowState(doc, doc.rev);
    if (!ok) {
      throw new Error(
        `Flow state '${doc.id}' (flow '${doc.flowName}', chat ${doc.chatId}) was modified concurrently ` +
          `at rev ${doc.rev} — is another bot process running against the same storage?`,
      );
    }
    doc.rev += 1;
  }

  /**
   * Top-level execution driver: a redirectCC repoints doc.path/frames and throws
   * JumpSignal; we re-materialize the spine there and continue. A ReturnSignal
   * surfacing here means ret() had no enclosing callFlow.
   */
  private async drive(
    def: FlowDef,
    doc: FlowStateDoc,
    ctx: FlowContext,
    first: () => Promise<RunResult>,
  ): Promise<RunResult> {
    let action = first;
    while (true) {
      try {
        return await action();
      } catch (error) {
        if (error instanceof JumpSignal) {
          const nodes = await this.materialize(def, doc, ctx);
          action = () => this.continueAfter(nodes, doc, ctx);
          continue;
        }
        if (error instanceof ReturnSignal) {
          throw new Error(
            `ret() outside of a subflow (no enclosing callFlow) in flow '${def.name}'`,
          );
        }
        throw error;
      }
    }
  }

  /**
   * Send with chunk-splitting (4096-class limits; 1000 for media captions) and
   * the parse-mode fallback retry: on a "can't parse
   * entities" error, retry once without parse_mode and deliver the raw text.
   */
  private async execSend(node: SendStep, doc: FlowStateDoc, ctx: FlowContext): Promise<void> {
    if (!node.media && !node.text) {
      throw new Error(`send: empty message text in flow '${doc.flowName}'`);
    }
    const limit = node.media ? 1000 : 4000;
    const chunks = splitText(node.text ?? "", limit);

    for (let i = 0; i < chunks.length; i++) {
      if (i > 0 && this.interChunkDelayMs > 0) await this.sleepFn(this.interChunkDelayMs);
      const chunk = chunks[i]!;
      const isFirst = i === 0;

      const sendOnce = async (parseMode: string | undefined): Promise<SentMessageLike> => {
        if (isFirst && node.media) {
          const fn =
            node.media.type === "photo"
              ? ctx.api.sendPhoto
              : node.media.type === "video"
                ? ctx.api.sendVideo
                : ctx.api.sendDocument;
          if (!fn) throw new Error(`BotApi has no send method for '${node.media.type}'`);
          const opts: Record<string, unknown> = {};
          if (chunk) opts["caption"] = chunk;
          if (parseMode !== undefined) opts["parse_mode"] = parseMode;
          if (node.media.fileName !== undefined) opts["file_name"] = node.media.fileName;
          if (node.opts?.replyToMessageId !== undefined) {
            opts["reply_to_message_id"] = node.opts.replyToMessageId;
          }
          return fn.call(ctx.api, ctx.chatId, node.media.file, opts);
        }
        const opts: Record<string, unknown> = {};
        if (parseMode !== undefined) opts["parse_mode"] = parseMode;
        if (isFirst && node.opts?.replyToMessageId !== undefined) {
          opts["reply_to_message_id"] = node.opts.replyToMessageId;
        }
        if (node.opts?.disableWebPagePreview) opts["disable_web_page_preview"] = true;
        return ctx.api.sendMessage(
          ctx.chatId,
          chunk,
          Object.keys(opts).length > 0 ? opts : undefined,
        );
      };

      let msg: SentMessageLike;
      try {
        msg = await sendOnce(node.opts?.parseMode);
      } catch (error) {
        if (node.opts?.parseMode !== undefined && isParseEntitiesError(error)) {
          msg = await sendOnce(undefined);
        } else {
          throw error;
        }
      }

      ctx.cycle?.add({ kind: node.media && isFirst ? node.media.type : "send", text: chunk });

      if (isFirst) {
        ctx.botMessage = msg;
        doc.meta.lastBotMessage = msg;
        node.opts?.onSent?.(ctx, msg);
      }
    }
  }

  private resolvePinTarget(
    target: PinStep["target"],
    doc: FlowStateDoc,
    ctx: FlowContext,
  ): number | undefined {
    if (typeof target === "number") return target;
    if (typeof target === "object") return ctx.store[target.fromStore] as number | undefined;
    const botMsgId = (doc.meta.lastBotMessage as SentMessageLike | undefined)?.message_id;
    const userMsgId = (doc.meta.lastMessage as IncomingMessage | undefined)?.message_id;
    switch (target) {
      case "most_recent_bot":
        return botMsgId;
      case "most_recent_user":
        return userMsgId;
      case "most_recent":
        if (botMsgId === undefined) return userMsgId;
        if (userMsgId === undefined) return botMsgId;
        return Math.max(botMsgId, userMsgId);
    }
  }

  /** Private chats always allow pinning; groups check chat and bot permissions. */
  private async canPin(chatId: number): Promise<{ canPin: boolean; reason?: "chat" | "bot" }> {
    if (chatId > 0) return { canPin: true };
    if (!this.api.getChat || !this.api.getChatMember) return { canPin: true };
    const member = await this.api.getChatMember(chatId, this.botId);
    const botCan = member.status === "administrator" || member.can_pin_messages === true;
    if (!botCan) return { canPin: false, reason: "bot" };
    const chat = await this.api.getChat(chatId);
    if (chat.permissions?.can_pin_messages === false) return { canPin: false, reason: "chat" };
    return { canPin: true };
  }

  /** Pop a callFlow frame: restore the caller's store and deliver the return value. */
  private popFrame(doc: FlowStateDoc, ctx: FlowContext, returnValue: unknown): void {
    const frame = doc.frames.pop();
    if (!frame) throw new Error("callFlow frame stack underflow");
    if (frame.storeResult !== undefined) frame.store[frame.storeResult] = returnValue;
    doc.store = frame.store;
    ctx.store = frame.store;
  }

  /**
   * §4.2: apply the version-mismatch policy when the registered flow no longer
   * matches the suspended doc. Returns "consumed" when the doc was handled
   * (restarted or dropped) and the caller must not resume it.
   */
  private async applyVersionPolicy(
    def: FlowDef,
    doc: FlowStateDoc,
    ctx: FlowContext,
  ): Promise<"ok" | "consumed"> {
    if (doc.version === def.version && doc.treeHash === def.treeHash) return "ok";

    let decision = this.versionMismatch;
    if (typeof decision === "function") {
      const out = await decision(doc, def);
      if (typeof out === "object") {
        Object.assign(doc, out);
        await this.persist(doc);
        return "ok";
      }
      decision = out;
    }

    await this.releaseWaiters(doc);

    if (decision === "drop") {
      await this.storage.deleteFlowStates([doc.id]);
      return "consumed";
    }

    // restart: terminate cleanly and re-run from the top with the existing store
    doc.version = def.version;
    doc.treeHash = def.treeHash;
    doc.path = [];
    doc.frames = [];
    doc.savedCC = {};
    doc.dynamicHashes = {};
    doc.waiting = null;
    delete doc.wakeAt;
    delete doc.timerDeadline;
    doc.status = "running";
    await this.persist(doc);
    const result = await this.drive(def, doc, ctx, () => this.runNode(def.root, [], doc, ctx));
    if (result === "done") {
      doc.status = "done";
      await this.persist(doc);
    }
    return "consumed";
  }

  /**
   * Recovery sweep (§4.4): wake due timers, resume crashed 'running' docs, and
   * re-send prompts that never made it out. Call on start() and periodically.
   */
  async sweep(): Promise<void> {
    const now = this.now();
    const dueTimers = await this.storage.listFlowStates({
      botId: this.botId,
      status: "timer",
      wakeBefore: now + 1,
    });
    const staleRunning = await this.storage.listFlowStates({
      botId: this.botId,
      status: "running",
      updatedBefore: now - this.runningGraceMs,
    });
    const staleWaiting = (
      await this.storage.listFlowStates({
        botId: this.botId,
        status: "waiting",
        updatedBefore: now - this.runningGraceMs,
      })
    ).filter((d) => d.waiting !== null && d.waiting.promptMessageId === undefined);
    // prompts whose timeoutSecs deadline (stored in wakeAt) has passed
    const dueWaiting = await this.storage.listFlowStates({
      botId: this.botId,
      status: "waiting",
      wakeBefore: now + 1,
    });

    const seen = new Set<string>();
    for (const snapshot of [...dueTimers, ...staleRunning, ...staleWaiting, ...dueWaiting]) {
      if (seen.has(snapshot.id)) continue;
      seen.add(snapshot.id);
      await this.queue.run(snapshot.chatId, () => this.resumeFromSweep(snapshot.id));
    }

    if (Number.isFinite(this.doneRetentionMs)) {
      const expired = await this.storage.listFlowStates({
        botId: this.botId,
        status: "done",
        updatedBefore: now - this.doneRetentionMs,
      });
      if (expired.length > 0) await this.storage.deleteFlowStates(expired.map((d) => d.id));
    }
  }

  private async resumeFromSweep(id: string): Promise<void> {
    const doc = await this.storage.getFlowState(id);
    if (!doc || doc.status === "done") return;
    const cycle = this.newCycle(doc.chatId, doc.status === "timer" ? "timer" : "sweep");
    const def = this.registry.get(doc.flowName);
    const ctx = this.buildCtx(doc, cycle);
    if (!def) {
      await this.handleFlowError(
        doc.flowName,
        doc,
        ctx,
        new Error(`Flow '${doc.flowName}' is not registered`),
      );
      await this.emitCycle(cycle, doc);
      return;
    }

    try {
      if ((await this.applyVersionPolicy(def, doc, ctx)) === "consumed") return;
      const wasTimer = doc.status === "timer";

      // an answered-too-late prompt: its timeoutSecs deadline (wakeAt) passed
      const isPromptTimeout =
        doc.status === "waiting" &&
        doc.wakeAt !== undefined &&
        doc.wakeAt <= this.now() &&
        doc.waiting?.promptMessageId !== undefined;
      if (isPromptTimeout) {
        await this.resolvePromptTimeout(def, doc, ctx);
        return;
      }

      if (doc.status === "waiting") {
        // crash between waiter registration and prompt send: clear stale waiters, re-suspend
        await this.releaseWaiters(doc);
      }

      const nodes = await this.materialize(def, doc, ctx);
      const node = nodes.at(-1)!;
      doc.status = "running";
      doc.waiting = null;
      if (wasTimer && node.kind === "sleep") delete doc.wakeAt;
      await this.persist(doc);

      if (wasTimer && node.kind === "sleep") {
        // the sleep elapsed — continue after it
        await this.drive(def, doc, ctx, () => this.continueAfter(nodes, doc, ctx));
      } else {
        // re-run the node in flight (waitFor re-check, prompt re-send, crashed step retry).
        // At-least-once: the step may repeat side effects (§4.4).
        await this.drive(def, doc, ctx, () =>
          this.continueAfter(nodes, doc, ctx, { node, path: doc.path }),
        );
      }
    } catch (error) {
      await this.handleFlowError(def.name, doc, ctx, error);
    } finally {
      await this.emitCycle(cycle, doc);
    }
  }

  /**
   * Resolve a timed-out prompt/multiselect: clear waiters, strip the keyboard,
   * then run the onTimeout child and continue — or end the flow without one.
   */
  private async resolvePromptTimeout(
    def: FlowDef,
    doc: FlowStateDoc,
    ctx: FlowContext,
  ): Promise<void> {
    const promptMessageId = doc.waiting?.promptMessageId;
    await this.releaseWaiters(doc);
    if (promptMessageId !== undefined && this.api.editMessageReplyMarkup) {
      try {
        await this.api.editMessageReplyMarkup(doc.chatId, promptMessageId, undefined);
      } catch {
        // best-effort keyboard strip
      }
    }

    const nodes = await this.materialize(def, doc, ctx);
    const node = nodes.at(-1)!;
    doc.waiting = null;
    delete doc.wakeAt;

    const timeoutChildIndex =
      node.kind === "prompt" || node.kind === "multiselect" ? node.timeoutChildIndex : undefined;
    if (timeoutChildIndex === undefined) {
      doc.status = "done";
      await this.persist(doc);
      return;
    }

    doc.status = "running";
    await this.persist(doc);
    const child = childrenOf(node)[timeoutChildIndex];
    if (!child) throw new Error(`timeout child ${timeoutChildIndex} missing on prompt`);
    await this.drive(def, doc, ctx, () =>
      this.continueAfter(nodes, doc, ctx, { node: child, path: [...doc.path, timeoutChildIndex] }),
    );
  }

  private async handleFlowError(
    flowName: string,
    doc: FlowStateDoc,
    ctx: FlowContext,
    error: unknown,
  ): Promise<void> {
    if (isChatDead(error)) {
      ctx.cycle?.setError(error, true);
      await this.releaseWaiters(doc);
      await this.storage.deleteFlowStates([doc.id]);
      doc.status = "done";
      return;
    }
    ctx.cycle?.setError(error, false);
    if (!this.onFlowError) throw error;
    const recovery = await this.onFlowError({
      flowName,
      path: doc.path,
      chatId: doc.chatId,
      error,
      ctx,
    });
    if (recovery !== undefined && recovery !== null) {
      // recovery runs in the same context but is not persisted as flow progress
      await this.runNode(normalize(recovery as never), doc.path, doc, ctx);
    }
  }

  private async runValidation(
    node: PromptStep,
    ctx: FlowContext,
    message: IncomingMessage,
    defaultValue: unknown,
  ): Promise<unknown> {
    const validate = node.validate!;
    if (typeof validate === "function") {
      const result = await validate(ctx, message);
      // a function validator returning undefined keeps the default value
      return result === undefined ? defaultValue : result;
    }
    const outcome = (await validate["~standard"].validate(defaultValue)) as {
      issues?: { message: string }[];
      value?: unknown;
    };
    if (outcome.issues?.length) {
      throw new ValidationError(outcome.issues[0]!.message);
    }
    return outcome.value;
  }

  /**
   * Resolve doc.path into effective nodes, expanding dynamic steps by re-invoking
   * them (§4.1 contract). nodes[i] is the node at doc.path.slice(0, i).
   */
  private async materialize(def: FlowDef, doc: FlowStateDoc, ctx: FlowContext): Promise<Step[]> {
    let cur = await this.expandDynamic(def.root, [], doc, ctx, "resume");
    const nodes: Step[] = [cur];
    for (let depth = 0; depth < doc.path.length; depth++) {
      const segment = doc.path[depth]!;
      const child = childrenOf(cur)[segment];
      if (!child) {
        throw new Error(
          `Flow '${def.name}' path [${doc.path.join(",")}] no longer resolves (tree changed?)`,
        );
      }
      cur = await this.expandDynamic(child, doc.path.slice(0, depth + 1), doc, ctx, "resume");
      nodes.push(cur);
    }
    return nodes;
  }

  /**
   * Replace a dynamic node by its returned subtree, grafted at the same path.
   * On resume, the subtree's structural hash must match the one recorded at
   * suspend time — the determinism contract of §4.1.
   */
  private async expandDynamic(
    node: Step,
    prefix: number[],
    doc: FlowStateDoc,
    ctx: FlowContext,
    phase: "run" | "resume",
  ): Promise<Step> {
    let depth = 0;
    while (node.kind === "dynamic") {
      if (++depth > 32) {
        throw new Error(
          `Dynamic step at [${prefix.join(".")}] in flow '${doc.flowName}' expanded more than 32 ` +
            `levels deep — a dynamic step is probably returning another function in a loop`,
        );
      }
      const result = await node.fn(ctx as never);
      if (result === undefined || result === null) {
        node = { kind: "noop" };
        break;
      }
      const subtree = normalize(result as never);
      const key = prefix.join(".");
      const hash = structuralHash(subtree);
      doc.dynamicHashes ??= {};
      const expected = doc.dynamicHashes[key];
      if (phase === "resume" && expected !== undefined && expected !== hash) {
        throw new Error(
          `Dynamic step at [${key}] in flow '${doc.flowName}' changed shape between suspend and resume — ` +
            `refusing to resume into the wrong step (recorded ${expected}, got ${hash})`,
        );
      }
      doc.dynamicHashes[key] = hash;
      node = subtree;
    }
    return node;
  }

  /**
   * Continue execution after the node at doc.path, walking back up the
   * materialized spine. Crossing a callFlow boundary pops its frame; a
   * ReturnSignal from a child unwinds straight to the nearest callFlow ancestor.
   */
  private async continueAfter(
    nodes: Step[],
    doc: FlowStateDoc,
    ctx: FlowContext,
    runFirst?: { node: Step; path: number[] },
  ): Promise<RunResult> {
    let path = [...doc.path];
    let depth = path.length;
    let unwindingReturn = false;
    let returnValue: unknown;

    const runChild = async (node: Step, childPath: number[]): Promise<RunResult | "returned"> => {
      try {
        return await this.runNode(node, childPath, doc, ctx);
      } catch (error) {
        if (error instanceof ReturnSignal) {
          unwindingReturn = true;
          returnValue = error.value;
          return "returned";
        }
        throw error;
      }
    };

    if (runFirst) {
      const result = await runChild(runFirst.node, runFirst.path);
      if (result === "suspended") return "suspended";
    }

    while (depth > 0) {
      const parent = nodes[depth - 1]!;
      const index = path[depth - 1]!;

      if (unwindingReturn) {
        if (parent.kind === "callflow") {
          this.popFrame(doc, ctx, returnValue);
          unwindingReturn = false;
          returnValue = undefined;
          await this.persist(doc);
        }
        path = path.slice(0, depth - 1);
        depth--;
        continue;
      }

      if (parent.kind === "steps") {
        for (let i = index + 1; i < parent.children.length; i++) {
          const childPath = [...path.slice(0, depth - 1), i];
          doc.path = childPath;
          await this.persist(doc);
          const result = await runChild(parent.children[i]!, childPath);
          if (result === "suspended") return "suspended";
          if (result === "returned") break; // start unwinding from this level
        }
      } else if (parent.kind === "callflow") {
        // subflow body completed without ret — pop with undefined
        this.popFrame(doc, ctx, undefined);
        await this.persist(doc);
      }
      // prompt parents (button child done), branch and callcc parents: nothing further
      path = path.slice(0, depth - 1);
      depth--;
    }

    if (unwindingReturn) {
      throw new Error(
        `ret() outside of a subflow (no enclosing callFlow) in flow '${doc.flowName}'`,
      );
    }
    doc.status = "done";
    await this.persist(doc);
    return "done";
  }

  private async runNode(
    node: Step,
    path: number[],
    doc: FlowStateDoc,
    ctx: FlowContext,
  ): Promise<RunResult> {
    switch (node.kind) {
      case "steps": {
        for (let i = 0; i < node.children.length; i++) {
          const childPath = [...path, i];
          doc.path = childPath;
          await this.persist(doc);
          const result = await this.runNode(node.children[i]!, childPath, doc, ctx);
          if (result === "suspended") return "suspended";
        }
        return "done";
      }
      case "send": {
        await this.execSend(node, doc, ctx);
        return "done";
      }
      case "forward": {
        if (!ctx.api.forwardMessage) throw new Error("BotApi.forwardMessage not implemented");
        const messageId =
          typeof node.messageId === "number"
            ? node.messageId
            : (ctx.store[node.messageId.fromStore] as number);
        const msg = await ctx.api.forwardMessage(
          node.toChatId,
          node.fromChatId ?? ctx.chatId,
          messageId,
        );
        ctx.botMessage = msg;
        return "done";
      }
      case "pin": {
        const messageId = this.resolvePinTarget(node.target, doc, ctx);
        if (messageId === undefined) throw new Error("pin: no message to pin");
        const can = await this.canPin(ctx.chatId);
        if (!can.canPin) {
          await ctx.api.sendMessage(
            ctx.chatId,
            `Failed to pin message. Please update ${can.reason} permissions.`,
          );
          return "done";
        }
        if (!ctx.api.pinChatMessage) throw new Error("BotApi.pinChatMessage not implemented");
        await ctx.api.pinChatMessage(
          ctx.chatId,
          messageId,
          node.disableNotification === undefined
            ? undefined
            : { disable_notification: node.disableNotification },
        );
        return "done";
      }
      case "unpin": {
        const messageId = this.resolvePinTarget(node.target, doc, ctx);
        if (messageId === undefined) throw new Error("unpin: no message to unpin");
        if (!ctx.api.unpinChatMessage) throw new Error("BotApi.unpinChatMessage not implemented");
        await ctx.api.unpinChatMessage(ctx.chatId, messageId);
        return "done";
      }
      case "set": {
        ctx.store[node.key] = node.value;
        return "done";
      }
      case "noop":
        return "done";
      case "dynamic": {
        const subtree = await this.expandDynamic(node, path, doc, ctx, "run");
        return this.runNode(subtree, path, doc, ctx);
      }
      case "branch": {
        const [ifTrue, ifFalse, onError] = node.children;
        let cond: boolean;
        try {
          cond = await node.cond(ctx);
        } catch (error) {
          if (!onError) throw error;
          doc.path = [...path, 2];
          await this.persist(doc);
          return this.runNode(onError, [...path, 2], doc, ctx);
        }
        const arm = cond ? ifTrue : ifFalse;
        const armIndex = cond ? 0 : 1;
        if (!arm) return "done"; // missing false arm = no-op
        doc.path = [...path, armIndex];
        await this.persist(doc);
        return this.runNode(arm, [...path, armIndex], doc, ctx);
      }
      case "prompt":
        return this.suspendAtPrompt(node, path, doc, ctx);
      case "multiselect":
        return this.suspendAtMultiSelect(node, path, doc, ctx);
      case "callflow": {
        const args =
          typeof node.args === "function" ? await node.args(ctx) : structuredClone(node.args ?? {});
        const frame: Frame = {
          returnPath: [...path],
          store: doc.store,
          ...(node.storeResult === undefined ? {} : { storeResult: node.storeResult }),
        };
        doc.frames.push(frame);
        const subStore = { ...args };
        doc.store = subStore;
        ctx.store = subStore;
        await this.persist(doc);
        let result: RunResult;
        try {
          result = await this.runNode(node.children[0]!, [...path, 0], doc, ctx);
        } catch (error) {
          if (error instanceof ReturnSignal) {
            this.popFrame(doc, ctx, error.value);
            await this.persist(doc);
            return "done";
          }
          throw error;
        }
        if (result === "suspended") return "suspended";
        this.popFrame(doc, ctx, undefined);
        await this.persist(doc);
        return "done";
      }
      case "return": {
        const value = node.fromStore !== undefined ? ctx.store[node.fromStore] : node.value;
        throw new ReturnSignal(value);
      }
      case "storecc": {
        doc.savedCC[node.key] = { path: [...path], frames: structuredClone(doc.frames) };
        await this.persist(doc);
        return "done";
      }
      case "callcc": {
        doc.savedCC[node.key] = { path: [...path], frames: structuredClone(doc.frames) };
        await this.persist(doc);
        return this.runNode(node.children[0]!, [...path, 0], doc, ctx);
      }
      case "redirectcc": {
        const saved = doc.savedCC[node.key];
        if (!saved) {
          throw new Error(`No saved continuation under '${node.key}' — storeCC/callCC it first`);
        }
        doc.path = [...saved.path];
        doc.frames = structuredClone(saved.frames);
        // the store is intentionally NOT restored: it stays live across continuation jumps
        await this.persist(doc);
        throw new JumpSignal();
      }
      case "sleep": {
        const delaySecs = node.humanize ? humanDelay(node.seconds) : node.seconds;
        if (delaySecs >= this.timerThresholdSecs) {
          doc.path = path;
          doc.status = "timer";
          doc.wakeAt = this.now() + delaySecs * 1000;
          await this.persist(doc);
          return "suspended";
        }
        await this.sleepFn(delaySecs * 1000);
        return "done";
      }
      case "wait": {
        if (doc.timerDeadline === undefined) {
          doc.timerDeadline = this.now() + node.timeoutSecs * 1000;
        }
        if (await node.check(ctx)) {
          delete doc.timerDeadline;
          delete doc.wakeAt;
          return "done";
        }
        if (this.now() >= doc.timerDeadline) {
          delete doc.timerDeadline;
          delete doc.wakeAt;
          const onTimeout = node.children[0];
          if (!onTimeout) return "done";
          doc.path = [...path, 0];
          await this.persist(doc);
          return this.runNode(onTimeout, [...path, 0], doc, ctx);
        }
        doc.path = path;
        doc.status = "timer";
        doc.wakeAt = this.now() + node.everySecs * 1000;
        await this.persist(doc);
        return "suspended";
      }
    }
  }

  /**
   * Suspend ordering per §4.4: persist waiting state, register waiters, THEN send
   * the prompt message, then record its id. A crash between any two leaves a
   * recoverable doc, never a stuck user.
   */
  private async suspendAtPrompt(
    node: PromptStep,
    path: number[],
    doc: FlowStateDoc,
    ctx: FlowContext,
  ): Promise<"suspended"> {
    const hasButtons = node.layout.length > 0;
    const cbToken = hasButtons ? crypto.randomUUID() : undefined;

    const fromUserId = node.onlyFrom === "initiator" ? doc.meta.fromUserId : node.onlyFrom;
    doc.path = path;
    doc.status = "waiting";
    doc.waiting = {
      kind: hasButtons ? (node.mode === "buttons" ? "button" : "either") : "reply",
      ...(cbToken === undefined ? {} : { cbToken }),
      ...(fromUserId === undefined ? {} : { fromUserId }),
    };
    if (node.timeoutSecs !== undefined) doc.wakeAt = this.now() + node.timeoutSecs * 1000;
    else delete doc.wakeAt;
    await this.persist(doc);

    await this.storage.putWaiter(`chat:${doc.chatId}`, doc.id);
    if (cbToken) await this.storage.putWaiter(`cb:${cbToken}`, doc.id);

    const replyMarkup = hasButtons ? this.buildPromptMarkup(node, cbToken!, undefined) : undefined;

    const msg = await this.renderPrompt(node, doc, ctx, replyMarkup);
    ctx.cycle?.add({ kind: "prompt", text: node.text });
    ctx.botMessage = msg;
    doc.meta.lastBotMessage = msg;
    doc.waiting.promptMessageId = msg.message_id;
    await this.persist(doc);
    return "suspended";
  }

  /**
   * Deliver a prompt/multiselect message: menu mode (reuseMessage) edits the
   * flow's previous bot message in place, falling back to a fresh send.
   */
  private async renderPrompt(
    node: PromptStep | MultiSelectStep,
    doc: FlowStateDoc,
    ctx: FlowContext,
    replyMarkup: unknown,
  ): Promise<SentMessageLike> {
    const opts: Record<string, unknown> = {
      ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
      ...(node.parseMode === undefined ? {} : { parse_mode: node.parseMode }),
    };
    const reuseId = node.reuseMessage
      ? (doc.meta.lastBotMessage as SentMessageLike | undefined)?.message_id
      : undefined;
    if (reuseId !== undefined && ctx.api.editMessageText) {
      try {
        await ctx.api.editMessageText(
          doc.chatId,
          reuseId,
          node.text,
          Object.keys(opts).length > 0 ? opts : undefined,
        );
        return { message_id: reuseId };
      } catch {
        // the message may be gone or identical — fall through to a fresh send
      }
    }
    return ctx.api.sendMessage(
      doc.chatId,
      node.text,
      Object.keys(opts).length > 0 ? opts : undefined,
    );
  }

  /** Same suspend ordering as prompts; selection scratch state lives in waiting.multiSelect. */
  private async suspendAtMultiSelect(
    node: MultiSelectStep,
    path: number[],
    doc: FlowStateDoc,
    ctx: FlowContext,
  ): Promise<"suspended"> {
    const cbToken = crypto.randomUUID();
    const selected = structuredClone(node.preSelected ?? []);
    const fromUserId = node.onlyFrom === "initiator" ? doc.meta.fromUserId : node.onlyFrom;

    doc.path = path;
    doc.status = "waiting";
    doc.waiting = {
      kind: "button",
      cbToken,
      multiSelect: { selected },
      ...(fromUserId === undefined ? {} : { fromUserId }),
    };
    if (node.timeoutSecs !== undefined) doc.wakeAt = this.now() + node.timeoutSecs * 1000;
    else delete doc.wakeAt;
    await this.persist(doc);

    await this.storage.putWaiter(`chat:${doc.chatId}`, doc.id);
    await this.storage.putWaiter(`cb:${cbToken}`, doc.id);

    const msg = await this.renderPrompt(
      node,
      doc,
      ctx,
      this.buildMultiSelectMarkup(node, cbToken, selected),
    );
    ctx.cycle?.add({ kind: "prompt", text: node.text });
    ctx.botMessage = msg;
    doc.meta.lastBotMessage = msg;
    doc.waiting.promptMessageId = msg.message_id;
    await this.persist(doc);
    return "suspended";
  }

  private buildPromptMarkup(
    node: PromptStep,
    cbToken: string,
    buttonLabels: Record<string, string> | undefined,
  ): { inline_keyboard: { text: string; callback_data: string }[][] } {
    return {
      inline_keyboard: node.layout.map((row) =>
        row.map((b) => ({
          text: buttonLabels?.[String(b.childIndex)] ?? b.text,
          callback_data: `fx:${cbToken}:${b.childIndex}`,
        })),
      ),
    };
  }

  private buildMultiSelectMarkup(
    node: MultiSelectStep,
    cbToken: string,
    selected: unknown[],
  ): { inline_keyboard: { text: string; callback_data: string }[][] } {
    const isSelected = (value: unknown): boolean =>
      selected.some((v) => JSON.stringify(v) === JSON.stringify(value));
    const rows = node.labels.map((label, i) => [
      {
        text: isSelected(node.values[i]) ? `✅ ${label}` : label,
        callback_data: `fx:${cbToken}:t${i}`,
      },
    ]);
    rows.push([{ text: node.submitText, callback_data: `fx:${cbToken}:s` }]);
    for (const row of node.extraLayout) {
      rows.push(row.map((b) => ({ text: b.text, callback_data: `fx:${cbToken}:${b.childIndex}` })));
    }
    return { inline_keyboard: rows };
  }

  // ---- flow handles, introspection & GC ----

  /** In-flight conversations (anything not done), for admin commands and ops. */
  async listActive(q?: { chatId?: number }): Promise<ActiveFlowInfo[]> {
    const docs = await this.storage.listFlowStates({
      botId: this.botId,
      ...(q?.chatId === undefined ? {} : { chatId: q.chatId }),
    });
    return docs
      .filter((d) => d.status !== "done")
      .map((d) => ({
        id: d.id,
        chatId: d.chatId,
        flowName: d.flowName,
        status: d.status as ActiveFlowInfo["status"],
        path: d.path,
        ...(d.waiting?.kind === undefined ? {} : { waitingKind: d.waiting.kind }),
        startedAt: d.meta.startedAt,
        updatedAt: d.meta.updatedAt,
      }));
  }

  /** Live handle over a suspended conversation: edit its prompt, relabel buttons, terminate. */
  async getFlowHandle(id: string): Promise<FlowHandle | null> {
    const exists = await this.storage.getFlowState(id);
    if (!exists) return null;

    const withPrompt = async (
      fn: (doc: FlowStateDoc, node: Step, ctx: FlowContext) => Promise<void>,
    ): Promise<void> => {
      await this.queue.run(exists.chatId, async () => {
        const doc = await this.storage.getFlowState(id);
        if (!doc || doc.status !== "waiting") return;
        const def = this.registry.get(doc.flowName);
        if (!def) return;
        const ctx = this.buildCtx(doc, undefined);
        const nodes = await this.materialize(def, doc, ctx);
        await fn(doc, nodes.at(-1)!, ctx);
      });
    };

    const currentMarkup = (doc: FlowStateDoc, node: Step): unknown => {
      const token = doc.waiting?.cbToken;
      if (!token) return undefined;
      if (node.kind === "prompt" && node.layout.length > 0) {
        return this.buildPromptMarkup(node, token, doc.waiting?.buttonLabels);
      }
      if (node.kind === "multiselect") {
        return this.buildMultiSelectMarkup(node, token, doc.waiting?.multiSelect?.selected ?? []);
      }
      return undefined;
    };

    return {
      id,
      chatId: exists.chatId,
      flowName: exists.flowName,

      editText: async (newText: string) => {
        await withPrompt(async (doc, node) => {
          if (doc.waiting?.promptMessageId === undefined || !this.api.editMessageText) return;
          const markup = currentMarkup(doc, node);
          const parseMode =
            node.kind === "prompt" || node.kind === "multiselect" ? node.parseMode : undefined;
          const editOpts: Record<string, unknown> = {
            ...(markup === undefined ? {} : { reply_markup: markup }),
            ...(parseMode === undefined ? {} : { parse_mode: parseMode }),
          };
          await this.api.editMessageText(
            doc.chatId,
            doc.waiting.promptMessageId,
            newText,
            Object.keys(editOpts).length > 0 ? editOpts : undefined,
          );
        });
      },

      editButtonText: async (newText: string, buttonIndex: number) => {
        await withPrompt(async (doc, node) => {
          if (node.kind !== "prompt") throw new Error("editButtonText: not a button prompt");
          doc.waiting!.buttonLabels = {
            ...doc.waiting!.buttonLabels,
            [String(buttonIndex)]: newText,
          };
          await this.persist(doc);
          if (doc.waiting?.promptMessageId === undefined || !this.api.editMessageText) return;
          await this.api.editMessageText(doc.chatId, doc.waiting.promptMessageId, node.text, {
            reply_markup: currentMarkup(doc, node),
            ...(node.parseMode === undefined ? {} : { parse_mode: node.parseMode }),
          });
        });
      },

      terminate: async (opts?: { continueNextSteps?: boolean }) => {
        await this.queue.run(exists.chatId, async () => {
          const doc = await this.storage.getFlowState(id);
          if (!doc) return;
          await this.releaseWaiters(doc);
          if (doc.waiting?.promptMessageId !== undefined && this.api.editMessageReplyMarkup) {
            try {
              await this.api.editMessageReplyMarkup(
                doc.chatId,
                doc.waiting.promptMessageId,
                undefined,
              );
            } catch {
              // best-effort keyboard strip
            }
          }
          if (!opts?.continueNextSteps) {
            await this.storage.deleteFlowStates([doc.id]);
            return;
          }
          const def = this.registry.get(doc.flowName);
          if (!def) return;
          const ctx = this.buildCtx(doc, undefined);
          try {
            const nodes = await this.materialize(def, doc, ctx);
            doc.waiting = null;
            doc.status = "running";
            delete doc.wakeAt;
            await this.persist(doc);
            await this.drive(def, doc, ctx, () => this.continueAfter(nodes, doc, ctx));
          } catch (error) {
            await this.handleFlowError(def.name, doc, ctx, error);
          }
        });
      },
    };
  }

  /** Delete flow states and their waiters (chat waiters only when owned by the doc). */
  async gcFlows(ids: string[]): Promise<void> {
    for (const id of ids) {
      const doc = await this.storage.getFlowState(id);
      if (doc) {
        await this.queue.run(doc.chatId, () => this.releaseWaiters(doc));
      }
    }
    await this.storage.deleteFlowStates(ids);
  }
}
