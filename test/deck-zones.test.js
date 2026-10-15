const test = require("node:test");
const assert = require("node:assert/strict");
const { meldComponent, mainDeckIssue, commanderInclusionErrors, eligibleCommander, validateCommanderDeck } = require("../src/deck-rules");
const { CardStore } = require("../src/scryfall");
const { buildCommanderDeck, recommendCard } = require("../src/recommender");
const { createApp, validateConstructedDeck, validateDeckPayload } = require("../server");
const { readWorkspace, modelContext } = require("../src/workspace");
const { once } = require("node:events");

const card = (name, extra = {}) => ({ name, oracle_id: name, id: name, type_line: "Creature", oracle_text: "", layout: "normal",
  color_identity: ["U"], legalities: { commander: "legal", modern: "legal", standard: "legal", pioneer: "legal", pauper: "legal" }, cheapest_usd: .1, cmc: 1, ...extra });
const leader = card("Leader", { type_line: "Legendary Creature", oracle_text: "Whenever a creature you control dies, draw a card." });
const island = card("Island", { type_line: "Basic Land - Island", produced_mana: ["U"], mana_cost: "", cmc: 0 });
const attraction = card("Balloon Stand", { type_line: "Artifact \u2014 Attraction", oracle_text: "Create a token. Draw a card. Sacrifice a creature.", color_identity: [] });
const front = card("Gisela, the Broken Blade", { type_line: "Legendary Creature - Angel Horror", layout: "meld", meld_component: "meld_part", color_identity: ["W"] });
const back = { ...front, name: "Brisela, Voice of Nightmares", id: "Brisela", oracle_id: "Brisela", meld_component: "meld_result" };
const listWith = entry => [{ card: leader }, { card: entry }, ...Array.from({ length: 98 }, () => ({ card: island }))];
function storeWith(extra = []) {
  const pool = Array.from({ length: 90 }, (_, i) => card(`Engine ${i}`, { oracle_text: i < 20 ? "{T}: Add {U}." : i < 40 ? "Draw a card." : i < 60 ? "Counter target spell." : "Flying" }));
  const store = new CardStore({ dataDir: ".", snapshotOnly: true }); store.index([leader, island, ...pool, ...extra]);
  store.checkedAt = Date.now(); store.ensureReady = async () => {}; store.metadata = async () => ({ loaded: true }); return store;
}

test("nontraditional objects cannot occupy main-deck slots even with legal format flags", () => {
  for (const type_line of ["Artifact - Attraction", "Artifact - Contraption", "Dungeon", "Plane - Ravnica", "Phenomenon", "Scheme", "Vanguard", "Conspiracy", "Stickers", "Token Creature - Goblin", "Emblem", "Hero", "Card // Card"]) {
    const entry = card(type_line, { type_line });
    assert.ok(mainDeckIssue(entry), type_line);
    assert.equal(validateCommanderDeck(leader, listWith(entry)).ok, false, type_line);
    assert.equal(validateConstructedDeck("modern", Array.from({ length: 60 }, () => ({ card: entry }))).ok, false, type_line);
  }
  for (const layout of ["token", "double_faced_token", "emblem", "art_series"]) assert.ok(mainDeckIssue(card(layout, { layout })));
});

test("ordinary cards mentioning Attractions or tokens, Battles, and double-faced fronts remain eligible", () => {
  for (const entry of [card("Attraction opener", { oracle_text: "Open an Attraction. Create a token." }),
    card("Battle", { type_line: "Battle - Siege", layout: "transform", card_faces: [{ type_line: "Battle - Siege" }, { type_line: "Creature" }] }),
    card("Spell // Land", { type_line: "Instant // Land", layout: "modal_dfc", card_faces: [{ type_line: "Instant" }, { type_line: "Land" }] }),
    card("Kindred", { type_line: "Kindred Instant - Elf" })]) assert.equal(mainDeckIssue(entry), null, entry.name);
});

test("meld results are rejected while verified meld fronts remain playable and commander-eligible", () => {
  assert.equal(mainDeckIssue(front), null); assert.equal(eligibleCommander(front), true);
  assert.match(mainDeckIssue(back), /melded back face/); assert.equal(eligibleCommander(back), false);
  assert.match(mainDeckIssue({ ...front, meld_component: null }), /metadata is missing/);
  assert.equal(mainDeckIssue({ ...front, meld_component: null, all_parts: [{ id: front.id, component: "meld_part" }] }), null);
});

test("alternate-printing meld relations require an exact unambiguous name and type match", () => {
  const alternate = { ...front, meld_component: null, all_parts: [{ id: "another-printing", name: front.name, type_line: front.type_line, component: "meld_part" }] };
  assert.equal(meldComponent(alternate), "meld_part"); assert.equal(mainDeckIssue(alternate), null);
  assert.equal(meldComponent({ ...alternate, name: "Another card" }), null);
  assert.equal(meldComponent({ ...alternate, all_parts: [...alternate.all_parts, { ...alternate.all_parts[0], component: "meld_result" }] }), null);
});

test("Commander basic land types obey color identity independently of incomplete color metadata", () => {
  const forest = card("Off-color typed land", { type_line: "Land - Forest", color_identity: [] });
  assert.match(commanderInclusionErrors(forest, ["U"]).join(" "), /903.5d/);
  assert.equal(commanderInclusionErrors(forest, ["U", "G"]).length, 0);
  assert.equal(commanderInclusionErrors(card("Any-color land", { type_line: "Land", color_identity: [], produced_mana: ["W", "U", "B", "R", "G"] }), ["U"]).length, 0);
});

test("candidate filtering excludes supplementary cards and meld backs but leaves catalog inspection available", () => {
  const store = storeWith([attraction, front, back]);
  assert.equal(store.byName.get(attraction.name), attraction);
  assert.ok(!store.candidates({ format: "commander", colorIdentity: ["U", "W"] }).includes(attraction));
  assert.ok(!store.candidates({ format: "commander", colorIdentity: ["U", "W"] }).includes(back));
  assert.ok(store.candidates({ format: "commander", colorIdentity: ["U", "W"] }).includes(front));
});

test("generation and recommendations independently reject illegal deck entries and locked-card bypasses", async () => {
  const store = storeWith([attraction]);
  const candidates = store.candidates.bind(store);
  store.candidates = options => [...candidates(options), attraction];
  const deck = await buildCommanderDeck({ commander: leader, store, constraints: { maxPrice: 2, totalBudget: 20 } });
  assert.equal(deck.cards.length, 100); assert.equal(deck.validation.ok, true);
  assert.ok(deck.cards.every(item => !mainDeckIssue(item.card)));
  const recommendation = await recommendCard({ anchor: leader, store, constraints: { format: "commander" } });
  assert.ok(![recommendation.recommendation, ...recommendation.alternatives].some(item => item?.card.name === attraction.name));
  await assert.rejects(buildCommanderDeck({ commander: leader, store, constraints: { locked: [attraction.name] } }), /separate Attraction deck/);
  await assert.rejects(buildCommanderDeck({ commander: back, store }), /not a legal commander candidate/);
});

test("manual deck validation reports a precise Attraction error instead of accepting the imported list", async () => {
  const result = await validateDeckPayload({ format: "commander", commander: leader.name, cards: listWith(attraction).map(item => item.card.name) }, storeWith([attraction]));
  assert.equal(result.validation.ok, false); assert.equal(result.cards.length, 100);
  assert.match(result.validation.errors.join(" "), /Balloon Stand: Attractions belong in a separate Attraction deck/);
  assert.equal(result.comboAnalysis.status, "not_checked_invalid_deck");
});

test("invalid saved lists remain diagnostic context and can receive a validated repair proposal", async t => {
  const store = storeWith([attraction]);
  const context = { kind: "commander_deck", revision: 7, commander: leader.name, selectedName: attraction.name, cards: listWith(attraction).map(item => item.card.name), recent: [] };
  const workspace = await readWorkspace(context, store);
  assert.equal(workspace.validation.ok, false); assert.equal(modelContext(workspace).construction.ok, false);
  const app = createApp({ store, production: true, ollama: {
    status: async () => ({ reachable: true, modelAvailable: true }),
    parseIntent: async () => { throw new Error("The explicit revision command should not need model intent guessing."); },
    explain: async ({ result }) => { assert.equal(result.validation.ok, true); return { text: "Proposed repair requires your review." }; }
  } });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const health = await fetch(base + "/api/health"), cookie = health.headers.get("set-cookie").split(";")[0];
  const accepted = await fetch(base + "/api/chat", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Keep the commander and bring the total deck purchase budget under $20.", format: "commander", maxPrice: 2, constraints: {}, context }) });
  assert.equal(accepted.status, 202); const { jobId } = await accepted.json();
  const events = await fetch(`${base}/api/jobs/${jobId}/events`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) });
  const frames = (await events.text()).split("\n\n").filter(frame => frame.startsWith("data: ")).map(frame => JSON.parse(frame.slice(6)));
  const job = frames.at(-1); assert.equal(job.status, "complete"); assert.equal(job.result.kind, "proposal");
  assert.equal(job.result.baseRevision, 7); assert.equal(job.result.result.validation.ok, true);
  assert.ok(job.result.result.changes.removed.includes(attraction.name));
  assert.ok(job.result.result.cards.every(item => !mainDeckIssue(item.card)));
  assert.equal(workspace.validation.ok, false); assert.ok(context.cards.includes(attraction.name));
});
