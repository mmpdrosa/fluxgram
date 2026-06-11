import { redirectCC, send } from "fluxgram";
import type { StepLike } from "fluxgram";

export const MENU_CC = "kitchen-menu";

export function backToMenu(message = "Back to the kitchen menu."): StepLike {
  return [send(message), redirectCC(MENU_CC)];
}

export function notConfigured(name: string, envVar: string): StepLike {
  return backToMenu(`${name} is not configured. Set ${envVar} and restart the demo.`);
}
