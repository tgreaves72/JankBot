const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { CardNames, normalizeName, directRequest } = require("../src/card-names");
const { CardStore } = require("../src/scryfall");
const { createApp } = require("../server");

const card = (name, extra = {}) => ({ name, type_line: "Legendary Creature", oracle_text: "Create a token.",
  color_identity: [], keywords: [], cmc: 2, cheapest_usd: 1, legalities: { commander: "legal" }, ...extra });
const cards = [card("Teysa Karlov"), card("Teysa, Orzhov Scion"), card("Teysa, Envoy of Ghosts"),
  card("Yarok, the Desecrated"), card("Sol Ring"), card("Niv-Mizzet, Parun"), card("Teysa Karlov // Teysa Karlov", { type_line: "Card // Card", card_faces: [{ name: "Teysa Karlov" }] })];

test("card names normalize punctuation and accents without changing identity", () => {
  assert.equal(normalizeName("Éowyn, Fearless Knight"), "eowyn fearless knight");
  const index = new CardNames(cards);
  assert.equal(index.resolve("NIV MIZZET PARUN").card.name, "Niv-Mizzet, Parun");
  assert.equal(index.resolve("Niv Mizzet Parun").status, "exact");
  assert.equal(index.resolve("Teysa Karlov").status, "exact");
});

test("confident typographical matches correct only to real catalog cards", () => {
  const index = new CardNames(cards);
  for (const [query, expected] of [["Teysa Karolv", "Teysa Karlov"], ["Yarok the Descrated", "Yarok, the Desecrated"], ["Sol Rign", "Sol Ring"]]) {
    const resolved = index.resolve(query);
    assert.equal(resolved.status, "corrected");
    assert.equal(resolved.card.name, expected);
    assert.equal(resolved.query, query);
  }
});

test("ambiguous and nonexistent names never silently select a card", () => {
  const index = new CardNames(cards);
  const ambiguous = index.resolve("Teysa");
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.card, undefined);
  assert.equal(ambiguous.suggestions.length, 3);
  assert.equal(index.resolve("zzqzxyzzzqq").status, "missing");
  assert.equal(index.resolve("Sol").card, undefined);
});

test("face aliases resolve the complete card and art-series objects cannot shadow it", () => {
  const index = new CardNames([...cards, card("Delver of Secrets // Insectile Aberration", { card_faces: [{ name: "Delver of Secrets" }, { name: "Insectile Aberration" }] })]);
  assert.equal(index.resolve("Delver of Secrets").card.name, "Delver of Secrets // Insectile Aberration");
  assert.equal(index.resolve("Teysa Karlov").card.name, "Teysa Karlov");
});

test("name search cache remains bounded and only supplies catalog names", () => {
  const index = new CardNames(cards);
  for (let i = 0; i < 200; i++) index.matches(`unknown card ${i}`);
  assert.equal(index.cache.size, 128);
  assert.ok(index.matches("Teysa").every(item => cards.includes(item.card)));
});

test("direct request grammar preserves misspellings and does not swallow complex instructions", () => {
  assert.deepEqual(directRequest("Give me a deck based around {Teysa Karolv}."), { intent: "build_deck", cardName: "Teysa Karolv", source: "direct" });
  assert.equal(directRequest("Give me a card that works well with Yarok, the Desecrated.").intent, "recommend_card");
  assert.equal(directRequest("Build a deck around Teysa Karlov under $50."), null);
  assert.equal(directRequest("Tell me how graveyard triggers work."), null);
});

test("candidate pools cache by format and color identity and invalidate on reindex", () => {
  const store = new CardStore({ dataDir: ".", snapshotOnly: true });
  store.index(cards);
  assert.equal(store.candidates({}), store.candidates({}));
  store.index([cards[0]]);
  assert.equal(store.candidates({}).length, 1);
});

async function fixture(t, { inferenceFails = false } = {}) {
  const store = new CardStore({ dataDir: ".", snapshotOnly: true });
  store.index(cards); store.checkedAt = Date.now();
  store.metadata = async () => ({ loaded: true });
  let parses = 0;
  let explanations = 0;
  const ollama = { parseIntent: async () => { parses++; return { intent: "recommend_card", cardName: "Teysa Karlov" }; },
    explain: async () => { explanations++; if (inferenceFails) throw Error("Ollama offline"); return { text: "Validated explanation" }; } };
  const app = createApp({ store, ollama, production: false });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = body => fetch(`${url}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format: "commander", maxPrice: 2, ...body }) });
  async function result(response) {
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const { jobId } = await response.json();
    await new Promise(resolve => setImmediate(resolve));
    return (await fetch(`${url}/api/jobs/${jobId}`, { headers: { Cookie: cookie } })).json();
  }
  return { app, post, result, counts: () => ({ parses, explanations }) };
}

test("ambiguous direct requests return choices before queueing inference", async t => {
  const { post, app, counts } = await fixture(t);
  const response = await post({ message: "Give me a card that works well with Teysa." });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.kind, "clarification");
  assert.equal(data.resolution.status, "ambiguous");
  assert.equal(app.jobs.jobs.size, 0);
  assert.deepEqual(counts(), { parses: 0, explanations: 0 });
});

test("a direct typo skips model parsing but still requires a real model explanation", async t => {
  const { post, result, counts } = await fixture(t);
  const response = await post({ message: "Give me a card that works well with Teysa Karolv." });
  assert.equal(response.status, 202);
  const job = await result(response);
  assert.equal(job.status, "complete");
  assert.equal(job.result.anchor.name, "Teysa Karlov");
  assert.equal(job.result.resolution.status, "corrected");
  assert.deepEqual(counts(), { parses: 0, explanations: 1 });
});

test("confirmation requires an exact catalog card and a valid intent", async t => {
  const { post, result, counts } = await fixture(t);
  assert.equal((await post({ message: "Teysa", anchorName: "invented", intent: "recommend_card" })).status, 422);
  assert.equal((await post({ message: "Teysa", anchorName: "Teysa Karlov", intent: "run_command" })).status, 400);
  const job = await result(await post({ message: "Give me a card that works well with Teysa.", anchorName: "Teysa Karlov", intent: "recommend_card" }));
  assert.equal(job.status, "complete");
  assert.equal(job.result.resolution.status, "selected");
  assert.deepEqual(counts(), { parses: 0, explanations: 1 });
});

test("card budgets accept 40 and boundary values, and reject invalid values before inference", async t => {
  const { post, result, counts } = await fixture(t);
  const message = "Give me a card that works well with Teysa Karlov.";
  for (const maxPrice of [0, 0.24, 50.01, 100, "40"]) {
    assert.equal((await post({ message, maxPrice })).status, 400);
  }
  assert.deepEqual(counts(), { parses: 0, explanations: 0 });
  for (const maxPrice of [2.37, 40, 50]) {
    const job = await result(await post({ message, maxPrice }));
    assert.equal(job.status, "complete");
  }
  const low = await result(await post({ message, maxPrice: 0.25 }));
  assert.equal(low.status, "failed");
  assert.equal(low.error.status, 422);
});

test("model failure never becomes a deterministic fallback answer", async t => {
  const { post, result } = await fixture(t, { inferenceFails: true });
  const job = await result(await post({ message: "Give me a card that works well with Teysa Karlov." }));
  assert.equal(job.status, "failed");
  assert.equal(job.result, undefined);
});

test("a model cannot invent an anchor name that the user did not mention", async t => {
  const { post, result, counts } = await fixture(t);
  const job = await result(await post({ message: "Tell me something about absolutely no named card." }));
  assert.equal(job.status, "failed");
  assert.equal(job.error.status, 422);
  assert.deepEqual(counts(), { parses: 1, explanations: 0 });
});
