/**
 * The one error type with flow-level meaning: thrown from a prompt validator,
 * it re-prompts the user with `message` and keeps the flow waiting.
 */
export class ValidationError extends Error {
  readonly ignoreMessage: boolean;

  constructor(message: string, opts?: { ignoreMessage?: boolean }) {
    super(message);
    this.name = "ValidationError";
    this.ignoreMessage = opts?.ignoreMessage ?? false;
  }
}

/** Telegram error descriptions meaning the chat is gone for good. */
const DEAD_CHAT_PATTERNS = [
  "bot was kicked",
  "chat not found",
  "bot was blocked",
  "bot blocked by",
  "group chat was deleted",
  "group is deactivated",
  "user is deactivated",
  "bot can't send messages",
];

/**
 * True when the error means no further messages can ever reach this chat —
 * stop retrying, clean up the chat's flow states, never run recovery flows into it.
 */
export function isChatDead(error: unknown): boolean {
  const text = String(
    (error as { description?: string })?.description ?? (error as Error)?.message ?? error,
  ).toLowerCase();
  return DEAD_CHAT_PATTERNS.some((p) => text.includes(p));
}
