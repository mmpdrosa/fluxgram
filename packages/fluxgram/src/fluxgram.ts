import type { Bot } from "grammy";
import {
  Engine,
  type ActiveFlowInfo,
  type BotApi,
  type FlowErrorHandler,
  type FlowHandle,
  type IncomingMessage,
  type SentMessageLike,
  type VersionMismatchPolicy,
} from "./engine/executor";
import { FlowRegistry, type FlowDef } from "./engine/registry";
import type { StorageAdapter } from "./storage/adapter";
import type { StepLike } from "./steps";
import type { FlowSpec } from "./steps/typed";
import { createSanitizeChat } from "./transformers/sanitize-chat";
import { createThrottle, type ThrottleOptions } from "./transformers/throttle";
import {
  runMiddlewareChain,
  type Middleware,
  type MiddlewareEntry,
  type MiddlewareScope,
} from "./middleware";
import type { EventBus, EventDoc } from "./events/bus";
import type { ObservabilitySink } from "./observability/events";
import { isChatDead } from "./errors";

export interface FluxgramOptions {
  storage: StorageAdapter;
  /** cross-process event bus; handlers via fx.onEvent(), triggering via FluxgramClient */
  events?: EventBus;
  onFlowError?: FlowErrorHandler;
  /** called when an onEvent handler throws (default: console.error) */
  onEventError?: (error: unknown, e: EventDoc) => void;
  versionMismatch?: VersionMismatchPolicy;
  /** outbound rate limiting; true (default) = built-in limits, object = custom, false = off */
  throttle?: boolean | ThrottleOptions;
  /** wide-event consumers: evlogSink(), DebugChatSink, jsonSink(), custom */
  sinks?: ObservabilitySink[];
  /** reject non-JSON store values before persisting (default: on unless NODE_ENV=production) */
  validateStoreJson?: boolean;
  maxQueuedPerChat?: number;
  timerThresholdSecs?: number;
  runningGraceMs?: number;
  interChunkDelayMs?: number;
  /** completed docs are deleted by the sweep after this long (default 1h; Infinity = keep) */
  doneRetentionMs?: number;
  /** how often the recovery sweep runs once started (default 15s) */
  sweepIntervalMs?: number;
  now?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

type AnyMessage = IncomingMessage & {
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
};

interface CommandEntry {
  def: FlowDef;
  overrideActive: boolean;
}

interface CancelCommandOpts {
  /** sent after cancelling active conversations (default "Cancelled.") */
  text?: string;
  /** sent when there was nothing to cancel (default "Nothing to cancel.") */
  notActiveText?: string;
}

interface MessageHandlerEntry {
  regex?: RegExp;
  filter?: (msg: IncomingMessage) => boolean;
  def: FlowDef;
}

const MIGRATIONS_KV_KEY = "fluxgram:migrations";

/**
 * The bot-process orchestrator: wires the flow Engine into a grammY Bot —
 * update routing, commands/triggers, group lifecycle, chat migrations,
 * middleware, and the outbound transformers.
 */
export class Fluxgram {
  readonly engine: Engine;
  readonly registry = new FlowRegistry();

  private bot: Bot;
  private storage: StorageAdapter;
  private commandMap = new Map<string, CommandEntry>();
  private cancelCommands = new Map<string, Required<CancelCommandOpts>>();
  private messageHandlers: MessageHandlerEntry[] = [];
  private middleware: MiddlewareEntry[] = [];
  private addedToGroupFlows: FlowDef[] = [];
  private becameAdminFlows: FlowDef[] = [];
  private lostAdminFlows: FlowDef[] = [];
  private groupMigratedFlows: FlowDef[] = [];
  private botHandledCbs: ((msg: IncomingMessage) => void)[] = [];
  private botSentCbs: ((msg: SentMessageLike) => void)[] = [];
  private migrations = new Map<number, number>();
  private migrationsRev = new Map<number, number>();
  private sweepIntervalMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private api: BotApi;
  private events: EventBus | undefined;
  private eventHandlers = new Map<
    string,
    (payload: Record<string, unknown>, e: EventDoc) => unknown
  >();
  private eventChains = new Map<string, Promise<unknown>>();
  private onEventError: (error: unknown, e: EventDoc) => void;

  constructor(bot: Bot, opts: FluxgramOptions) {
    if (!bot.isInited()) {
      throw new Error(
        "Fluxgram needs the bot's identity: call `await bot.init()` before `new Fluxgram(bot, …)`, " +
          "or construct the Bot with `{ botInfo }`.",
      );
    }
    this.bot = bot;
    this.onEventError =
      opts.onEventError ??
      ((error, e) => console.error(`fluxgram event '${e.name}' failed:`, error));
    this.storage = opts.storage;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 15_000;
    this.api = this.makeApiAdapter();

    this.engine = new Engine({
      botId: bot.botInfo.id,
      registry: this.registry,
      storage: opts.storage,
      api: this.api,
      ...(opts.onFlowError ? { onFlowError: opts.onFlowError } : {}),
      ...(opts.versionMismatch ? { versionMismatch: opts.versionMismatch } : {}),
      ...(opts.timerThresholdSecs === undefined
        ? {}
        : { timerThresholdSecs: opts.timerThresholdSecs }),
      ...(opts.runningGraceMs === undefined ? {} : { runningGraceMs: opts.runningGraceMs }),
      ...(opts.interChunkDelayMs === undefined
        ? {}
        : { interChunkDelayMs: opts.interChunkDelayMs }),
      ...(opts.sinks === undefined ? {} : { sinks: opts.sinks }),
      ...(opts.validateStoreJson === undefined
        ? {}
        : { validateStoreJson: opts.validateStoreJson }),
      ...(opts.maxQueuedPerChat === undefined ? {} : { maxQueuedPerChat: opts.maxQueuedPerChat }),
      ...(opts.doneRetentionMs === undefined ? {} : { doneRetentionMs: opts.doneRetentionMs }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
      ...(opts.sleepFn === undefined ? {} : { sleepFn: opts.sleepFn }),
    });

    // outbound transformers (run before the network / any earlier-installed transformer)
    bot.api.config.use(createSanitizeChat((id) => this.resolveChatId(id)) as never);
    if (opts.throttle !== false) {
      bot.api.config.use(
        createThrottle(typeof opts.throttle === "object" ? opts.throttle : undefined) as never,
      );
    }

    this.wireHandlers();

    if (opts.events) {
      this.events = opts.events;
      this.registerBuiltinEvents();
      this.events.subscribe((e) => this.dispatchEvent(e));
    }
  }

  /** Register a handler for a named cross-process event. */
  onEvent(name: string, handler: (payload: Record<string, unknown>, e: EventDoc) => unknown): void {
    if (this.eventHandlers.has(name)) throw new Error(`Event '${name}' already has a handler`);
    this.eventHandlers.set(name, handler);
  }

  private registerBuiltinEvents(): void {
    this.onEvent("fluxgram:sendMessage", async (p) => {
      const { chatId, text, parseMode, clearWaiters } = p as {
        chatId: number;
        text: string;
        parseMode?: string;
        clearWaiters?: boolean;
      };
      const resolved = this.resolveChatId(chatId);
      if (clearWaiters) {
        const actives = await this.listActiveForChatAliases(resolved);
        await this.engine.gcFlows(actives.filter((a) => a.status === "waiting").map((a) => a.id));
      }
      await this.api.sendMessage(
        resolved,
        text,
        parseMode === undefined ? undefined : { parse_mode: parseMode },
      );
    });

    this.onEvent("fluxgram:initiateFlow", async (p) => {
      const { flowName, chatId, store } = p as {
        flowName: string;
        chatId: number;
        store?: Record<string, unknown>;
      };
      await this.initiateFlow(flowName, chatId, store === undefined ? undefined : { store });
    });
  }

  /** oneAtATimeKey events serialize per key; unknown names and handler errors resolve silently. */
  private async dispatchEvent(e: EventDoc): Promise<void> {
    const run = async (): Promise<void> => {
      const handler = this.eventHandlers.get(e.name);
      if (!handler) return;
      try {
        await handler(e.payload, e);
      } catch (error) {
        try {
          this.onEventError(error, e);
        } catch {
          // a broken error reporter must not break event dispatch
        }
      }
    };
    if (e.oneAtATimeKey === undefined) {
      await run();
      return;
    }
    const previous = this.eventChains.get(e.oneAtATimeKey) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.eventChains.set(e.oneAtATimeKey, next);
    await next;
    if (this.eventChains.get(e.oneAtATimeKey) === next) {
      this.eventChains.delete(e.oneAtATimeKey);
    }
  }

  /** Load persisted state (chat migrations) and run a recovery sweep. Call before handling updates. */
  async init(): Promise<void> {
    const stored = (await this.storage.kvGet(MIGRATIONS_KV_KEY)) as
      | Record<string, number>
      | undefined;
    if (stored) {
      for (const [oldId, newId] of Object.entries(stored)) {
        this.migrations.set(Number(oldId), newId);
        this.migrationsRev.set(newId, Number(oldId));
      }
    }
    await this.engine.sweep();
  }

  /** init() + start long polling + periodic recovery sweeps. */
  async start(): Promise<void> {
    await this.init();
    this.sweepTimer = setInterval(() => {
      void this.engine.sweep();
    }, this.sweepIntervalMs);
    await this.bot.start();
  }

  async stop(): Promise<void> {
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
    await this.bot.stop();
    await this.engine.drain();
  }

  // ---- registration API ----

  flow<S extends object = Record<string, unknown>>(spec: FlowSpec<S>): FlowDef<S>;
  flow<S extends object = Record<string, unknown>>(
    name: string,
    root: StepLike,
    opts?: { version?: number },
  ): FlowDef<S>;
  flow(specOrName: FlowSpec | string, root?: StepLike, opts?: { version?: number }): FlowDef {
    if (typeof specOrName === "string") {
      return this.registry.register(specOrName, root as StepLike, opts);
    }
    return this.registry.register(
      specOrName.name,
      specOrName.root,
      specOrName.version === undefined ? undefined : { version: specOrName.version },
    );
  }

  command(name: string, flow: FlowDef | string, opts?: { overrideActive?: boolean }): void {
    const def = typeof flow === "string" ? this.mustGet(flow) : flow;
    this.commandMap.set(name, { def, overrideActive: opts?.overrideActive ?? false });
  }

  commands(names: string[], flow: FlowDef | string, opts?: { overrideActive?: boolean }): void {
    for (const name of names) this.command(name, flow, opts);
  }

  /** Register a command that cancels the chat's active conversations and confirms. */
  cancelCommand(name: string, opts?: CancelCommandOpts): void {
    this.cancelCommands.set(name, {
      text: opts?.text ?? "Cancelled.",
      notActiveText: opts?.notActiveText ?? "Nothing to cancel.",
    });
  }

  onMessage(
    match: { regex?: RegExp; filter?: (msg: IncomingMessage) => boolean },
    flow: FlowDef | string,
  ): void {
    const def = typeof flow === "string" ? this.mustGet(flow) : flow;
    // strip g/y flags: they make .test() stateful (lastIndex) and skip messages
    const regex =
      match.regex && (match.regex.global || match.regex.sticky)
        ? new RegExp(match.regex.source, match.regex.flags.replace(/[gy]/g, ""))
        : match.regex;
    this.messageHandlers.push({
      ...(regex === undefined ? {} : { regex }),
      ...(match.filter === undefined ? {} : { filter: match.filter }),
      def,
    });
  }

  use(fn: Middleware, opts?: { scope?: MiddlewareScope }): void {
    this.middleware.push({ fn, scope: opts?.scope ?? "*" });
  }

  onAddedToGroup(flow: FlowDef | string): void {
    this.addedToGroupFlows.push(typeof flow === "string" ? this.mustGet(flow) : flow);
  }

  onBecameAdmin(flow: FlowDef | string): void {
    this.becameAdminFlows.push(typeof flow === "string" ? this.mustGet(flow) : flow);
  }

  onLostAdmin(flow: FlowDef | string): void {
    this.lostAdminFlows.push(typeof flow === "string" ? this.mustGet(flow) : flow);
  }

  onGroupMigrated(flow: FlowDef | string): void {
    this.groupMigratedFlows.push(typeof flow === "string" ? this.mustGet(flow) : flow);
  }

  onBotHandledMessage(cb: (msg: IncomingMessage) => void): void {
    this.botHandledCbs.push(cb);
  }

  onBotSentMessage(cb: (msg: SentMessageLike) => void): void {
    this.botSentCbs.push(cb);
  }

  // ---- runtime API ----

  async initiateFlow<S = Record<string, unknown>>(
    flow: FlowDef<S> | string,
    chatId: number,
    opts?: {
      store?: S extends object ? S : Record<string, unknown>;
      startMessage?: IncomingMessage;
    },
  ): Promise<void> {
    const def = typeof flow === "string" ? this.mustGet(flow) : flow;
    // the chain sees (and may mutate) the params that actually start the flow
    const params: { store?: Record<string, unknown>; startMessage?: IncomingMessage } = {
      ...(opts as { store?: Record<string, unknown>; startMessage?: IncomingMessage }),
    };
    const result = await runMiddlewareChain(
      this.middleware,
      "initiate_flow",
      chatId,
      def,
      params as Record<string, unknown>,
    );
    if (result.blocked) return;
    await this.engine.initiateFlow(result.flow.name, this.resolveChatId(chatId), params);
  }

  sanitizeChatId(chatId: number): number {
    return this.resolveChatId(chatId);
  }

  getOriginalChatId(chatId: number): number {
    return this.migrationsRev.get(chatId) ?? chatId;
  }

  async sweep(): Promise<void> {
    await this.engine.sweep();
  }

  async listActive(q?: { chatId?: number }): Promise<ActiveFlowInfo[]> {
    if (q?.chatId === undefined) return this.engine.listActive(q);
    return this.listActiveForChatAliases(q.chatId);
  }

  async getFlowHandle(id: string): Promise<FlowHandle | null> {
    return this.engine.getFlowHandle(id);
  }

  async gcFlows(ids: string[]): Promise<void> {
    return this.engine.gcFlows(ids);
  }

  /**
   * Send `text` to many chats through the throttled api. Dead chats (blocked,
   * deleted, …) are reported separately and their flow states cleaned up.
   */
  async broadcast(
    chatIds: number[],
    text: string,
    opts?: {
      parseMode?: string;
      /** called after each chat with (done, total) */
      onProgress?: (done: number, total: number) => void;
    },
  ): Promise<{ sent: number[]; dead: number[]; failed: { chatId: number; error: unknown }[] }> {
    const sent: number[] = [];
    const dead: number[] = [];
    const failed: { chatId: number; error: unknown }[] = [];

    for (let i = 0; i < chatIds.length; i++) {
      const chatId = this.resolveChatId(chatIds[i]!);
      try {
        await this.api.sendMessage(
          chatId,
          text,
          opts?.parseMode === undefined ? undefined : { parse_mode: opts.parseMode },
        );
        sent.push(chatIds[i]!);
      } catch (error) {
        if (isChatDead(error)) {
          dead.push(chatIds[i]!);
          const actives = await this.listActiveForChatAliases(chatIds[i]!);
          await this.engine.gcFlows(actives.map((a) => a.id));
        } else {
          failed.push({ chatId: chatIds[i]!, error });
        }
      }
      opts?.onProgress?.(i + 1, chatIds.length);
    }
    return { sent, dead, failed };
  }

  // ---- internals ----

  private mustGet(name: string): FlowDef {
    const def = this.registry.get(name);
    if (!def) throw new Error(`Flow '${name}' is not registered`);
    return def;
  }

  private resolveChatId(id: number): number {
    let cur = id;
    const seen = new Set<number>();
    while (this.migrations.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = this.migrations.get(cur)!;
    }
    return cur;
  }

  private chatAliases(chatId: number): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    const add = (id: number): void => {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    };
    const resolved = this.resolveChatId(chatId);
    add(chatId);
    add(resolved);
    let prev = this.migrationsRev.get(resolved);
    while (prev !== undefined && !seen.has(prev)) {
      add(prev);
      prev = this.migrationsRev.get(prev);
    }
    return out;
  }

  private async listActiveForChatAliases(chatId: number): Promise<ActiveFlowInfo[]> {
    const byId = new Map<string, ActiveFlowInfo>();
    for (const alias of this.chatAliases(chatId)) {
      for (const active of await this.engine.listActive({ chatId: alias })) {
        byId.set(active.id, active);
      }
    }
    return [...byId.values()];
  }

  /** Engine BotApi backed by grammY's raw API (every call goes through the transformers). */
  private makeApiAdapter(): BotApi {
    const raw = this.bot.api.raw as unknown as Record<
      string,
      (payload: Record<string, unknown>) => Promise<unknown>
    >;
    const sent = async (call: Promise<unknown>): Promise<SentMessageLike> => {
      const msg = (await call) as SentMessageLike;
      for (const cb of this.botSentCbs) cb(msg);
      return msg;
    };
    return {
      sendMessage: (chatId, text, opts) =>
        sent(raw["sendMessage"]!({ chat_id: chatId, text, ...opts })),
      editMessageText: (chatId, messageId, text, opts) =>
        raw["editMessageText"]!({ chat_id: chatId, message_id: messageId, text, ...opts }),
      answerCallbackQuery: (queryId, opts) =>
        raw["answerCallbackQuery"]!({ callback_query_id: queryId, ...opts }),
      sendPhoto: (chatId, file, opts) =>
        sent(raw["sendPhoto"]!({ chat_id: chatId, photo: file, ...opts })),
      sendVideo: (chatId, file, opts) =>
        sent(raw["sendVideo"]!({ chat_id: chatId, video: file, ...opts })),
      sendDocument: (chatId, file, opts) =>
        sent(raw["sendDocument"]!({ chat_id: chatId, document: file, ...opts })),
      forwardMessage: (toChatId, fromChatId, messageId) =>
        sent(
          raw["forwardMessage"]!({
            chat_id: toChatId,
            from_chat_id: fromChatId,
            message_id: messageId,
          }),
        ),
      pinChatMessage: (chatId, messageId, opts) =>
        raw["pinChatMessage"]!({ chat_id: chatId, message_id: messageId, ...opts }),
      unpinChatMessage: (chatId, messageId) =>
        raw["unpinChatMessage"]!({ chat_id: chatId, message_id: messageId }),
      getChat: (chatId) =>
        raw["getChat"]!({ chat_id: chatId }) as Promise<{
          permissions?: { can_pin_messages?: boolean };
        }>,
      getChatMember: (chatId, userId) =>
        raw["getChatMember"]!({ chat_id: chatId, user_id: userId }) as Promise<{
          status?: string;
          can_pin_messages?: boolean;
        }>,
      editMessageReplyMarkup: (chatId, messageId, markup) =>
        raw["editMessageReplyMarkup"]!({
          chat_id: chatId,
          message_id: messageId,
          ...(markup === undefined ? {} : { reply_markup: markup }),
        }),
    };
  }

  private wireHandlers(): void {
    this.bot.on("message", async (gctx) => {
      await this.handleIncomingMessage(gctx.message as unknown as AnyMessage);
    });

    this.bot.on("callback_query:data", async (gctx) => {
      const query = gctx.callbackQuery;
      if (!query.data.startsWith("fx:")) return;
      await this.engine.handleCallback(query.data, {
        queryId: query.id,
        fromUserId: query.from.id,
      });
    });

    this.bot.on("my_chat_member", async (gctx) => {
      const update = gctx.myChatMember;
      if (update.new_chat_member.user.id !== this.bot.botInfo.id) return;
      const oldStatus = update.old_chat_member.status;
      const newStatus = update.new_chat_member.status;
      const chatId = update.chat.id;

      const wasOut = oldStatus === "left" || oldStatus === "kicked";
      const isIn = newStatus !== "left" && newStatus !== "kicked";
      if (wasOut && isIn) {
        for (const def of this.addedToGroupFlows) await this.initiateFlow(def, chatId);
      }
      if (oldStatus !== "administrator" && newStatus === "administrator") {
        for (const def of this.becameAdminFlows) await this.initiateFlow(def, chatId);
      }
      if (oldStatus === "administrator" && newStatus === "member") {
        for (const def of this.lostAdminFlows) await this.initiateFlow(def, chatId);
      }
    });
  }

  private parseCommand(text: string | undefined): string | undefined {
    if (!text?.startsWith("/")) return undefined;
    const raw = text.slice(1).split(/\s/)[0]!;
    const [name, mention] = raw.split("@");
    if (mention && mention.toLowerCase() !== (this.bot.botInfo.username ?? "").toLowerCase()) {
      return undefined;
    }
    return name || undefined;
  }

  private fireBotHandled(msg: IncomingMessage): void {
    for (const cb of this.botHandledCbs) cb(msg);
  }

  private async recordMigration(oldId: number, newId: number): Promise<void> {
    if (this.migrations.get(oldId) === newId) return; // both service messages arrive — idempotent
    this.migrations.set(oldId, newId);
    this.migrationsRev.set(newId, oldId);
    await this.storage.kvSet(MIGRATIONS_KV_KEY, Object.fromEntries(this.migrations));
  }

  private async handleIncomingMessage(msg: AnyMessage): Promise<void> {
    // group → supergroup migrations
    if (msg.migrate_to_chat_id !== undefined) {
      await this.recordMigration(msg.chat.id, msg.migrate_to_chat_id);
      return;
    }
    if (msg.migrate_from_chat_id !== undefined) {
      await this.recordMigration(msg.migrate_from_chat_id, msg.chat.id);
      for (const def of this.groupMigratedFlows) await this.initiateFlow(def, msg.chat.id);
      return;
    }

    const cmd = this.parseCommand(msg.text);

    // 1. override commands pre-empt any waiting prompt
    if (cmd !== undefined) {
      const cancel = this.cancelCommands.get(cmd);
      if (cancel) {
        const actives = await this.listActiveForChatAliases(msg.chat.id);
        await this.engine.gcFlows(actives.map((a) => a.id));
        this.fireBotHandled(msg);
        await this.api.sendMessage(
          this.resolveChatId(msg.chat.id),
          actives.length > 0 ? cancel.text : cancel.notActiveText,
        );
        return;
      }
      const entry = this.commandMap.get(cmd);
      if (entry?.overrideActive) {
        const actives = await this.listActiveForChatAliases(msg.chat.id);
        await this.engine.gcFlows(actives.map((a) => a.id));
        this.fireBotHandled(msg);
        await this.startCommandFlow(entry, cmd, msg);
        return;
      }
    }

    // 2. waiter routing — while a prompt waits, everything (commands included) is its answer
    let result = await this.engine.handleMessage(msg.chat.id, msg);
    // the prompt may be suspended under a pre-migration chat id, any hops back
    const seen = new Set<number>([msg.chat.id]);
    let prev = this.migrationsRev.get(msg.chat.id);
    while (result === "unhandled" && prev !== undefined && !seen.has(prev)) {
      seen.add(prev);
      result = await this.engine.handleMessage(prev, msg);
      prev = this.migrationsRev.get(prev);
    }
    if (result === "handled") {
      this.fireBotHandled(msg);
      return;
    }

    // 3. commands
    if (cmd !== undefined) {
      const entry = this.commandMap.get(cmd);
      if (entry) {
        this.fireBotHandled(msg);
        await this.startCommandFlow(entry, cmd, msg);
        return;
      }
    }

    // 4. plain message triggers
    for (const handler of this.messageHandlers) {
      if (handler.regex && !(msg.text !== undefined && handler.regex.test(msg.text))) continue;
      if (handler.filter && !handler.filter(msg)) continue;
      this.fireBotHandled(msg);
      const params: Record<string, unknown> = { message: msg };
      const result2 = await runMiddlewareChain(
        this.middleware,
        "message",
        msg.chat.id,
        handler.def,
        params,
      );
      if (!result2.blocked) {
        await this.engine.initiateFlow(result2.flow.name, msg.chat.id, {
          startMessage: msg,
          ...(params["store"] === undefined
            ? {}
            : { store: params["store"] as Record<string, unknown> }),
        });
      }
      return;
    }
  }

  private async startCommandFlow(
    entry: CommandEntry,
    cmd: string,
    msg: IncomingMessage,
  ): Promise<void> {
    const params: Record<string, unknown> = { message: msg };
    const result = await runMiddlewareChain(
      this.middleware,
      `command:/${cmd}`,
      msg.chat.id,
      entry.def,
      params,
    );
    if (result.blocked) return;
    await this.engine.initiateFlow(result.flow.name, msg.chat.id, {
      startMessage: msg,
      ...(params["store"] === undefined
        ? {}
        : { store: params["store"] as Record<string, unknown> }),
    });
  }
}
