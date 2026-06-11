import type { FlowContext } from "fluxgram";

export interface DemoConfig {
  forwardTargetChatId?: number;
  debugChatId?: number;
  notifyChatId?: number;
  enableGroupDemos: boolean;
}

export interface DemoStore extends Record<string, unknown> {
  age?: number;
  name?: string;
  savedMessage?: { message_id?: number; text?: string };
  buttonChoice?: string;
  topics?: string[];
  branchAnswer?: string;
  childResult?: string;
  forwardedMessage?: { message_id?: number };
  interruptReply?: string;
  timeoutAnswer?: string;
  privateReply?: string;
  menuChoice?: string;
  multiSelectAction?: string;
  middlewareSource?: string;
  eventPayload?: Record<string, unknown>;
  lastBotMessageId?: number;
}

export type DemoContext = FlowContext<DemoStore>;
