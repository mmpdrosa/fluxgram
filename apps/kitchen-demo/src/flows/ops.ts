import { prompt, send } from "fluxgram";
import type { Fluxgram } from "fluxgram";
import type { DemoContext } from "./types";

interface DemoStats {
  handledMessages: number;
  sentMessages: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerOps(fx: Fluxgram, stats: DemoStats): void {
  fx.command(
    "cancel",
    fx.flow("kitchen:cancel", [send("Cancelled the active conversation, if one was waiting.")]),
    { overrideActive: true },
  );

  fx.command(
    "clear",
    fx.flow("kitchen:clear", [
      async (ctx: DemoContext) => {
        const active = await fx.listActive({ chatId: ctx.chatId });
        await fx.gcFlows(active.map((item) => item.id));
        return send(`Cleared ${active.length} active flow(s) in this chat.`);
      },
    ]),
    { overrideActive: true },
  );

  fx.command(
    "active",
    fx.flow("kitchen:active", [
      async (ctx: DemoContext) => {
        const active = await fx.listActive({ chatId: ctx.chatId });
        if (active.length === 0) return send("No active conversations in this chat.");
        return send(
          active
            .map((item) => `${item.flowName} at [${item.path.join(",")}] (${item.status})`)
            .join("\n"),
        );
      },
    ]),
  );

  fx.command(
    "handle",
    fx.flow("kitchen:handle", [
      async (ctx: DemoContext) => {
        const active = await fx.listActive({ chatId: ctx.chatId });
        const first = active[0];
        if (first === undefined) return send("No active flow handle to inspect.");
        const handle = await fx.getFlowHandle(first.id);
        return send(
          handle === null
            ? `Flow ${first.id} no longer has a handle.`
            : `Handle ${handle.id}: ${handle.flowName} for chat ${handle.chatId}. Active path [${first.path.join(",")}], status ${first.status}.`,
        );
      },
    ]),
  );

  fx.command(
    "broadcastme",
    fx.flow("kitchen:broadcastme", [
      async (ctx: DemoContext) => {
        const result = await fx.broadcast([ctx.chatId], "Broadcast-to-self demo message.", {
          onProgress: (done, total) => console.log(`broadcast progress ${done}/${total}`),
        });
        return send(
          `Broadcast result: sent=${result.sent.length}, dead=${result.dead.length}, failed=${result.failed.length}.`,
        );
      },
    ]),
  );

  fx.command(
    "blocked",
    fx.flow("kitchen:blocked", [send("If you see this, middleware did not block.")]),
  );

  fx.command(
    "queue",
    fx.flow("kitchen:queue", [
      (ctx: DemoContext) => {
        void fx.initiateFlow("kitchen:queue-slow", ctx.chatId);
        void fx.initiateFlow("kitchen:queue-fast", ctx.chatId);
        void fx.initiateFlow("kitchen:queue-final", ctx.chatId);
        return send("Queued three same-chat flows. The fast ones should wait for the slow one.");
      },
    ]),
    { overrideActive: true },
  );

  fx.flow("kitchen:queue-slow", [
    send("Queue item 1/3: slow flow started."),
    async () => {
      await delay(2000);
      return send("Queue item 1/3: slow flow finished.");
    },
  ]);
  fx.flow("kitchen:queue-fast", [send("Queue item 2/3: fast flow ran after item 1.")]);
  fx.flow("kitchen:queue-final", [send("Queue item 3/3: final flow ran last.")]);

  fx.command(
    "interrupt",
    fx.flow("kitchen:interrupt", [
      send("Interruption demo: this flow will wait for a reply."),
      prompt.text(
        "Send /cancel or /clear now to interrupt it, or reply with any text to let it finish.",
        { store: "interruptReply" },
      ),
      (ctx: DemoContext) =>
        send(`Interruption demo finished with reply: ${ctx.store.interruptReply}`),
    ]),
    { overrideActive: true },
  );

  fx.command(
    "stats",
    fx.flow("kitchen:stats", [
      () =>
        send(
          `Handled messages: ${stats.handledMessages}. Bot-sent messages: ${stats.sentMessages}.`,
        ),
    ]),
  );

  fx.flow("kitchen:programmatic-notice", [
    send("This flow was started programmatically via fx.initiateFlow()."),
  ]);
  fx.command(
    "notifyme",
    fx.flow("kitchen:notifyme", [
      (ctx: DemoContext) => {
        void fx.initiateFlow("kitchen:programmatic-notice", ctx.chatId);
        return send("Queued a programmatic flow for this chat.");
      },
    ]),
  );

  fx.command(
    "error",
    fx.flow("kitchen:error", [
      () => {
        throw new Error("Intentional kitchen demo error.");
      },
    ]),
  );

  fx.onMessage(
    { regex: /hello kitchen/i },
    fx.flow("kitchen:on-message", [send("onMessage regex matched: hello kitchen")]),
  );
}
