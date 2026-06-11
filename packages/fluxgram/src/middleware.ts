import type { FlowDef } from "./engine/registry";

/**
 * Flow-initiation middleware: runs before a flow's
 * context is created. Scopes: '*', 'initiate_flow', 'commands', 'command:/x',
 * 'message', or an array of those.
 */
export interface MiddlewareContext {
  flow: FlowDef;
  chatId: number;
  source: string;
  params: Record<string, unknown>;
  blocked: boolean;
  /** Silently prevent the flow from starting. */
  block(): void;
  /** Start a different flow instead. */
  replaceFlow(flow: FlowDef): void;
}

export type Middleware = (
  mw: MiddlewareContext,
  next: () => Promise<void>,
) => unknown | Promise<unknown>;

export type MiddlewareScope = string | string[];

export interface MiddlewareEntry {
  fn: Middleware;
  scope: MiddlewareScope;
}

export function scopeMatches(scope: MiddlewareScope, source: string): boolean {
  const scopes = Array.isArray(scope) ? scope : [scope];
  for (const s of scopes) {
    if (s === "*") return true;
    if (s === source) return true;
    if (s === "commands" && source.startsWith("command:")) return true;
  }
  return false;
}

/**
 * Run the chain in registration order. A middleware must
 * call next() to continue the chain; not calling it skips later middleware but
 * does NOT block the flow — only block() (or a thrown error) blocks.
 */
export async function runMiddlewareChain(
  entries: MiddlewareEntry[],
  source: string,
  chatId: number,
  flow: FlowDef,
  params: Record<string, unknown>,
): Promise<{ blocked: boolean; flow: FlowDef }> {
  const applicable = entries.filter((e) => scopeMatches(e.scope, source));
  const mw: MiddlewareContext = {
    flow,
    chatId,
    source,
    params,
    blocked: false,
    block() {
      this.blocked = true;
    },
    replaceFlow(next: FlowDef) {
      this.flow = next;
    },
  };

  const makeNext = (index: number): (() => Promise<void>) => {
    return async () => {
      if (index >= applicable.length || mw.blocked) return;
      try {
        await applicable[index]!.fn(mw, makeNext(index + 1));
      } catch {
        mw.blocked = true;
      }
    };
  };
  await makeNext(0)();

  return { blocked: mw.blocked, flow: mw.flow };
}
