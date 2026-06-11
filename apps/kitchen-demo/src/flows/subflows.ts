import { callFlow, prompt, ret, send } from "fluxgram";
import type { StepLike } from "fluxgram";
import { backToMenu } from "./shared";
import type { DemoContext } from "./types";

const childFlow: StepLike = [
  send("Subflow: this has its own isolated store."),
  prompt.text("Type a value for the subflow to return.", { store: "answer" }),
  ret.fromStore("answer"),
];

export function subflowsDemo(): StepLike {
  return [
    send("Subflow demo: callFlow runs a child flow and ret returns a value."),
    callFlow(childFlow, { storeResult: "childResult" }),
    (ctx: DemoContext) => send(`Parent flow received: ${ctx.store.childResult}.`),
    backToMenu(),
  ];
}
