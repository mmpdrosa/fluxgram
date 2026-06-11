/**
 * Outbound rate limiter using sliding windows for global and per-chat sends.
 * The official @grammyjs/transformer-throttler is deprecated; this replaces it.
 *
 * Telegram's documented limits: ~30 msg/s globally, ~1 msg/s per chat with
 * short bursts, 20 msg/min in groups. Defaults stay safely below them.
 */

export interface ThrottleOptions {
  /** [per 1s, per 5s, per 20s, per 60s] across all chats (default [25,100,300,500]) */
  global?: [number, number, number, number];
  /** [per 1s, per 5s, per 20s, per 60s] per chat (default [4,10,15,20]) */
  perChat?: [number, number, number, number];
  now?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

const WINDOWS_MS = [1_000, 5_000, 20_000, 60_000] as const;
const EXEMPT_METHODS = new Set(["getUpdates"]);

type ApiCaller = (
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

/** grammY-compatible transformer: createThrottle()(prev, method, payload, signal). */
export function createThrottle(opts?: ThrottleOptions) {
  const globalLimits = opts?.global ?? [25, 100, 300, 500];
  const perChatLimits = opts?.perChat ?? [4, 10, 15, 20];
  const now = opts?.now ?? (() => Date.now());
  const sleepFn = opts?.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const queues = new Map<string, number[]>();
  let lastEvict = 0;

  /** drop idle per-chat queues so the map doesn't grow with every chat ever seen */
  function evictIdle(ts: number): void {
    if (ts - lastEvict < WINDOWS_MS[WINDOWS_MS.length - 1]!) return;
    lastEvict = ts;
    const cutoff = ts - WINDOWS_MS[WINDOWS_MS.length - 1]!;
    for (const [key, queue] of queues) {
      if (key !== "global" && (queue.length === 0 || queue[queue.length - 1]! <= cutoff)) {
        queues.delete(key);
      }
    }
  }

  async function admit(key: string, limits: readonly number[]): Promise<void> {
    const queue = queues.get(key) ?? [];
    queues.set(key, queue);

    while (true) {
      const ts = now();
      let waitMs = 0;
      for (let w = 0; w < WINDOWS_MS.length; w++) {
        const windowStart = ts - WINDOWS_MS[w]!;
        const inWindow = queue.filter((t) => t > windowStart);
        if (inWindow.length >= limits[w]!) {
          // wait until the oldest call in this window slides out
          const oldest = inWindow[0]!;
          waitMs = Math.max(waitMs, oldest - windowStart + 1);
        }
      }
      if (waitMs === 0) break;
      await sleepFn(waitMs);
    }

    queue.push(now());
    // drop entries older than the largest window
    const cutoff = now() - WINDOWS_MS[WINDOWS_MS.length - 1]!;
    while (queue.length > 0 && queue[0]! <= cutoff) queue.shift();
  }

  return async function throttleTransformer(
    prev: ApiCaller,
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!EXEMPT_METHODS.has(method)) {
      evictIdle(now());
      await admit("global", globalLimits);
      const chatId = payload?.["chat_id"];
      if (chatId !== undefined && method.startsWith("send")) {
        await admit(`chat:${String(chatId)}`, perChatLimits);
      }
    }
    return prev(method, payload, signal);
  };
}
