import { ValidationError, btn, btnRow, prompt, send, set } from "fluxgram";
import type { IncomingMessage, StepLike } from "fluxgram";
import { backToMenu } from "./shared";
import type { DemoContext } from "./types";

function validateAge(_ctx: unknown, message: unknown): number {
  const text = (message as IncomingMessage).text ?? "";
  const age = Number(text.trim());
  if (!Number.isInteger(age) || age < 13 || age > 120) {
    throw new ValidationError("Send an age between 13 and 120.");
  }
  return age;
}

export function promptsDemo(): StepLike {
  return [
    send("Prompt demo: text validation, whole-message capture, and button-only prompts."),
    prompt.text("How old are you?", { store: "age", validate: validateAge }),
    (ctx: DemoContext) => send(`Stored validated age: ${ctx.store.age}.`),
    prompt.message("Now send any message. I will store the full message object.", {
      store: "savedMessage",
    }),
    (ctx: DemoContext) => {
      const messageId = ctx.store.savedMessage?.message_id ?? "unknown";
      return send(`Stored message_id: ${messageId}.`);
    },
    prompt.buttons("Pick one button. Typed replies should bounce here.", {
      requireButtonText: "Use one of the buttons for this step.",
      buttons: [
        btnRow([
          btn("Alpha", set("buttonChoice", "Alpha")),
          btn("Beta", set("buttonChoice", "Beta")),
        ]),
      ],
    }),
    (ctx: DemoContext) => send(`Button stored: ${ctx.store.buttonChoice}.`),
    prompt.text("Either-mode prompt: type a name or click Guest.", {
      store: "name",
      buttons: [btn("Guest", set("name", "Guest"))],
    }),
    (ctx: DemoContext) => send(`Either-mode stored name: ${ctx.store.name}.`),
    prompt.text("Timeout demo: reply within 5 seconds or I will run onTimeout.", {
      store: "timeoutAnswer",
      timeoutSecs: 5,
      onTimeout: send("Prompt timed out; continuing the flow."),
    }),
    (ctx: DemoContext) =>
      send(
        ctx.store.timeoutAnswer === undefined
          ? "No timeout answer was stored."
          : `Timeout answer stored: ${ctx.store.timeoutAnswer}.`,
      ),
    prompt.text("Group-safe prompt: only the flow initiator can answer this step.", {
      store: "privateReply",
      onlyFrom: "initiator",
    }),
    (ctx: DemoContext) => send(`Initiator-only reply stored: ${ctx.store.privateReply}.`),
    prompt.buttons("Reuse-message menu: this prompt edits the previous bot message.", {
      reuseMessage: true,
      buttons: [btn("Store A", set("menuChoice", "A")), btn("Store B", set("menuChoice", "B"))],
    }),
    (ctx: DemoContext) => send(`Reuse-message choice: ${ctx.store.menuChoice}.`),
    backToMenu(),
  ];
}
