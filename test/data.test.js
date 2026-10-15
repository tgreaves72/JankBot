const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { jsonLines } = require("../src/scryfall");
const { OllamaClient } = require("../src/ollama");

test("Scryfall JSONL handles split chunks, CRLF, and blank lines", async () => {
  const stream = Readable.from(['{"name":"Pla', 'ins"}\r\n\n{"name":"Island"}']);
  const cards = [];
  for await (const card of jsonLines(stream)) cards.push(card);
  assert.deepEqual(cards, [{ name: "Plains" }, { name: "Island" }]);
});

test("invalid Scryfall JSONL fails rather than skipping a card", async () => {
  await assert.rejects(async () => {
    for await (const card of jsonLines(Readable.from(['{"name":}']))) void card;
  }, SyntaxError);
});

test("Ollama absent budget remains absent instead of becoming zero", async () => {
  const client = new OllamaClient({ model: "test" });
  client.generate = async () => ({ response: JSON.stringify({ intent: "recommend_card", cardName: "Teysa Karlov", maxCardPriceUsd: null }) });
  const intent = await client.parseIntent("Find a card with Teysa Karlov.");
  assert.equal(intent.maxCardPriceUsd, null);
});

test("Ollama invalid price constraints fail explicitly", async () => {
  const client = new OllamaClient({ model: "test" });
  for (const price of ["2", 0, -1, 51]) {
    client.generate = async () => ({ response: JSON.stringify({ intent: "recommend_card", cardName: "Teysa Karlov", maxCardPriceUsd: price }) });
    await assert.rejects(client.parseIntent("Find a card with Teysa Karlov."), /invalid card price/);
  }
});

function explanationFixture() {
  const anchor = { name: "Yuriko, the Tiger's Shadow", cmc: 3, cheapest_usd: 4,
    type_line: "Legendary Creature - Human Ninja", color_identity: ["U", "B"] };
  const item = { card: anchor, roles: ["draw"], score: 1, reasons: [] };
  const result = { cards: [item], mainboard: [], roleCounts: { draw: 1 }, curve: [],
    totalEstimatedUsd: 4, validation: { ok: true, errors: [] } };
  const response = { answer: "Yuriko rewards evasive attackers and a steady flow of cards.",
    synergySummary: ["Evasive attackers help Ninjas connect.", "Combat triggers provide card advantage."],
    budgetSummary: "The tracked estimate is $4, excluding unpriced cards.", mentionedCards: [anchor.name] };
  return { anchor, result, response, intent: "build_deck", message: `Give me a deck based around ${anchor.name}.` };
}

function selectedResponse(options) {
  return { answer: options.format.properties.answer.enum[0], synergySummary: options.format.properties.synergySummary.items.enum.slice(0, 2),
    budgetSummary: options.format.properties.budgetSummary.enum[0], mentionedCards: options.format.properties.mentionedCards.items.enum.slice(0, 1) };
}

test("Ollama explanation generation enforces the same bounded schema as validation", async () => {
  const fixture = explanationFixture();
  const client = new OllamaClient({ model: "test" });
  let generated;
  client.generate = async options => { generated = options; return { response: JSON.stringify(selectedResponse(options)) }; };
  const result = await client.explain(fixture);
  assert.equal(result.usedOllama, true);
  assert.deepEqual(result.synergySummary, generated.format.properties.synergySummary.items.enum.slice(0, 2));
  assert.equal(result.grounding, "evidence_selected");
  assert.equal(generated.temperature, 0);
  assert.equal(generated.maxTokens, 420);
  assert.equal(generated.format.additionalProperties, false);
  assert.equal(generated.format.properties.synergySummary.items.maxLength, 120);
  assert.equal(generated.format.properties.synergySummary.minItems, 2);
  assert.equal(generated.format.properties.synergySummary.maxItems, 2);
  assert.deepEqual(generated.format.properties.mentionedCards.items.enum, [fixture.anchor.name]);
  assert.ok(generated.prompt.includes(JSON.stringify(generated.format)));
});

test("invalid model explanation lengths and shapes fail instead of truncating or substituting", async () => {
  const fixture = explanationFixture();
  const client = new OllamaClient({ model: "test" });
  for (const patch of [
    { synergySummary: ["a".repeat(221), "A valid second point."] },
    { synergySummary: "A string is not an array." },
    { synergySummary: ["Only one point."] },
    { budgetSummary: "b".repeat(161) },
    { answer: "c".repeat(361) },
    { mentionedCards: ["Invented Ninja"] },
    { unexpected: "extra field" }
  ]) {
    client.generate = async options => ({ response: JSON.stringify({ ...selectedResponse(options), ...patch }) });
    await assert.rejects(client.explain(fixture), { name: "OllamaError" });
  }
});

test("a model may mention only cards included in its supplied prompt data", async () => {
  const fixture = explanationFixture();
  const hidden = { card: { name: "Not supplied in the compact prompt" } };
  fixture.result.cards.push(hidden);
  const client = new OllamaClient({ model: "test" });
  client.generate = async options => ({ response: JSON.stringify({ ...selectedResponse(options), mentionedCards: [hidden.card.name] }) });
  await assert.rejects(client.explain(fixture), /outside the validated result set/);
});

test("fluent but unsupported ability claims fail rather than reaching the user", async () => {
  const fixture = explanationFixture(), client = new OllamaClient({ model: "test" });
  client.generate = async options => ({ response: JSON.stringify({ ...selectedResponse(options), answer: "Yuriko has vigilance and lifelink." }) });
  await assert.rejects(client.explain(fixture), /unsupported explanation claim/);
  client.generate = async options => {
    const response = selectedResponse(options); response.synergySummary[1] = response.synergySummary[0];
    return { response: JSON.stringify(response) };
  };
  await assert.rejects(client.explain(fixture), /unsupported or repeated evidence/);
});
