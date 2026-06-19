import {
  Engine,
  type EngineOptions,
  type FlowErrorHandler,
  type IncomingMessage,
  type VersionMismatchPolicy,
} from "../src/engine/executor";
import { FlowRegistry } from "../src/engine/registry";
import { MemoryStorage } from "../src/storage/memory";
import type { StepLike } from "../src/steps";

export interface SentMessage {
  chatId: number;
  text: string;
  message_id: number;
  replyMarkup?: unknown;
  opts?: Record<string, unknown>;
}

export interface MediaSent {
  kind: "photo" | "video" | "document";
  chatId: number;
  file: unknown;
  caption?: string;
  message_id?: number;
}

export interface ForwardRecord {
  fromChatId: number;
  toChatId: number;
  messageId: number;
}

export interface PinRecord {
  chatId: number;
  messageId: number;
}

export type SendHook = (req: {
  chatId: number;
  text: string;
  opts?: Record<string, unknown>;
}) => void;

export interface EditedMessage {
  chatId: number;
  messageId: number;
  text: string;
  replyMarkup?: unknown;
  opts?: Record<string, unknown>;
}

export interface CallbackAnswer {
  queryId: string;
  text?: string;
}

interface RegisteredFlow {
  name: string;
  root: StepLike;
  version?: number;
}

interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

function flattenLabels(markup: unknown): string[] {
  return (markup as InlineKeyboard).inline_keyboard.flat().map((b) => b.text);
}

/**
 * Runs flows against a fake Bot API with no network. `restart()` rebuilds the
 * engine/registry on the same storage to simulate a process restart — replies
 * and button clicks after it prove durable resume.
 */
export class TestHarness {
  readonly botId = 4242;
  readonly defaultChatId = 100;
  readonly sent: SentMessage[] = [];
  readonly edits: EditedMessage[] = [];
  readonly callbackAnswers: CallbackAnswer[] = [];
  readonly mediaSent: MediaSent[] = [];
  readonly forwards: ForwardRecord[] = [];
  readonly pins: PinRecord[] = [];
  readonly unpins: PinRecord[] = [];
  /** when false, the fake bot lacks pin permission in group chats */
  canPin = true;
  storage: MemoryStorage;
  private sendHook: SendHook | undefined;
  /** live keyboard state per message id (edits update it, like the real client) */
  private keyboards = new Map<number, { chatId: number; markup: unknown }>();
  /** last non-empty markup per message — stale clicks come from outdated client UI */
  private keyboardHistory = new Map<number, { chatId: number; markup: unknown }>();
  private lastMarkup: unknown;

  private declarations: RegisteredFlow[] = [];
  private registry!: FlowRegistry;
  private engine!: Engine;
  private nextMessageId = 1;
  private nextQueryId = 1;
  private lastStore: Record<string, unknown> = {};
  private onFlowError: FlowErrorHandler | undefined;
  private versionMismatch: VersionMismatchPolicy | undefined;
  private sinks: EngineOptions["sinks"];
  private validateStoreJson: boolean | undefined;
  private clockTime = 1_000_000_000;

  /** Deterministic fake clock driving the engine's now(); advance to fire timers via sweep(). */
  readonly clock = {
    now: (): number => this.clockTime,
    advance: (ms: number): void => {
      this.clockTime += ms;
    },
  };

  static create(opts?: {
    storage?: MemoryStorage;
    onFlowError?: FlowErrorHandler;
    versionMismatch?: VersionMismatchPolicy;
    sinks?: EngineOptions["sinks"];
    validateStoreJson?: boolean;
  }): TestHarness {
    return new TestHarness(opts);
  }

  private constructor(opts?: {
    storage?: MemoryStorage;
    onFlowError?: FlowErrorHandler;
    versionMismatch?: VersionMismatchPolicy;
    sinks?: EngineOptions["sinks"];
    validateStoreJson?: boolean;
  }) {
    this.storage = opts?.storage ?? new MemoryStorage();
    this.onFlowError = opts?.onFlowError;
    this.versionMismatch = opts?.versionMismatch;
    this.sinks = opts?.sinks;
    this.validateStoreJson = opts?.validateStoreJson;
    this.build();
  }

  private build(): void {
    this.registry = new FlowRegistry();
    for (const decl of this.declarations) {
      this.registry.register(
        decl.name,
        decl.root,
        decl.version === undefined ? undefined : { version: decl.version },
      );
    }
    this.engine = new Engine({
      botId: this.botId,
      registry: this.registry,
      storage: this.storage,
      interChunkDelayMs: 0,
      api: {
        sendMessage: async (chatId, text, opts) => {
          this.sendHook?.({ chatId, text, ...(opts === undefined ? {} : { opts }) });
          const msg = { message_id: this.nextMessageId++, chat: { id: chatId }, text };
          const markup = opts?.["reply_markup"];
          if (markup !== undefined) {
            this.keyboards.set(msg.message_id, { chatId, markup });
            this.keyboardHistory.set(msg.message_id, { chatId, markup });
            this.lastMarkup = markup;
          }
          this.sent.push({
            chatId,
            text,
            message_id: msg.message_id,
            ...(markup === undefined ? {} : { replyMarkup: markup }),
            ...(opts === undefined ? {} : { opts }),
          });
          return msg;
        },
        sendPhoto: async (chatId, file, opts) => this.recordMedia("photo", chatId, file, opts),
        sendVideo: async (chatId, file, opts) => this.recordMedia("video", chatId, file, opts),
        sendDocument: async (chatId, file, opts) =>
          this.recordMedia("document", chatId, file, opts),
        forwardMessage: async (toChatId, fromChatId, messageId) => {
          this.forwards.push({ fromChatId, toChatId, messageId });
          return { message_id: this.nextMessageId++, chat: { id: toChatId } };
        },
        pinChatMessage: async (chatId, messageId) => {
          this.pins.push({ chatId, messageId });
        },
        unpinChatMessage: async (chatId, messageId) => {
          this.unpins.push({ chatId, messageId });
        },
        getChat: async () => ({ permissions: { can_pin_messages: true } }),
        getChatMember: async () => ({
          status: this.canPin ? "administrator" : "member",
          can_pin_messages: this.canPin,
        }),
        editMessageText: async (chatId, messageId, text, opts) => {
          const markup = opts?.["reply_markup"];
          if (markup === undefined) this.keyboards.delete(messageId);
          else {
            this.keyboards.set(messageId, { chatId, markup });
            this.keyboardHistory.set(messageId, { chatId, markup });
            this.lastMarkup = markup;
          }
          this.edits.push({
            chatId,
            messageId,
            text,
            ...(markup === undefined ? {} : { replyMarkup: markup }),
            ...(opts === undefined ? {} : { opts }),
          });
          return true;
        },
        editMessageReplyMarkup: async (chatId, messageId, markup) => {
          if (markup === undefined) this.keyboards.delete(messageId);
          else {
            this.keyboards.set(messageId, { chatId, markup });
            this.keyboardHistory.set(messageId, { chatId, markup });
            this.lastMarkup = markup;
          }
          return true;
        },
        answerCallbackQuery: async (queryId, opts) => {
          this.callbackAnswers.push({
            queryId,
            ...(opts?.text === undefined ? {} : { text: opts.text }),
          });
          return true;
        },
      },
      ...(this.onFlowError ? { onFlowError: this.onFlowError } : {}),
      ...(this.versionMismatch ? { versionMismatch: this.versionMismatch } : {}),
      ...(this.sinks ? { sinks: this.sinks } : {}),
      ...(this.validateStoreJson === undefined
        ? {}
        : { validateStoreJson: this.validateStoreJson }),
      now: () => this.clockTime,
    });
  }

  /** Run the engine's recovery sweep (due timers, crashed docs, unsent prompts). */
  async sweep(): Promise<void> {
    await this.engine.sweep();
  }

  /** Install a hook that runs before every fake sendMessage; throw from it to simulate API errors. */
  onSend(hook: SendHook | undefined): void {
    this.sendHook = hook;
  }

  private recordMedia(
    kind: MediaSent["kind"],
    chatId: number,
    file: unknown,
    opts?: Record<string, unknown>,
  ): { message_id: number; chat: { id: number } } {
    const messageId = this.nextMessageId++;
    this.mediaSent.push({
      kind,
      chatId,
      file,
      ...(opts?.["caption"] === undefined ? {} : { caption: opts["caption"] as string }),
    });
    return { message_id: messageId, chat: { id: chatId } };
  }

  /** Replace a flow's definition and rebuild the engine — simulates a deploy. */
  redefine(name: string, root: StepLike, opts?: { version?: number }): void {
    const decl: RegisteredFlow = {
      name,
      root,
      ...(opts?.version === undefined ? {} : { version: opts.version }),
    };
    const index = this.declarations.findIndex((d) => d.name === name);
    if (index === -1) {
      this.declarations.push(decl);
    } else {
      this.declarations[index] = decl;
    }
    this.build();
  }

  register(name: string, root: StepLike, opts?: { version?: number }): void {
    this.declarations.push({
      name,
      root,
      ...(opts?.version === undefined ? {} : { version: opts.version }),
    });
    this.registry.register(name, root, opts);
  }

  async initiateFlow(
    name: string,
    opts?: { chatId?: number; store?: Record<string, unknown>; fromUserId?: number },
  ): Promise<void> {
    const store = { ...opts?.store };
    this.lastStore = store;
    const chatId = opts?.chatId ?? this.defaultChatId;
    await this.engine.initiateFlow(name, chatId, {
      store,
      ...(opts?.fromUserId === undefined
        ? {}
        : {
            startMessage: {
              message_id: this.nextMessageId++,
              chat: { id: chatId },
              from: { id: opts.fromUserId },
            },
          }),
    });
  }

  /** Simulate the user sending a text message. */
  async sendUser(
    text: string,
    opts?: { chatId?: number; fromUserId?: number },
  ): Promise<"handled" | "unhandled"> {
    const chatId = opts?.chatId ?? this.defaultChatId;
    const message: IncomingMessage = {
      message_id: this.nextMessageId++,
      chat: { id: chatId },
      text,
      ...(opts?.fromUserId === undefined ? {} : { from: { id: opts.fromUserId } }),
    };
    return this.engine.handleMessage(chatId, message);
  }

  /** Simulate clicking an inline button by its current label (edits/toggles included). */
  async clickButton(
    label: string,
    opts?: { chatId?: number; fromUserId?: number },
  ): Promise<"handled" | "stale" | "forbidden" | "invalid"> {
    const chatId = opts?.chatId ?? this.defaultChatId;
    for (const source of [this.keyboards, this.keyboardHistory]) {
      const ids = [...source.keys()].sort((a, b) => b - a);
      for (const id of ids) {
        const entry = source.get(id)!;
        if (entry.chatId !== chatId) continue;
        const kb = entry.markup as InlineKeyboard;
        const button = kb.inline_keyboard.flat().find((b) => b.text === label);
        if (!button) continue;
        return this.engine.handleCallback(button.callback_data, {
          queryId: `q${this.nextQueryId++}`,
          ...(opts?.fromUserId === undefined ? {} : { fromUserId: opts.fromUserId }),
        });
      }
    }
    throw new Error(
      `No keyboard (live or stale) in chat ${chatId} has a button labeled '${label}'`,
    );
  }

  /** Labels of the most recently sent keyboard (current state). */
  keyboardLabels(): string[] {
    const ids = [...this.keyboards.keys()].sort((a, b) => b - a);
    const newest = ids[0];
    if (newest === undefined) throw new Error("No live keyboards");
    return flattenLabels(this.keyboards.get(newest)!.markup);
  }

  /** Labels after the most recent keyboard change (send or edit). */
  lastKeyboardLabels(): string[] {
    if (this.lastMarkup === undefined) throw new Error("No keyboard changes yet");
    return flattenLabels(this.lastMarkup);
  }

  async listActive(q?: { chatId?: number }): ReturnType<Engine["listActive"]> {
    return this.engine.listActive(q);
  }

  async getFlowHandle(id: string): ReturnType<Engine["getFlowHandle"]> {
    return this.engine.getFlowHandle(id);
  }

  async gcFlows(ids: string[]): Promise<void> {
    return this.engine.gcFlows(ids);
  }

  /** Store of the most recently initiated flow (live reference; stale after restart()). */
  get store(): Record<string, unknown> {
    return this.lastStore;
  }

  /** Store of the most recently updated flow state, read from storage (restart-safe). */
  async flowStore(): Promise<Record<string, unknown>> {
    const docs = await this.storage.listFlowStates({ botId: this.botId });
    if (docs.length === 0) throw new Error("No flow states in storage");
    docs.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt);
    return docs[0]!.store;
  }

  sentTexts(): string[] {
    return this.sent.map((s) => s.text);
  }

  async expectMessage(match: RegExp | string): Promise<SentMessage> {
    const found = this.sent.find((s) =>
      typeof match === "string" ? s.text.includes(match) : match.test(s.text),
    );
    if (!found) {
      throw new Error(
        `No sent message matching ${match}. Sent so far:\n${this.sent.map((s) => `- [${s.chatId}] ${s.text}`).join("\n") || "(nothing)"}`,
      );
    }
    return found;
  }

  /** Simulate a process restart: fresh registry + engine, same storage. */
  async restart(): Promise<void> {
    this.build();
  }
}
