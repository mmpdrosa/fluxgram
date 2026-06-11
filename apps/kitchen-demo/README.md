# Kitchen Demo

This app is a menu-driven Telegram bot that exercises Fluxgram features from a real app workspace. It is intended for maintainers and developers who want to manually test the library against Telegram.

## Setup

1. Create a bot with Telegram's `@BotFather`.
2. Copy the example env file:

```sh
cp apps/kitchen-demo/.env.example apps/kitchen-demo/.env
```

3. Fill in `BOT_TOKEN`.
4. Start the demo from `apps/kitchen-demo`:

```sh
bun dev
```

## Optional Env

| Variable                 | Purpose                                                |
| ------------------------ | ------------------------------------------------------ |
| `FORWARD_TARGET_CHAT_ID` | Enables the messaging forward demo.                    |
| `ENABLE_GROUP_DEMOS`     | Enables group lifecycle hook flows.                    |
| `DEBUG_CHAT_ID`          | Enables `DebugChatSink` digests to that Telegram chat. |
| `NOTIFY_CHAT_ID`         | Optional escalation chat for debug notify digests.     |

The demo still runs without optional values. Photo, video, and document demos use repo-local sample assets by default. Optional integrations show clear skipped messages when their env vars are absent.

## Menu Coverage

The `/start` menu covers:

- Inputs: text validation, message capture, button-only prompts, either-mode prompts, timeout, initiator-only prompts, reuse-message menus, and multi-select extras.
- Flow control: branches, branch error arm, subflows, returns, continuations, and menu redirects.
- Runtime: queueing, cancellation, active flow inspection, flow handles, middleware, programmatic starts, and broadcast.
- Messaging: chunking, parse-mode fallback, media, `onSent`, forwarding, pinning, and unpinning.
- Timers: short sleep, `humanSleep`, durable timer threshold, and `waitFor` timeout.
- Ops: stats hooks, error recovery, plain message triggers, and cleanup.
- Events/observability: in-process event bus, `FluxgramClient`, custom events, JSON sink, and optional debug chat.
- Groups: lifecycle hooks and group prompt restrictions.

## Test In A Direct Chat

1. Open your bot in Telegram.
2. Send `/start`.
3. Use the menu buttons to run demos for inputs, flow control, timers, messaging, events/observability, and groups.
4. Use `/active` to inspect active flows when no prompt is waiting.
5. Use `/handle` to inspect the first active flow handle when a flow is active.
6. Use `/clear` or `/cancel` to terminate active/waiting flows.
7. Use `/queue` to queue three same-chat flows; the later flows should wait for the slow first flow.
8. Use `/interrupt`, then send `/cancel` or `/clear` while it waits to test interruption.
9. Use `/stats` to inspect bot hooks.
10. Use `/notifyme` to test programmatic `fx.initiateFlow`.
11. Use `/broadcastme` to send a broadcast to the current chat.
12. Use `/blocked` to demonstrate middleware blocking a command before the flow starts.
13. Use `/eventmsg`, `/eventflow`, and `/customevent` to exercise the in-process event bus and `FluxgramClient`.
14. Use `/observability` to open the events/observability menu.
15. Use `/debugflush` to flush the optional debug chat sink when configured.
16. Use `/error` to test the recovery handler.
17. Run `/clear` or `/cancel`, then send `hello kitchen` to test `onMessage` regex routing. Plain message triggers only run when no flow is waiting in that chat.
18. `/kitchen` and `/demo` are aliases for `/start`.

## Test In A Group

1. Create a Telegram group.
2. Add your bot to the group.
3. Send `/start`.
4. When the bot asks for input, reply directly to the bot's prompt message.

Telegram privacy mode usually lets bots see commands and replies to their own messages, but not every plain group message. To test the `hello kitchen` regex in a group, use `@BotFather` -> `/setprivacy` -> choose your bot -> `Disable`, restart the bot, make sure no flow is waiting, then send `hello kitchen`.

To test group lifecycle messages, set `ENABLE_GROUP_DEMOS=true`, restart the bot, then add/promote/demote the bot in a group.
