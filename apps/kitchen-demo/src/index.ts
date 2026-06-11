import { Bot } from "grammy";
import {
  DebugChatSink,
  Fluxgram,
  FluxgramClient,
  InProcessEventBus,
  MemoryStorage,
  jsonSink,
  send,
} from "fluxgram";
import type { DebugChatApi, ObservabilitySink } from "fluxgram";
import { loadConfig } from "./env";
import { registerEventsObservabilityDemos } from "./flows/events-observability";
import { registerGroupDemos } from "./flows/groups";
import { registerMenu } from "./flows/menu";
import { registerOps } from "./flows/ops";

const { token, demo } = loadConfig();

const bot = new Bot(token);
await bot.init();

const events = new InProcessEventBus();
const client = new FluxgramClient({ events });

const sinks: ObservabilitySink[] = [jsonSink((line) => console.log(`[fluxgram:event] ${line}`))];
let debugChat: DebugChatSink | undefined;
if (demo.debugChatId !== undefined) {
  debugChat = new DebugChatSink({
    api: bot.api as unknown as DebugChatApi,
    chatId: demo.debugChatId,
    ...(demo.notifyChatId === undefined ? {} : { notifyChatId: demo.notifyChatId }),
    tags: ["kitchen-demo"],
    autoFlushMs: 3000,
    ctxFormatter: (event) =>
      event.flow === undefined ? `Kitchen chat ${event.chatId}` : `Kitchen ${event.flow}`,
  });
  sinks.push(debugChat);
}

const fx = new Fluxgram(bot, {
  storage: new MemoryStorage(),
  events,
  sinks,
  timerThresholdSecs: 1,
  onFlowError: (error) =>
    send(`Recovered from error: ${String((error.error as Error).message ?? error.error)}`),
});

const stats = { handledMessages: 0, sentMessages: 0 };

fx.onBotHandledMessage((_message) => {
  stats.handledMessages++;
});
fx.onBotSentMessage((_message) => {
  stats.sentMessages++;
});

fx.use(async (ctx, next) => {
  if (ctx.source === "command:/blocked") {
    await bot.api.sendMessage(ctx.chatId, "Middleware blocked /blocked before a flow started.");
    ctx.block();
    return;
  }
  ctx.params.store = {
    ...(ctx.params.store as Record<string, unknown> | undefined),
    middlewareSource: ctx.source,
  };
  return next();
});

registerMenu(fx, demo);
registerOps(fx, stats);
registerEventsObservabilityDemos(fx, client, demo, debugChat);
registerGroupDemos(fx, demo);

await fx.start();
