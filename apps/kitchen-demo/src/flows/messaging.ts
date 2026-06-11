import { InputFile } from "grammy";
import { forward, pin, prompt, send, sleep, unpin } from "fluxgram";
import type { StepLike } from "fluxgram";
import { backToMenu } from "./shared";
import type { DemoConfig, DemoContext } from "./types";

const PHOTO_ASSET = new URL("../../assets/sample-photo.jpg", import.meta.url).pathname;
const DOCUMENT_ASSET = new URL("../../assets/sample-document.pdf", import.meta.url).pathname;
const VIDEO_ASSET = new URL("../../assets/sample-video.mp4", import.meta.url).pathname;

function mediaDemo(): StepLike {
  const photo = new InputFile(PHOTO_ASSET, "sample-photo.jpg");
  const document = new InputFile(DOCUMENT_ASSET, "sample-document.pdf");
  const video = new InputFile(VIDEO_ASSET, "sample-video.mp4");
  const steps: StepLike[] = [
    send.photo(photo, "Repo-local sample photo."),
    send.video(video, "Repo-local sample video."),
    send.document(document, "Repo-local sample document."),
  ];

  return steps;
}

function forwardDemo(config: DemoConfig): StepLike {
  if (config.forwardTargetChatId === undefined) {
    return send("Forward demo skipped: set FORWARD_TARGET_CHAT_ID to test it.");
  }
  return [
    prompt.message("Send a message and I will forward it to FORWARD_TARGET_CHAT_ID.", {
      store: "forwardedMessage",
    }),
    (ctx: DemoContext) => {
      const messageId = ctx.store.forwardedMessage?.message_id;
      if (messageId === undefined) return send("No message_id found; skipping forward.");
      return forward(messageId, { toChatId: config.forwardTargetChatId! });
    },
  ];
}

export function messagingDemo(config: DemoConfig): StepLike {
  const longText = Array.from(
    { length: 90 },
    (_, i) => `Chunking line ${i + 1}: Fluxgram keeps long sends within Telegram limits.`,
  ).join("\n");
  return [
    send(
      "Messaging demo: chunking, parse-mode fallback, local media, optional forwarding, and pin/unpin.",
    ),
    send(longText),
    send("<b>Broken HTML on purpose", { parseMode: "HTML" }),
    mediaDemo(),
    send("onSent demo: I will store this bot message id for later steps.", {
      onSent: (ctx, message) => {
        ctx.store.lastBotMessageId = message.message_id;
      },
    }),
    (ctx: DemoContext) => send(`Stored last bot message id: ${ctx.store.lastBotMessageId}.`),
    forwardDemo(config),
    send("Pin demo: I will try to pin the most recent bot message, wait, then unpin it."),
    pin("most_recent_bot"),
    sleep(2),
    unpin("most_recent_bot"),
    backToMenu(),
  ];
}
