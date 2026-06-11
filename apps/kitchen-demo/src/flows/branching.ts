import { branch, prompt, send } from "fluxgram";
import type { StepLike } from "fluxgram";
import { backToMenu } from "./shared";
import type { DemoContext } from "./types";

export function branchingDemo(): StepLike {
  return [
    send("Branching demo: answer yes or no."),
    prompt.text("Do you like durable conversations?", { store: "branchAnswer" }),
    branch(
      (ctx: unknown) =>
        ((ctx as DemoContext).store.branchAnswer ?? "").toLowerCase().startsWith("y"),
      send("True branch: good, this is the core Fluxgram use case."),
      send("False branch: fair, but this still shows conditional flow control."),
      send("Error branch: the branch condition threw."),
    ),
    backToMenu(),
  ];
}
