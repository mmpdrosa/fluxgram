/**
 * Cross-process event system: external
 * processes publish; the bot process subscribes and runs registered handlers.
 *
 * Contract:
 * - publish() returns false when uniqueKey was already used (exactly-once).
 * - The bus delivers each event to the subscriber at least once; durable buses
 *   re-deliver events that were invoked but never resolved (crash recovery).
 * - oneAtATimeKey serialization is the subscriber's job (Fluxgram does it).
 */

export interface EventEnvelope {
  name: string;
  payload: Record<string, unknown>;
  uniqueKey?: string;
  oneAtATimeKey?: string;
}

export interface EventDoc extends EventEnvelope {
  id: string;
}

export interface EventBus {
  publish(e: EventEnvelope): Promise<boolean>;
  subscribe(handler: (e: EventDoc) => Promise<void>): void;
  destroy?(): Promise<void> | void;
}
