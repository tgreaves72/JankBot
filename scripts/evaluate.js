const path = require("node:path");
const { CardStore } = require("../src/scryfall");
const { buildCommanderDeck } = require("../src/recommender");
const { mainDeckIssue } = require("../src/deck-rules");
async function main() {
  const store = new CardStore({ dataDir: path.resolve(__dirname, "../data"), snapshotOnly: true });
  await store.load();
  const names = process.argv.slice(2);
  for (const name of names.length ? names : ["Teysa Karlov", "Yuriko, the Tiger's Shadow"]) {
    const started = performance.now();
    const commander = await store.resolveCard(name);
    if (!commander) throw new Error(`Commander not found: ${name}`);
    const deck = await buildCommanderDeck({ commander, store, constraints: { maxPrice: 10, totalBudget: 75 } });
    const ineligible = deck.cards.filter(item => mainDeckIssue(item.card));
    if (ineligible.length) throw new Error(`Ineligible main-deck cards selected: ${ineligible.map(item => item.card.name).join(", ")}`);
    console.log(JSON.stringify({ name, cards: deck.cards.length, lands: deck.mana.landCount, purchase: deck.purchaseEstimatedUsd,
      budget: deck.budget.ok, legality: deck.validation.ok, mainDeckEligible: !ineligible.length, quality: deck.quality, durationMs: Math.round(performance.now() - started), heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576) }));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
