import type { FlowStatus } from "../engine/state";

/**
 * One wide event per flow execution cycle (update arrival → suspend/completion/
 * error) — the unit of observability. Replaces scattered log
 * lines and its separate debug-chat queue: every sink consumes these.
 */

export type FlowTrigger = "initiate" | "reply" | "button" | "timer" | "sweep" | "event";

export interface FlowAction {
  ts: number;
  kind: string; // send | prompt | reply | button | toggle | submit | validation-failed | debug | exception
  text?: string;
  notify?: boolean;
  forwardMessageId?: number;
  uniqueKey?: string;
}

export interface FlowEvent {
  ts: number;
  level: "info" | "warn" | "error";
  botId: number;
  chatId: number;
  flow?: string;
  version?: number;
  trigger: FlowTrigger;
  path?: number[];
  actions: FlowAction[];
  outcome: "completed" | "suspended" | "error" | "dead-chat" | "blocked";
  durationMs: number;
  apiCalls: number;
  error?: { message: string; stack?: string };
  notify: boolean;
}

export interface ObservabilitySink {
  handle(e: FlowEvent): void | Promise<void>;
}

/** Accumulates one cycle's actions/counters; finish() produces the FlowEvent. */
export class CycleRecorder {
  readonly actions: FlowAction[] = [];
  apiCalls = 0;
  flow: string | undefined;
  version: number | undefined;
  path: number[] | undefined;
  trigger: FlowTrigger;

  private botId: number;
  private chatId: number;
  private now: () => number;
  private startTs: number;
  private errorInfo: { message: string; stack?: string } | undefined;
  private dead = false;

  constructor(info: { botId: number; chatId: number; trigger: FlowTrigger; now: () => number }) {
    this.botId = info.botId;
    this.chatId = info.chatId;
    this.trigger = info.trigger;
    this.now = info.now;
    this.startTs = info.now();
  }

  add(action: Omit<FlowAction, "ts">): void {
    this.actions.push({ ts: this.now(), ...action });
  }

  setError(error: unknown, dead: boolean): void {
    const message = String((error as Error)?.message ?? error);
    const stack = (error as Error)?.stack;
    this.errorInfo = { message, ...(stack === undefined ? {} : { stack }) };
    this.dead = dead;
    this.add({ kind: "exception", text: message, notify: true });
  }

  finish(docStatus?: FlowStatus): FlowEvent {
    const outcome: FlowEvent["outcome"] = this.errorInfo
      ? this.dead
        ? "dead-chat"
        : "error"
      : docStatus === "waiting" || docStatus === "timer"
        ? "suspended"
        : "completed";
    const notify =
      this.actions.some((a) => a.notify === true) || outcome === "error" || outcome === "dead-chat";
    return {
      ts: this.startTs,
      level: this.errorInfo ? "error" : notify ? "warn" : "info",
      botId: this.botId,
      chatId: this.chatId,
      ...(this.flow === undefined ? {} : { flow: this.flow }),
      ...(this.version === undefined ? {} : { version: this.version }),
      trigger: this.trigger,
      ...(this.path === undefined ? {} : { path: this.path }),
      actions: this.actions,
      outcome,
      durationMs: this.now() - this.startTs,
      apiCalls: this.apiCalls,
      ...(this.errorInfo === undefined ? {} : { error: this.errorInfo }),
      notify,
    };
  }
}
