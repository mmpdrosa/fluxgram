# Fluxgram

Durable, resumable Telegram bot flows for grammY.

Fluxgram lets you model a Telegram conversation as a sequence of typed steps, suspend it for user input, persist it through restarts, and resume it when a reply, button click, timer, or external event arrives.

```ts
import { Bot } from "grammy";
import { Fluxgram, MemoryStorage, prompt, send } from "fluxgram";

const bot = new Bot(process.env.BOT_TOKEN!);
await bot.init();

const fx = new Fluxgram(bot, {
  storage: new MemoryStorage(),
});

const onboarding = fx.flow("onboarding", [
  send("Welcome."),
  prompt.text("What is your name?", { store: "name" }),
  (ctx) => send(`Nice to meet you, ${ctx.store.name}.`),
]);

fx.command("start", onboarding);
await fx.start();
```

## Why Fluxgram

Telegram bot conversations are stateful, but update handlers are not. Fluxgram gives you a small workflow runtime for grammY bots:

- Write conversations as normal TypeScript step arrays.
- Suspend on text replies, whole messages, inline buttons, and multi-select prompts.
- Persist active flows, waiters, timers, continuation stacks, and user stores.
- Recover due timers and in-progress flows after a restart.
- Serialize work per chat while allowing different chats to run concurrently.
- Emit structured flow events for logs, debug chats, metrics, or tracing.

## Install

```sh
npm install fluxgram grammy
```

With Bun:

```sh
bun add fluxgram grammy
```

Durable adapters use optional peer dependencies. Install only what you use:

```sh
npm install pg        # Postgres storage on Node
npm install redis     # Redis storage/events on Node
npm install mongodb   # Mongo storage/events
```

Bun can use its built-in SQLite, Redis, and SQL clients where supported by the adapter matrix below.

## Creating Flows

A flow is an ordered list of steps. Steps can send messages, write to the flow store, branch, call subflows, save continuations, wait for time, or suspend for user input.

```ts
import { ValidationError, btn, prompt, send, set, sleep } from "fluxgram";

const survey = fx.flow("survey", [
  send("Let's set up your profile."),

  prompt.text("How old are you?", {
    store: "age",
    validate: (_ctx, message) => {
      const age = Number(message.text);
      if (!Number.isInteger(age)) throw new ValidationError("Send a whole number.");
      return age;
    },
  }),

  prompt.buttons("Pick a plan.", {
    buttons: [btn("Free", set("plan", "free")), btn("Pro", set("plan", "pro"))],
  }),

  sleep(5),
  (ctx) => send(`Age: ${ctx.store.age}. Plan: ${ctx.store.plan}.`),
]);
```

Prompt validators can transform the answer before it is stored. Throw `ValidationError` to keep the flow waiting and send a retry message.

## Prompts

Fluxgram includes prompt helpers for common Telegram input patterns:

```ts
prompt.text("Your email?", { store: "email" });

prompt.message("Send a receipt.", {
  store: "receiptMessage",
});

prompt.buttons("Choose one.", {
  buttons: [btn("Alpha", set("choice", "alpha")), btn("Beta", set("choice", "beta"))],
});

prompt.multiSelect("Choose topics.", {
  store: "topics",
  choices: ["Prompts", "Timers", "Media"],
  submitText: "Done",
});
```

Prompts create durable waiters. A restart between the prompt and the user's answer can still resume the flow when durable storage is configured.

## Durable Storage

Fluxgram persists three kinds of data through a `StorageAdapter`:

| Data       | Purpose                                                                      |
| ---------- | ---------------------------------------------------------------------------- |
| Flow state | Flow name, version, path, frames, store, waiter, timer status, and metadata. |
| Waiters    | Prompt and callback keys that atomically resume exactly one flow.            |
| KV values  | Small JSON-compatible values for dedupe, migrations, and coordination.       |

For production bots, use a durable adapter instead of `MemoryStorage`.

```ts
import { PostgresStorage } from "fluxgram/storage/postgres";

const storage = await PostgresStorage.connect(process.env.POSTGRES_URL!);

const fx = new Fluxgram(bot, {
  storage,
});
```

Long sleeps become durable timers. Configure the threshold with `timerThresholdSecs`:

```ts
const fx = new Fluxgram(bot, {
  storage,
  timerThresholdSecs: 30,
});
```

Sleeps below the threshold stay inline. Sleeps at or above the threshold are persisted and resumed by the recovery sweep.

## Runtime And Adapter Support

| Adapter           | Import                      | Bun | Node | Notes                                                |
| ----------------- | --------------------------- | --- | ---- | ---------------------------------------------------- |
| Memory storage    | `fluxgram`                  | Yes | Yes  | Good for tests and demos; not durable.               |
| SQLite storage    | `fluxgram/storage/sqlite`   | Yes | No   | Uses Bun's SQLite APIs.                              |
| Redis storage     | `fluxgram/storage/redis`    | Yes | Yes  | Bun uses built-in Redis; Node uses optional `redis`. |
| Postgres storage  | `fluxgram/storage/postgres` | Yes | Yes  | Bun uses built-in SQL; Node uses optional `pg`.      |
| Mongo storage     | `fluxgram/storage/mongo`    | Yes | Yes  | Uses optional `mongodb`.                             |
| In-process events | `fluxgram`                  | Yes | Yes  | Single-process event delivery.                       |
| Redis events      | `fluxgram/events/redis`     | Yes | Yes  | Cross-process events through Redis.                  |
| Mongo events      | `fluxgram/events/mongo`     | Yes | Yes  | Cross-process events through MongoDB.                |

## Events And External Triggers

`FluxgramClient` publishes events into a bot process through an `EventBus`. Use it to send messages, start flows, dedupe external jobs, or coordinate work across processes.

```ts
import { FluxgramClient, InProcessEventBus } from "fluxgram";

const events = new InProcessEventBus();
const client = new FluxgramClient({ events });

await client.initiateFlow({
  botId: 1,
  chatId: 123,
  flowName: "onboarding",
  store: { source: "admin" },
});
```

For multi-process deployments, use `RedisEventBus` or `MongoEventBus` from their adapter subpaths.

## Observability

Fluxgram emits one structured `FlowEvent` per execution cycle. Events include trigger, path, actions, outcome, duration, API call count, and error details when present.

```ts
import { evlogSink, jsonSink } from "fluxgram";

const fx = new Fluxgram(bot, {
  storage,
  sinks: [evlogSink({ service: "telegram-bot" }), jsonSink()],
});
```

Built-in sinks include JSON lines, evlog wide events, and `DebugChatSink` for operator chat summaries. You can also implement `ObservabilitySink` to connect Fluxgram to your own logging, metrics, or tracing pipeline.

## Testing Flows

Use the testing export to exercise flows without calling Telegram:

```ts
import { TestHarness } from "fluxgram/testing";
import { MemoryStorage } from "fluxgram";

const harness = TestHarness.create({ storage: new MemoryStorage() });
harness.register("hello", [send("Hello from a test.")]);

await harness.initiateFlow("hello");
await harness.expectMessage("Hello from a test.");
```

`MemoryStorage` is usually enough for unit tests. Use the same durable storage adapter as production when testing restart, timer, or multi-process behavior.

## License

MIT
