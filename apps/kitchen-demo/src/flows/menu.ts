import { btn, prompt, send, storeCC } from "fluxgram";
import type { Fluxgram } from "fluxgram";
import { branchingDemo } from "./branching";
import { continuationsDemo } from "./continuations";
import { eventsObservabilityDemo } from "./events-observability";
import { groupInfoDemo } from "./groups";
import { messagingDemo } from "./messaging";
import { multiSelectDemo } from "./multiselect";
import { promptsDemo } from "./prompts";
import { MENU_CC } from "./shared";
import { subflowsDemo } from "./subflows";
import { timersDemo } from "./timers";
import type { DemoConfig } from "./types";

export function registerMenu(fx: Fluxgram, config: DemoConfig): void {
  const menu = fx.flow("kitchen:start", [
    send("Welcome to the Fluxgram kitchen demo."),
    send(
      "Use the buttons below to run focused feature demos. /queue shows same-chat serialization; /interrupt starts a flow that /cancel or /clear can kill; /error tests recovery.",
    ),
    storeCC(MENU_CC),
    prompt.buttons("Choose a demo:", {
      buttons: [
        [btn("Prompts", promptsDemo()), btn("Multi-select", multiSelectDemo())],
        [btn("Branching", branchingDemo()), btn("Subflows", subflowsDemo())],
        [btn("Continuations", continuationsDemo()), btn("Timers", timersDemo())],
        [btn("Messaging", messagingDemo(config)), btn("Groups", groupInfoDemo(config))],
        [
          btn("Runtime", send("Use /queue, /active, /handle, /broadcastme, /blocked, /notifyme.")),
          btn("Events/Obs", eventsObservabilityDemo(config)),
        ],
        btn("Exit", send("Kitchen demo closed. Send /start to reopen it.")),
      ],
    }),
  ]);

  fx.commands(["start", "kitchen", "demo"], menu, { overrideActive: true });
}
