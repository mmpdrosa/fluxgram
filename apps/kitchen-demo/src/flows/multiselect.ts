import { btn, prompt, send, set } from "fluxgram";
import type { StepLike } from "fluxgram";
import { backToMenu } from "./shared";
import type { DemoContext } from "./types";

export function multiSelectDemo(): StepLike {
  return [
    send("Multi-select demo: toggle choices, then submit."),
    prompt.multiSelect("Which topics should this demo cover?", {
      store: "topics",
      choices: ["Prompts", "Buttons", "Timers", "Groups"],
      preSelected: ["Prompts"],
      emptySelectionText: "No topics selected; storing an empty list.",
      submitText: "Save topics",
      extraButtons: [btn("Clear later", set("multiSelectAction", "clear-later"))],
    }),
    (ctx: DemoContext) => {
      const topics = ctx.store.topics ?? [];
      const action = ctx.store.multiSelectAction
        ? ` Extra action: ${ctx.store.multiSelectAction}.`
        : "";
      return send(`Stored topics: ${topics.length === 0 ? "none" : topics.join(", ")}.${action}`);
    },
    backToMenu(),
  ];
}
