import { createLogger } from "evlog";
import type { FlowEvent, ObservabilitySink } from "./events";

/** One JSON line per FlowEvent — pipe to anything. */
export function jsonSink(write: (line: string) => void = console.log): ObservabilitySink {
  return {
    handle(e: FlowEvent): void {
      write(JSON.stringify(e));
    },
  };
}

/** Default stdout sink: emits each FlowEvent as an evlog wide event. */
export function evlogSink(opts?: { service?: string }): ObservabilitySink {
  return {
    handle(e: FlowEvent): void {
      const log = createLogger({ service: opts?.service ?? "fluxgram" });
      log.set({
        chat: { id: e.chatId },
        ...(e.flow === undefined ? {} : { flow: e.flow }),
        trigger: e.trigger,
        outcome: e.outcome,
        actions: e.actions.map((a) => `${a.kind}${a.text === undefined ? "" : `: ${a.text}`}`),
        apiCalls: e.apiCalls,
        durationMs: e.durationMs,
        ...(e.error === undefined ? {} : { error: e.error }),
      });
      log.emit();
    },
  };
}
