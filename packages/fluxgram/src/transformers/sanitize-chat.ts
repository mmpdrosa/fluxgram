/**
 * grammY-compatible transformer that rewrites outgoing chat ids through the
 * persisted group-to-supergroup migration map.
 */

type ApiCaller = (
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

export function createSanitizeChat(resolve: (chatId: number) => number) {
  const fix = (value: unknown): unknown => (typeof value === "number" ? resolve(value) : value);

  return async function sanitizeChatTransformer(
    prev: ApiCaller,
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (payload?.["chat_id"] === undefined && payload?.["from_chat_id"] === undefined) {
      return prev(method, payload, signal);
    }
    const fixed = { ...payload };
    if (fixed["chat_id"] !== undefined) fixed["chat_id"] = fix(fixed["chat_id"]);
    if (fixed["from_chat_id"] !== undefined) fixed["from_chat_id"] = fix(fixed["from_chat_id"]);
    return prev(method, fixed, signal);
  };
}
