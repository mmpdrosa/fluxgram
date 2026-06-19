// Typed authoring layer: flowKit<S>() returns the same step factories with
// store keys checked against S. Pure type-level — the runtime objects are the
// untyped factories re-exported as-is.

import type { FlowContext } from "../engine/executor";
import {
  branch,
  callFlow,
  forward,
  pin,
  ret,
  send,
  set,
  type BranchStep,
  type CallFlowStep,
  type ForwardStep,
  type PinStep,
  type ReturnStep,
  type SendOpts,
  type SendStep,
  type SetStep,
  type StepLike,
} from "./index";
import {
  prompt,
  type Btn,
  type ButtonsOption,
  type MultiSelectOptions,
  type PromptOptions,
} from "./prompt";
import type { MultiSelectStep, PromptStep } from "./index";

/** Keys of S whose value type accepts V. */
type KeysAccepting<S, V> = {
  [K in keyof S]: V extends S[K] ? K : never;
}[keyof S] &
  string;

/**
 * The store as seen *while authoring*: every declared key is optional, because a
 * key only exists once the step that writes it has run. Reads carry `| undefined`
 * (guard them); writes still require the declared value type. This is deliberate —
 * Fluxgram's store is a runtime fact (branches, dynamic steps, continuations and
 * durable restarts decide what is present), so the type must not claim presence.
 */
export type ReadStore<S extends object> = { [K in keyof S]?: S[K] };

/** FlowContext with store typed as S, optional on read (no index signature required). */
export type TypedFlowContext<S extends object> = Omit<FlowContext, "store"> & {
  store: ReadStore<S>;
};

/** pin target with `fromStore` restricted to number-typed keys of S. */
type TypedPinTarget<S extends object> =
  | number
  | "most_recent"
  | "most_recent_bot"
  | "most_recent_user"
  | { fromStore: KeysAccepting<S, number> };

/** forward source message id, with `fromStore` restricted to number-typed keys of S. */
type TypedForwardId<S extends object> = number | { fromStore: KeysAccepting<S, number> };

/** Typed send options: onSent sees the typed store; storeMessageId names a number key. */
type TypedSendOpts<S extends object> = Omit<SendOpts, "onSent"> & {
  onSent?: (ctx: TypedFlowContext<S>, msg: { message_id: number }) => void;
  /** convenience: store the sent message's id under this number-typed key (for later edit/pin/forward) */
  storeMessageId?: KeysAccepting<S, number>;
};

type TypedPromptOptions<S extends object, V> = Omit<PromptOptions, "store" | "validate"> & {
  store?: KeysAccepting<S, V>;
  validate?:
    | { "~standard": { validate: (input: unknown) => unknown } }
    | ((ctx: TypedFlowContext<S>, message: unknown) => unknown);
};

/** Keys of S holding an array (multi-select stores the selected values there). */
type ArrayKeys<S> = {
  [K in keyof S]: S[K] extends readonly unknown[] ? K : never;
}[keyof S] &
  string;

type TypedMultiSelectOptions<S extends object> = Omit<MultiSelectOptions, "store"> & {
  store: ArrayKeys<S>;
};

export interface FlowKit<S extends object> {
  /** set() with the key checked against S and the value against S[key] */
  set<K extends keyof S & string>(key: K, value: S[K]): SetStep;
  /** send() with a typed onSent and a `storeMessageId` shortcut for the sent id */
  send(text: string, opts?: TypedSendOpts<S>): SendStep;
  /** pin() with `fromStore` checked against number-typed keys of S */
  pin(target: TypedPinTarget<S>, opts?: { disableNotification?: boolean }): PinStep;
  /** forward() with `fromStore` checked against number-typed keys of S */
  forward(
    messageId: TypedForwardId<S>,
    opts: { toChatId: number; fromChatId?: number },
  ): ForwardStep;
  /**
   * callFlow() to a defined subflow. `args` are checked against the subflow's store
   * shape; `storeResult` must name a key of this flow's store S.
   */
  callFlow<Sub extends object = Record<string, unknown>>(
    target: FlowSpec<Sub> | StepLike,
    opts?: {
      args?: Partial<Sub> | ((ctx: TypedFlowContext<S>) => Partial<Sub>);
      storeResult?: keyof S & string;
    },
  ): CallFlowStep;
  /** a dynamic step with a typed ctx.store */
  step<T>(fn: (ctx: TypedFlowContext<S>) => T): (ctx: TypedFlowContext<S>) => T;
  /** branch() with a typed cond */
  branch(
    cond: (ctx: TypedFlowContext<S>) => boolean | Promise<boolean>,
    ifTrue: StepLike,
    ifFalse?: StepLike,
    onError?: StepLike,
  ): BranchStep;
  ret: {
    (value?: unknown): ReturnStep;
    fromStore<K extends keyof S & string>(key: K): ReturnStep;
  };
  prompt: {
    (text: string, opts: TypedPromptOptions<S, string>): PromptStep;
    text(text: string, opts: TypedPromptOptions<S, string>): PromptStep;
    message(text: string, opts: TypedPromptOptions<S, object>): PromptStep;
    buttons(
      text: string,
      opts: { buttons: ButtonsOption } & Omit<TypedPromptOptions<S, never>, "store">,
    ): PromptStep;
    multiSelect(text: string, opts: TypedMultiSelectOptions<S>): MultiSelectStep;
  };
}

/**
 * A defined-but-not-yet-registered flow that carries its store shape S. Pass it to
 * `fx.flow(spec)` to register, to `command`/`initiateFlow` for typed wiring, or to
 * `callFlow(spec)` to reuse as a subflow body.
 */
export interface FlowSpec<S extends object = Record<string, unknown>> {
  name: string;
  root: StepLike;
  version?: number;
  /** phantom: carries the store shape (never set at runtime) */
  readonly __store?: S;
}

/**
 * Define a flow and its store shape in one place. The `build` argument is either a
 * `StepLike` (array/step) or a builder `(k) => StepLike` that receives a typed
 * `flowKit<S>()`. A bare function is treated as a builder, not a dynamic step —
 * wrap a dynamic-step root in an array (`[ (ctx) => … ]`) if you need one.
 */
export function defineFlow<S extends object = Record<string, unknown>>(
  name: string,
  build: (k: FlowKit<S>) => StepLike,
  opts?: { version?: number },
): FlowSpec<S>;
export function defineFlow<S extends object = Record<string, unknown>>(
  name: string,
  build: StepLike,
  opts?: { version?: number },
): FlowSpec<S>;
export function defineFlow<S extends object = Record<string, unknown>>(
  name: string,
  build: StepLike | ((k: FlowKit<S>) => StepLike),
  opts?: { version?: number },
): FlowSpec<S> {
  const root =
    typeof build === "function" ? (build as (k: FlowKit<S>) => StepLike)(flowKit<S>()) : build;
  return {
    name,
    root,
    ...(opts?.version === undefined ? {} : { version: opts.version }),
  };
}

/**
 * Build the typed send: `storeMessageId` desugars to an `onSent` that writes the
 * sent message's id into the store, chaining any user-supplied `onSent`.
 */
function typedSend<S extends object>(text: string, opts?: TypedSendOpts<S>): SendStep {
  if (opts === undefined) return send(text);
  const { storeMessageId, onSent, ...rest } = opts;
  if (storeMessageId === undefined) {
    return send(text, opts as SendOpts);
  }
  const combined: SendOpts["onSent"] = (ctx, msg) => {
    ctx.store[storeMessageId] = msg.message_id;
    (onSent as SendOpts["onSent"] | undefined)?.(ctx, msg);
  };
  return send(text, { ...rest, onSent: combined } as SendOpts);
}

/**
 * Typed step factories bound to a store shape:
 *
 *   interface Store { name: string; tags: string[] }
 *   const k = flowKit<Store>();
 *   k.set("name", "john");            // ok
 *   k.set("name", 42);                // type error
 *   k.prompt.text("Q?", { store: "name" });  // ok — only string keys offered
 */
export function flowKit<S extends object>(): FlowKit<S> {
  return {
    set: set as FlowKit<S>["set"],
    send: typedSend as FlowKit<S>["send"],
    pin: pin as FlowKit<S>["pin"],
    forward: forward as FlowKit<S>["forward"],
    callFlow: callFlow as unknown as FlowKit<S>["callFlow"],
    step: ((fn: (ctx: TypedFlowContext<S>) => unknown) => fn) as FlowKit<S>["step"],
    branch: branch as unknown as FlowKit<S>["branch"],
    ret: ret as FlowKit<S>["ret"],
    prompt: prompt as unknown as FlowKit<S>["prompt"],
  };
}

export type { Btn };
