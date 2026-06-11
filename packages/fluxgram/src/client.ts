import type { EventBus } from "./events/bus";

/**
 * For processes that are NOT the bot (cron jobs, CLIs, web backends): trigger
 * events, send messages and start flows inside the bot via the event bus.
 * Provides cross-process event, message, and registered-flow helpers.
 */
export class FluxgramClient {
  private events: EventBus;

  constructor(opts: { events: EventBus }) {
    this.events = opts.events;
  }

  /** Returns false when uniqueKey was already used (event not re-triggered). */
  async emit(
    name: string,
    payload: Record<string, unknown> = {},
    opts?: { uniqueKey?: string; oneAtATimeKey?: string },
  ): Promise<boolean> {
    return this.events.publish({ name, payload, ...opts });
  }

  async sendMessage(
    chatId: number,
    text: string,
    opts?: { uniqueKey?: string; parseMode?: string; clearWaiters?: boolean },
  ): Promise<boolean> {
    const { uniqueKey, ...rest } = opts ?? {};
    return this.emit(
      "fluxgram:sendMessage",
      { chatId, text, ...rest },
      uniqueKey === undefined ? undefined : { uniqueKey },
    );
  }

  async initiateFlow(
    flowName: string,
    chatId: number,
    opts?: { store?: Record<string, unknown>; uniqueKey?: string },
  ): Promise<boolean> {
    return this.emit(
      "fluxgram:initiateFlow",
      { flowName, chatId, ...(opts?.store === undefined ? {} : { store: opts.store }) },
      opts?.uniqueKey === undefined ? undefined : { uniqueKey: opts.uniqueKey },
    );
  }
}
