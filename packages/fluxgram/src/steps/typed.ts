// Typed authoring layer: flowKit<S>() returns the same step factories with
// store keys checked against S. Pure type-level — the runtime objects are the
// untyped factories re-exported as-is.

import type { FlowContext } from "../engine/executor";
import {
  branch,
  ret,
  set,
  type BranchStep,
  type ReturnStep,
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

/** FlowContext with store typed as S (no index signature required on S). */
export type TypedFlowContext<S extends object> = Omit<FlowContext, "store"> & { store: S };

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
    step: ((fn: (ctx: TypedFlowContext<S>) => unknown) => fn) as FlowKit<S>["step"],
    branch: branch as unknown as FlowKit<S>["branch"],
    ret: ret as FlowKit<S>["ret"],
    prompt: prompt as unknown as FlowKit<S>["prompt"],
  };
}

export type { Btn };
