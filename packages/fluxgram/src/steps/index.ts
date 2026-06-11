// Step descriptors are plain objects; trees of them are registered flows.
// Only positions (paths) into these trees are ever persisted — never the objects.

export interface SendOpts {
  parseMode?: string;
  replyToMessageId?: number;
  disableWebPagePreview?: boolean;
  onSent?: (
    ctx: { store: Record<string, unknown>; chatId: number },
    msg: { message_id: number },
  ) => void;
}

export interface SendMedia {
  type: "photo" | "video" | "document";
  file: unknown;
  fileName?: string;
}

export interface SendStep {
  kind: "send";
  text: string;
  opts?: SendOpts;
  media?: SendMedia;
}

export interface SetStep {
  kind: "set";
  key: string;
  value: unknown;
}

export interface NoopStep {
  kind: "noop";
}

export interface StepsStep {
  kind: "steps";
  children: Step[];
}

export interface BranchStep {
  kind: "branch";
  cond: (ctx: unknown) => boolean | Promise<boolean>;
  // children: [ifTrue, ifFalse?, onError?] — child index doubles as the path segment
  children: Step[];
}

export interface DynamicStep {
  kind: "dynamic";
  fn: (ctx: unknown) => unknown;
}

/** A standard-schema validator (valibot/zod/arktype) or a plain function. */
export type PromptValidate =
  | { "~standard": { validate: (input: unknown) => unknown } }
  | ((ctx: unknown, message: unknown) => unknown);

export interface PromptButtonRef {
  text: string;
  childIndex: number;
}

export interface PromptStep {
  kind: "prompt";
  text: string;
  /** text: store the reply text; message: store the message object; buttons: clicks only */
  mode: "text" | "message" | "buttons";
  store?: string;
  validate?: PromptValidate;
  parseMode?: string;
  requireButtonText?: string;
  /** unanswered prompts expire after this many seconds (resolved by the sweep) */
  timeoutSecs?: number;
  /** index into children of the onTimeout step (when provided) */
  timeoutChildIndex?: number;
  /** restrict answers (replies and clicks) to the flow's initiator or a user id */
  onlyFrom?: "initiator" | number;
  /** menu mode: edit the flow's previous bot message in place instead of sending a new one */
  reuseMessage?: boolean;
  /** keyboard rows; childIndex points into children (the button steps) */
  layout: PromptButtonRef[][];
  children: Step[];
}

export interface CallFlowStep {
  kind: "callflow";
  /** children[0] = the subflow body */
  children: Step[];
  args?: Record<string, unknown> | ((ctx: unknown) => Record<string, unknown>);
  storeResult?: string;
}

export interface ReturnStep {
  kind: "return";
  value?: unknown;
  fromStore?: string;
}

export interface StoreCCStep {
  kind: "storecc";
  key: string;
}

export interface CallCCStep {
  kind: "callcc";
  key: string;
  /** children[0] = the body */
  children: Step[];
}

export interface RedirectCCStep {
  kind: "redirectcc";
  key: string;
}

export interface SleepStep {
  kind: "sleep";
  seconds: number;
  humanize?: boolean;
}

export interface MultiSelectStep {
  kind: "multiselect";
  text: string;
  store: string;
  labels: string[];
  values: unknown[];
  submitText: string;
  emptySelectionText?: string;
  preSelected?: unknown[];
  parseMode?: string;
  requireButtonText?: string;
  /** unanswered multi-selects expire after this many seconds (resolved by the sweep) */
  timeoutSecs?: number;
  /** index into children of the onTimeout step (when provided) */
  timeoutChildIndex?: number;
  /** restrict answers (replies and clicks) to the flow's initiator or a user id */
  onlyFrom?: "initiator" | number;
  /** menu mode: edit the flow's previous bot message in place instead of sending a new one */
  reuseMessage?: boolean;
  /** extra (non-toggle) buttons; childIndex points into children */
  extraLayout: PromptButtonRef[][];
  children: Step[];
}

export type PinTarget =
  | number
  | "most_recent"
  | "most_recent_bot"
  | "most_recent_user"
  | { fromStore: string };

export interface ForwardStep {
  kind: "forward";
  messageId: number | { fromStore: string };
  toChatId: number;
  fromChatId?: number;
}

export interface PinStep {
  kind: "pin";
  target: PinTarget;
  disableNotification?: boolean;
}

export interface UnpinStep {
  kind: "unpin";
  target: PinTarget;
}

export interface WaitStep {
  kind: "wait";
  check: (ctx: unknown) => boolean | Promise<boolean>;
  everySecs: number;
  timeoutSecs: number;
  /** children[0] = onTimeout (when provided) */
  children: Step[];
}

export type Step =
  | SendStep
  | SetStep
  | NoopStep
  | StepsStep
  | BranchStep
  | DynamicStep
  | PromptStep
  | CallFlowStep
  | ReturnStep
  | StoreCCStep
  | CallCCStep
  | RedirectCCStep
  | SleepStep
  | WaitStep
  | ForwardStep
  | PinStep
  | UnpinStep
  | MultiSelectStep;

export type StepFn = (ctx: never) => unknown;
export type StepLike = Step | StepFn | StepLike[];

const STEP_KINDS = new Set([
  "send",
  "set",
  "noop",
  "steps",
  "branch",
  "dynamic",
  "prompt",
  "callflow",
  "return",
  "storecc",
  "callcc",
  "redirectcc",
  "sleep",
  "wait",
  "forward",
  "pin",
  "unpin",
  "multiselect",
]);

export function isStep(value: unknown): value is Step {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    STEP_KINDS.has((value as { kind: string }).kind)
  );
}

/** Normalize authoring sugar: arrays become steps nodes, functions become dynamic nodes. */
export function normalize(stepLike: StepLike): Step {
  if (Array.isArray(stepLike)) {
    return { kind: "steps", children: stepLike.map(normalize) };
  }
  if (typeof stepLike === "function") {
    return { kind: "dynamic", fn: stepLike as DynamicStep["fn"] };
  }
  if (isStep(stepLike)) return stepLike;
  throw new TypeError(
    `Not a step: ${String(stepLike)} (did you pass a non-step value into a flow?)`,
  );
}

// ---- factories ----

function sendText(text: string, opts?: SendOpts): SendStep {
  if (text === "") {
    throw new TypeError(
      "send() requires non-empty text (Telegram rejects empty messages; media captions may be empty)",
    );
  }
  return opts === undefined ? { kind: "send", text } : { kind: "send", text, opts };
}

function sendMedia(type: SendMedia["type"]) {
  return (file: unknown, caption = "", opts?: SendOpts & { fileName?: string }): SendStep => {
    const { fileName, ...sendOpts } = opts ?? {};
    const media: SendMedia = fileName === undefined ? { type, file } : { type, file, fileName };
    const step: SendStep = { kind: "send", text: caption, media };
    if (Object.keys(sendOpts).length > 0) step.opts = sendOpts;
    return step;
  };
}

/** Send a message; .photo/.video/.document send media with the text as caption. */
export const send = Object.assign(sendText, {
  photo: sendMedia("photo"),
  video: sendMedia("video"),
  document: sendMedia("document"),
});

/** Forward a message to another chat (from the flow's chat unless fromChatId given). */
export function forward(
  messageId: ForwardStep["messageId"],
  opts: { toChatId: number; fromChatId?: number },
): ForwardStep {
  return {
    kind: "forward",
    messageId,
    toChatId: opts.toChatId,
    ...(opts.fromChatId === undefined ? {} : { fromChatId: opts.fromChatId }),
  };
}

/** Pin a message: an id, 'most_recent[_bot|_user]', or { fromStore } — with permission pre-check. */
export function pin(target: PinTarget, opts?: { disableNotification?: boolean }): PinStep {
  return {
    kind: "pin",
    target,
    ...(opts?.disableNotification === undefined
      ? {}
      : { disableNotification: opts.disableNotification }),
  };
}

export function unpin(target: PinTarget): UnpinStep {
  return { kind: "unpin", target };
}

export function set(key: string, value: unknown): SetStep {
  return { kind: "set", key, value };
}

export function noop(): NoopStep {
  return { kind: "noop" };
}

export function steps(children: StepLike[]): StepsStep {
  return { kind: "steps", children: children.map(normalize) };
}

export function branch(
  cond: BranchStep["cond"],
  ifTrue: StepLike,
  ifFalse?: StepLike,
  onError?: StepLike,
): BranchStep {
  const children: Step[] = [normalize(ifTrue)];
  if (ifFalse !== undefined) children.push(normalize(ifFalse));
  if (onError !== undefined) {
    if (ifFalse === undefined) children.push({ kind: "noop" });
    children.push(normalize(onError));
  }
  return { kind: "branch", cond, children };
}

/**
 * Run a subflow with an isolated store (seeded from args). A `ret(...)` inside
 * it pops back here, placing the returned value in `storeResult` on the caller.
 * SPEC §5.3 — target is a StepLike; named cross-flow references come later.
 */
export function callFlow(
  target: StepLike,
  opts?: { args?: CallFlowStep["args"]; storeResult?: string },
): CallFlowStep {
  const step: CallFlowStep = { kind: "callflow", children: [normalize(target)] };
  if (opts?.args !== undefined) step.args = opts.args;
  if (opts?.storeResult !== undefined) step.storeResult = opts.storeResult;
  return step;
}

function retValue(value?: unknown): ReturnStep {
  return value === undefined ? { kind: "return" } : { kind: "return", value };
}

/** Return from the enclosing callFlow subflow, optionally with a value. */
export const ret = Object.assign(retValue, {
  /** Return the value stored at `key` in the subflow's store. */
  fromStore(key: string): ReturnStep {
    return { kind: "return", fromStore: key };
  },
});

/** Save the current continuation (the rest of the flow after this point) under `key`. */
export function storeCC(key: string): StoreCCStep {
  return { kind: "storecc", key };
}

/** Save the continuation under `key`, then run `body` (which may redirectCC back). */
export function callCC(key: string, body: StepLike): CallCCStep {
  return { kind: "callcc", key, children: [normalize(body)] };
}

/** Jump to a previously saved continuation — the "back to menu" / "skip" primitive. */
export function redirectCC(key: string): RedirectCCStep {
  return { kind: "redirectcc", key };
}

/**
 * Pause for `seconds`. Short pauses are in-memory; pauses at or beyond the
 * engine's timerThresholdSecs become durable timers that survive restarts.
 */
export function sleep(seconds: number, opts?: { humanize?: boolean }): SleepStep {
  return opts?.humanize ? { kind: "sleep", seconds, humanize: true } : { kind: "sleep", seconds };
}

/** sleep() with gaussian human-looking jitter. */
export function humanSleep(seconds: number): SleepStep {
  return { kind: "sleep", seconds, humanize: true };
}

/** Re-check `check` every everySecs (as durable timers) until true or timeoutSecs passes. */
export function waitFor(
  check: WaitStep["check"],
  opts: { everySecs: number; timeoutSecs: number; onTimeout?: StepLike },
): WaitStep {
  return {
    kind: "wait",
    check,
    everySecs: opts.everySecs,
    timeoutSecs: opts.timeoutSecs,
    children: opts.onTimeout === undefined ? [] : [normalize(opts.onTimeout)],
  };
}
