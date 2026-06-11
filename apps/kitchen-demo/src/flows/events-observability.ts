import { btn, prompt, send } from "fluxgram";
import type { DebugChatSink, Fluxgram, FluxgramClient, StepLike } from "fluxgram";
import { backToMenu } from "./shared";
import type { DemoConfig, DemoContext } from "./types";

export function eventsObservabilityDemo(config: DemoConfig): StepLike {
  return [
    send(
      "Events/observability demo: in-process client events, custom events, JSON sink, and optional debug chat.",
    ),
    send(
      config.debugChatId === undefined
        ? "DebugChatSink is not configured. Set DEBUG_CHAT_ID to send digests to a Telegram chat."
        : `DebugChatSink is configured for chat ${config.debugChatId}.`,
    ),
    prompt.buttons("Choose an event demo:", {
      reuseMessage: true,
      buttons: [
        btn("Client sendMessage", send("Run /eventmsg to publish fluxgram:sendMessage.")),
        btn("Client initiateFlow", send("Run /eventflow to publish fluxgram:initiateFlow.")),
        btn("Custom event", send("Run /customevent to publish kitchen:custom.")),
      ],
    }),
    backToMenu(),
  ];
}

export function registerEventsObservabilityDemos(
  fx: Fluxgram,
  client: FluxgramClient,
  config: DemoConfig,
  debugChat: DebugChatSink | undefined,
): void {
  fx.flow("kitchen:event-flow-target", [
    send("This flow was started by FluxgramClient.initiateFlow through the in-process event bus."),
    (ctx: DemoContext) =>
      send(`Event store payload: ${JSON.stringify(ctx.store.eventPayload ?? {})}`),
  ]);

  fx.onEvent("kitchen:custom", async (payload) => {
    const chatId = Number(payload.chatId);
    await fx.initiateFlow("kitchen:custom-event-result", chatId, { store: payload });
  });

  fx.flow("kitchen:custom-event-result", [
    (ctx: DemoContext) => send(`Custom event handled with store: ${JSON.stringify(ctx.store)}.`),
  ]);

  fx.command(
    "eventmsg",
    fx.flow("kitchen:eventmsg", [
      async (ctx: DemoContext) => {
        await client.sendMessage(ctx.chatId, "Sent through FluxgramClient.sendMessage.", {
          uniqueKey: `kitchen:eventmsg:${ctx.chatId}:${Date.now()}`,
        });
        return send("Published fluxgram:sendMessage. The client message should arrive separately.");
      },
    ]),
  );

  fx.command(
    "eventflow",
    fx.flow("kitchen:eventflow", [
      async (ctx: DemoContext) => {
        await client.initiateFlow("kitchen:event-flow-target", ctx.chatId, {
          store: { eventPayload: { source: "eventflow command" } },
          uniqueKey: `kitchen:eventflow:${ctx.chatId}:${Date.now()}`,
        });
        return send(
          "Published fluxgram:initiateFlow. A second flow should run after this message.",
        );
      },
    ]),
  );

  fx.command(
    "customevent",
    fx.flow("kitchen:customevent", [
      async (ctx: DemoContext) => {
        await client.emit(
          "kitchen:custom",
          { chatId: ctx.chatId, source: "customevent command" },
          {
            uniqueKey: `kitchen:custom:${ctx.chatId}:${Date.now()}`,
            oneAtATimeKey: `chat:${ctx.chatId}`,
          },
        );
        return send("Published kitchen:custom with oneAtATimeKey.");
      },
    ]),
  );

  fx.command(
    "debugflush",
    fx.flow("kitchen:debugflush", [
      async () => {
        if (debugChat === undefined)
          return send("Debug chat is not configured; set DEBUG_CHAT_ID.");
        await debugChat.flush();
        return send("Flushed DebugChatSink queue.");
      },
    ]),
  );

  fx.command("observability", fx.flow("kitchen:observability", [eventsObservabilityDemo(config)]));
}
