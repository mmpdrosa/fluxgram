// Bun consumers resolve the package's "bun" export condition to raw src, so the
// built dist is never exercised under Bun by the normal test suite. This smoke
// imports the built artifact directly and runs a flow through the bundled engine,
// so a broken build fails CI for Bun users too (not only the Node smoke).
import assert from "node:assert/strict";

const { Engine, FlowRegistry, MemoryStorage, send, flowKit, defineFlow, assertJsonSafe } =
  await import("../dist/src/index.js");

assert.equal(typeof Engine, "function");
assert.equal(typeof defineFlow, "function");
assert.equal(typeof flowKit, "function");
assert.equal(typeof assertJsonSafe, "function");

const registry = new FlowRegistry();
const spec = defineFlow("smoke", [send("hi from dist")]);
registry.register(spec.name, spec.root);

const sent = [];
const engine = new Engine({
  botId: 1,
  registry,
  storage: new MemoryStorage(),
  api: {
    sendMessage: async (_chatId, text) => {
      sent.push(text);
      return { message_id: 1 };
    },
  },
});

await engine.initiateFlow("smoke", 10);
assert.deepEqual(sent, ["hi from dist"]);

console.log("Bun dist smoke passed");
