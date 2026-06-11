import {
  normalize,
  type MultiSelectStep,
  type PromptButtonRef,
  type PromptStep,
  type PromptValidate,
  type Step,
  type StepLike,
} from "./index";

export interface Btn {
  text: string;
  step: Step;
}

/** An inline button that runs `step` when pressed. */
export function btn(text: string, step: StepLike): Btn {
  return { text, step: normalize(step) };
}

/** A horizontal row of buttons. */
export function btnRow(buttons: Btn[]): Btn[] {
  return buttons;
}

export type ButtonsOption = (Btn | Btn[])[];

export interface PromptOptions {
  store?: string;
  validate?: PromptValidate;
  buttons?: ButtonsOption;
  parseMode?: string;
  requireButtonText?: string;
  /** expire the prompt after this many seconds; onTimeout (if given) runs, then the flow continues */
  timeoutSecs?: number;
  /** ran when the prompt times out; without it a timed-out flow simply ends */
  onTimeout?: StepLike;
  /** in groups: only the flow's initiator (or the given user id) may answer */
  onlyFrom?: "initiator" | number;
  /** menu mode: edit the flow's previous bot message in place instead of sending a new one */
  reuseMessage?: boolean;
}

function buildKeyboard(buttons: ButtonsOption | undefined): {
  layout: PromptButtonRef[][];
  children: Step[];
} {
  const layout: PromptButtonRef[][] = [];
  const children: Step[] = [];
  for (const entry of buttons ?? []) {
    const row = Array.isArray(entry) ? entry : [entry];
    layout.push(
      row.map((b) => {
        children.push(b.step);
        return { text: b.text, childIndex: children.length - 1 };
      }),
    );
  }
  return { layout, children };
}

function makePrompt(mode: PromptStep["mode"], text: string, opts: PromptOptions): PromptStep {
  if (mode !== "buttons" && !opts.store) {
    throw new Error(`prompt.${mode} requires a store key`);
  }
  if (mode === "buttons" && (!opts.buttons || opts.buttons.length === 0)) {
    throw new Error("prompt.buttons requires at least one button");
  }
  if (opts.onTimeout !== undefined && opts.timeoutSecs === undefined) {
    throw new Error("prompt onTimeout requires timeoutSecs");
  }
  const { layout, children } = buildKeyboard(opts.buttons);
  const step: PromptStep = { kind: "prompt", text, mode, layout, children };
  if (opts.store !== undefined) step.store = opts.store;
  if (opts.validate !== undefined) step.validate = opts.validate;
  if (opts.parseMode !== undefined) step.parseMode = opts.parseMode;
  if (opts.requireButtonText !== undefined) step.requireButtonText = opts.requireButtonText;
  if (opts.timeoutSecs !== undefined) step.timeoutSecs = opts.timeoutSecs;
  if (opts.onlyFrom !== undefined) step.onlyFrom = opts.onlyFrom;
  if (opts.reuseMessage !== undefined) step.reuseMessage = opts.reuseMessage;
  if (opts.onTimeout !== undefined) {
    children.push(normalize(opts.onTimeout));
    step.timeoutChildIndex = children.length - 1;
  }
  return step;
}

/** Prompt answered by a text reply (stores the text) and/or buttons. */
function promptText(text: string, opts: PromptOptions): PromptStep {
  return makePrompt("text", text, opts);
}

/** Prompt answered by any message (stores the whole message object) and/or buttons. */
function promptMessage(text: string, opts: PromptOptions): PromptStep {
  return makePrompt("message", text, opts);
}

/** Prompt answerable only with buttons; text replies bounce with requireButtonText. */
function promptButtons(
  text: string,
  opts: {
    buttons: ButtonsOption;
    parseMode?: string;
    requireButtonText?: string;
    timeoutSecs?: number;
    onTimeout?: StepLike;
    onlyFrom?: "initiator" | number;
    reuseMessage?: boolean;
  },
): PromptStep {
  return makePrompt("buttons", text, opts);
}

export interface MultiSelectOptions {
  store: string;
  choices: unknown[];
  display?: (choice: unknown) => string;
  value?: (choice: unknown) => unknown;
  submitText?: string;
  emptySelectionText?: string;
  preSelected?: unknown[];
  parseMode?: string;
  requireButtonText?: string;
  extraButtons?: ButtonsOption;
  /** expire the multi-select after this many seconds; onTimeout (if given) runs, then the flow continues */
  timeoutSecs?: number;
  /** ran when the multi-select times out; without it a timed-out flow simply ends */
  onTimeout?: StepLike;
  /** in groups: only the flow's initiator (or the given user id) may answer */
  onlyFrom?: "initiator" | number;
  /** menu mode: edit the flow's previous bot message in place instead of sending a new one */
  reuseMessage?: boolean;
}

/** Checkbox-style multi-select with a submit button; selected values land in `store`. */
function promptMultiSelect(text: string, opts: MultiSelectOptions): MultiSelectStep {
  const display = opts.display ?? ((c: unknown) => String(c));
  const value = opts.value ?? ((c: unknown) => c);
  const { layout, children } = buildKeyboard(opts.extraButtons);
  const step: MultiSelectStep = {
    kind: "multiselect",
    text,
    store: opts.store,
    labels: opts.choices.map(display),
    values: opts.choices.map(value),
    submitText: opts.submitText ?? "Submit",
    extraLayout: layout,
    children,
  };
  if (opts.emptySelectionText !== undefined) step.emptySelectionText = opts.emptySelectionText;
  if (opts.preSelected !== undefined) step.preSelected = opts.preSelected;
  if (opts.parseMode !== undefined) step.parseMode = opts.parseMode;
  if (opts.requireButtonText !== undefined) step.requireButtonText = opts.requireButtonText;
  if (opts.onTimeout !== undefined && opts.timeoutSecs === undefined) {
    throw new Error("multiSelect onTimeout requires timeoutSecs");
  }
  if (opts.timeoutSecs !== undefined) step.timeoutSecs = opts.timeoutSecs;
  if (opts.onlyFrom !== undefined) step.onlyFrom = opts.onlyFrom;
  if (opts.reuseMessage !== undefined) step.reuseMessage = opts.reuseMessage;
  if (opts.onTimeout !== undefined) {
    children.push(normalize(opts.onTimeout));
    step.timeoutChildIndex = children.length - 1;
  }
  return step;
}

export const prompt = Object.assign(promptText, {
  text: promptText,
  message: promptMessage,
  buttons: promptButtons,
  multiSelect: promptMultiSelect,
});
