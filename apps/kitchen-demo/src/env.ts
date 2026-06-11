import type { DemoConfig } from "./flows/types";

function optionalNumber(name: string): number | undefined {
  const value = Bun.env[name];
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number.`);
  return parsed;
}

function optionalString(name: string): string | undefined {
  const value = Bun.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

function booleanFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((Bun.env[name] ?? "").toLowerCase());
}

export function loadConfig(): { token: string; demo: DemoConfig } {
  const token = optionalString("BOT_TOKEN");
  if (!token) throw new Error("Set BOT_TOKEN to run the kitchen demo bot.");

  const demo: DemoConfig = { enableGroupDemos: booleanFlag("ENABLE_GROUP_DEMOS") };
  const forwardTargetChatId = optionalNumber("FORWARD_TARGET_CHAT_ID");
  const debugChatId = optionalNumber("DEBUG_CHAT_ID");
  const notifyChatId = optionalNumber("NOTIFY_CHAT_ID");

  if (forwardTargetChatId !== undefined) demo.forwardTargetChatId = forwardTargetChatId;
  if (debugChatId !== undefined) demo.debugChatId = debugChatId;
  if (notifyChatId !== undefined) demo.notifyChatId = notifyChatId;

  return { token, demo };
}
