import { send } from "fluxgram";
import type { Fluxgram } from "fluxgram";
import { backToMenu } from "./shared";
import type { DemoConfig } from "./types";

export function groupInfoDemo(config: DemoConfig) {
  return [
    send("Group demo: add this bot to a group and try /start there."),
    send(
      config.enableGroupDemos
        ? "Group lifecycle hooks are enabled for this process."
        : "Set ENABLE_GROUP_DEMOS=true to enable group lifecycle hook messages.",
    ),
    backToMenu(),
  ];
}

export function registerGroupDemos(fx: Fluxgram, config: DemoConfig): void {
  if (!config.enableGroupDemos) return;

  fx.onAddedToGroup(
    fx.flow("kitchen:group-added", [
      send("Thanks for adding me. Send /start to open the Fluxgram kitchen demo."),
    ]),
  );
  fx.onBecameAdmin(fx.flow("kitchen:became-admin", [send("I am now an admin in this group.")]));
  fx.onLostAdmin(fx.flow("kitchen:lost-admin", [send("I am no longer an admin in this group.")]));
  fx.onGroupMigrated(
    fx.flow("kitchen:group-migrated", [send("This group migration was recorded.")]),
  );
}
