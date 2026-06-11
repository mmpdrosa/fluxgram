import { Bot } from "grammy";
import { Fluxgram, type FluxgramOptions } from "../src/fluxgram";
import { MemoryStorage } from "../src/storage/memory";

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

/** A real grammY Bot with faked transport: records API calls, returns synthesized results. */
export function makeBot() {
  const calls: ApiCall[] = [];
  const bot = new Bot("42:TEST", {
    botInfo: {
      id: 42,
      is_bot: true,
      first_name: "Test",
      username: "testbot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      can_manage_bots: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
    },
  });
  let nextId = 1000;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method.startsWith("send")) {
      return {
        ok: true,
        result: {
          message_id: nextId++,
          chat: { id: (payload as { chat_id: number }).chat_id },
          date: 1,
          text: (payload as { text?: string }).text ?? "",
        },
      } as never;
    }
    return { ok: true, result: true } as never;
  });
  const sentTexts = (): string[] =>
    calls.filter((c) => c.method === "sendMessage").map((c) => c.payload["text"] as string);
  return { bot, calls, sentTexts };
}

export async function makeFluxgram(opts?: Partial<FluxgramOptions>) {
  const { bot, calls, sentTexts } = makeBot();
  const fx = new Fluxgram(bot, { storage: new MemoryStorage(), ...opts });
  await fx.init();
  return { bot, fx, calls, sentTexts };
}

let updateId = 1;
export const testUser = { id: 7, is_bot: false, first_name: "U" };
const me = { id: 42, is_bot: true, first_name: "Test", username: "testbot" };

export function msgUpdate(chatId: number, text: string, extra?: Record<string, unknown>) {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId++,
      date: 1,
      chat: { id: chatId, type: chatId > 0 ? "private" : "supergroup" },
      from: testUser,
      text,
      ...(text.startsWith("/")
        ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] }
        : {}),
      ...extra,
    },
  } as never;
}

export function cbUpdate(chatId: number, data: string) {
  return {
    update_id: updateId++,
    callback_query: {
      id: `q${updateId}`,
      from: testUser,
      chat_instance: "ci",
      message: { message_id: 1, date: 1, chat: { id: chatId, type: "private" } },
      data,
    },
  } as never;
}

export function memberUpdate(chatId: number, oldStatus: string, newStatus: string) {
  return {
    update_id: updateId++,
    my_chat_member: {
      chat: { id: chatId, type: "supergroup" },
      from: testUser,
      date: 1,
      old_chat_member: { status: oldStatus, user: me },
      new_chat_member: { status: newStatus, user: me },
    },
  } as never;
}

export function lastKeyboard(calls: ApiCall[]): { text: string; callback_data: string }[] {
  const withKb = calls.filter(
    (c) => c.method === "sendMessage" && c.payload["reply_markup"] !== undefined,
  );
  const markup = withKb.at(-1)!.payload["reply_markup"] as {
    inline_keyboard: { text: string; callback_data: string }[][];
  };
  return markup.inline_keyboard.flat();
}
