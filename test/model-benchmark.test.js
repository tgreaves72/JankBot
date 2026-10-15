const test = require("node:test");
const assert = require("node:assert/strict");
const { OllamaClient } = require("../src/ollama");
const { assess, percentile } = require("../scripts/benchmark-models");
const { validateProfile, loadProfile } = require("../src/model-profile");

const digest = "a".repeat(64);
test("deployment profile accepts exactly one digest-pinned model and rejects unsafe paths or extra configuration", () => {
  assert.equal(loadProfile().expectedDigest.length, 64);
  assert.deepEqual(validateProfile({ model: "qwen3:1.7b-q4_K_M", digest, think: false }), { model: "qwen3:1.7b-q4_K_M", expectedDigest: digest, think: false });
  for (const patch of [{ model: "../../private:tag" }, { digest: "no" }, { think: true }, { fallback: "other" }]) {
    assert.throws(() => validateProfile({ model: "qwen3:tag", digest, think: null, ...patch }), /Invalid pinned/);
  }
});
test("an environment override cannot silently replace the pinned model", () => {
  const previous = process.env.OLLAMA_MODEL;
  try {
    process.env.OLLAMA_MODEL = "unapproved:tag";
    assert.throws(() => loadProfile(), /disagrees/);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = previous;
  }
});
test("model upgrades retain Windows process, memory, CPU, cloud and network restrictions", () => {
  const fs = require("node:fs"), path = require("node:path");
  const guard = fs.readFileSync(path.join(__dirname, "../scripts/resource-guard.ps1"), "utf8");
  for (const required of ['[DemoJob]::Create(2048, 25, 4)', '[DemoJob]::Create(768, 10, 1)', '$env:OLLAMA_NO_CLOUD = "1"', '$env:OLLAMA_NUM_PARALLEL = "1"', '$env:OLLAMA_MAX_LOADED_MODELS = "1"', '$env:OLLAMA_MAX_QUEUE = "1"', '$env:OLLAMA_HOST = "127.0.0.1:11435"', '"--permission"', '"--max-old-space-size=512"']) assert.ok(guard.includes(required), required);
});
test("model digest mismatch stops inference without requesting an alternate model", async () => {
  const client = new OllamaClient({ model: "selected:tag", expectedDigest: digest });
  const calls = [];
  client.request = async endpoint => { calls.push(endpoint); return { models: [{ name: "selected:tag", digest: "b".repeat(64) }] }; };
  await assert.rejects(client.generate({ prompt: "hello" }), /not installed/);
  assert.deepEqual(calls, ["/api/tags"]);
});
test("explicit thinking mode and digest pin preserve restricted inference settings", async () => {
  for (const think of [undefined, false]) {
    const client = new OllamaClient({ model: "selected:tag", expectedDigest: digest, demo: true, think });
    let payload, config;
    client.request = async (endpoint, body, options) => {
      if (endpoint === "/api/tags") return { models: [{ name: "selected:tag", digest: `sha256:${digest}` }] };
      payload = body; config = options; return { response: "{}" };
    };
    await client.generate({ prompt: "hello" });
    assert.equal(Object.hasOwn(payload, "think"), think !== undefined);
    assert.equal(payload.think, think);
    assert.equal(payload.model, "selected:tag");
    assert.equal(payload.options.num_ctx, 4096);
    assert.equal(payload.options.num_thread, 2);
    assert.equal(payload.options.num_gpu, 0);
    assert.equal(config.timeoutMs, 90000);
  }
  assert.throws(() => new OllamaClient({ model: "test", think: "false" }), /explicit boolean/);
  assert.throws(() => new OllamaClient({ model: "test", expectedDigest: "invalid" }), /digest/);
});
test("workspace model responses reject extra fields and oversized or missing questions", async () => {
  const client = new OllamaClient({ model: "test" });
  const valid = { intent: "clarify", cardName: null, compareCardName: null, totalBudget: null, maxCardPriceUsd: null, question: "Which card?" };
  for (const patch of [{ question: undefined }, { question: "x".repeat(161) }, { command: "run" }]) {
    client.generate = async () => ({ response: JSON.stringify({ ...valid, ...patch }) });
    await assert.rejects(client.parseIntent("help", { commander: "Teysa Karlov" }), { name: "OllamaError" });
  }
});
test("model price choices contain only explicit in-range numbers and server validation rejects invented amounts", async () => {
  const client = new OllamaClient({ model: "test" });
  let options;
  const response = { intent: "revise_constraints", cardName: "Teysa Karlov", compareCardName: null, totalBudget: 75, maxCardPriceUsd: null, question: "" };
  client.generate = async input => { options = input; return { response: JSON.stringify(response) }; };
  await client.parseIntent("Bring the deck under $75", { commander: "Teysa Karlov" });
  assert.deepEqual(options.format.properties.totalBudget.enum, [null, 75]);
  assert.deepEqual(options.format.properties.maxCardPriceUsd.enum, [null]);
  assert.match(options.messages[0].content, /Actions:/);
  assert.deepEqual(JSON.parse(options.messages[1].content), { workspace: { commander: "Teysa Karlov" }, request: "Bring the deck under $75" });
  await assert.rejects(client.parseIntent("Make it cheaper", {}), /Unstated totalBudget/);
  response.totalBudget = null; response.maxCardPriceUsd = 50;
  await assert.rejects(client.parseIntent("Find a card below $2", {}), /Unstated maxCardPriceUsd/);
  response.maxCardPriceUsd = 2;
  await client.parseIntent("Find a card below $2", {});
  assert.deepEqual(options.format.properties.maxCardPriceUsd.enum, [null, 2]);
});
test("an incomplete model response fails once rather than retrying or selecting another model", async () => {
  const client = new OllamaClient({ model: "selected:tag", expectedDigest: digest, demo: true });
  let inferences = 0;
  client.request = async endpoint => {
    if (endpoint === "/api/tags") return { models: [{ name: "selected:tag", digest }] };
    inferences++; return { response: "{", done_reason: "length" };
  };
  await assert.rejects(client.generate({ prompt: "hello" }), /output limit/);
  assert.equal(inferences, 1);
});
test("benchmark scores exact price slots, named cards and unsafe intent", () => {
  const sample = { id: "Teysa Karlov:3", commander: "Teysa Karlov", expected: "recommend_card" };
  const plan = { intent: "recommend_card", cardName: sample.commander, compareCardName: null, totalBudget: null, maxCardPriceUsd: 2 };
  assert.deepEqual(assess(sample, plan), []);
  assert.ok(assess(sample, { ...plan, totalBudget: 2, maxCardPriceUsd: null }).includes("maxCardPriceUsd"));
  assert.ok(assess({ ...sample, id: "Teysa Karlov:12", expected: "clarify" }, plan).includes("intent"));
  assert.equal(percentile([9, 2, 3, 1], .5), 2);
  assert.equal(percentile([], .95), null);
});
