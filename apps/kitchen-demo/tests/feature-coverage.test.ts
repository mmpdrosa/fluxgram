import { describe, expect, test } from "bun:test";
import { normalize, type Step } from "fluxgram";
import { eventsObservabilityDemo } from "../src/flows/events-observability";
import { multiSelectDemo } from "../src/flows/multiselect";
import { promptsDemo } from "../src/flows/prompts";

function collect(root: unknown): Step[] {
  const out: Step[] = [];
  const visit = (step: Step): void => {
    out.push(step);
    if ("children" in step) {
      for (const child of step.children) visit(child);
    }
  };
  visit(normalize(root as never));
  return out;
}

describe("kitchen feature coverage", () => {
  test("prompt demo covers timeout, initiator-only, and reuse-message prompts", () => {
    const steps = collect(promptsDemo());

    expect(steps.some((step) => step.kind === "prompt" && step.timeoutSecs === 5)).toBe(true);
    expect(steps.some((step) => step.kind === "prompt" && step.onlyFrom === "initiator")).toBe(
      true,
    );
    expect(steps.some((step) => step.kind === "prompt" && step.reuseMessage === true)).toBe(true);
  });

  test("multi-select demo includes an extra action button", () => {
    const steps = collect(multiSelectDemo());

    expect(
      steps.some((step) => step.kind === "multiselect" && step.extraLayout.flat().length > 0),
    ).toBe(true);
  });

  test("events observability demo exposes debug chat status and event actions", () => {
    const steps = collect(eventsObservabilityDemo({ enableGroupDemos: false }));

    expect(
      steps.some(
        (step) => step.kind === "send" && step.text.includes("DebugChatSink is not configured"),
      ),
    ).toBe(true);
    expect(
      steps.some(
        (step) =>
          step.kind === "prompt" &&
          step.layout.flat().some((button) => button.text === "Client sendMessage"),
      ),
    ).toBe(true);
  });
});
