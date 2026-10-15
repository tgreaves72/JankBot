const fs = require("node:fs/promises");
const path = require("node:path");
const { createWriteStream } = require("node:fs");
const { once } = require("node:events");
const { bulkRows, HEADERS } = require("../src/bulk-data");

async function enrich(dataDir = path.resolve(__dirname, "../data")) {
  const indexPath = path.join(dataDir, "oracle-cards.compact.json");
  const cards = JSON.parse(await fs.readFile(indexPath, "utf8"));
  const response = await fetch("https://api.scryfall.com/bulk-data", { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Bulk metadata failed: ${response.status}`);
  const bulk = (await response.json()).data;
  const byOracle = new Map();
  for (const card of cards) {
    if (!byOracle.has(card.oracle_id)) byOracle.set(card.oracle_id, []);
    byOracle.get(card.oracle_id).push(card);
    card.printings = []; card.rulings = []; card.oracle_tags = [];
  }
  const dataset = type => { const value = bulk.find(row => row.type === type); if (!value?.jsonl_download_uri) throw new Error(`Missing required dataset: ${type}`); return value; };
  console.log("Indexing every available English paper printing and nonfoil USD price...");
  const prints = dataset("default_cards"); let printingCount = 0;
  for await (const row of bulkRows(prints.jsonl_download_uri)) {
    const matches = byOracle.get(row.oracle_id);
    if (!matches || row.lang !== "en" || !row.games?.includes("paper") || !row.nonfoil) continue;
    const usd = row.prices?.usd == null ? null : Number(row.prices.usd);
    if (usd === null || !Number.isFinite(usd) || usd <= 0) continue;
    printingCount++;
    const printing = { id: row.id, set: row.set, collector_number: row.collector_number, lang: row.lang, finish: "nonfoil", usd,
      scryfall_uri: row.scryfall_uri, image_uris: row.image_uris || row.card_faces?.[0]?.image_uris || {} };
    for (const card of matches) { card.printings.push(printing); card.printings.sort((a, b) => a.usd - b.usd || a.id.localeCompare(b.id)); card.printings.length = Math.min(3, card.printings.length); }
  }
  console.log("Importing Scryfall functional Oracle tags...");
  const tags = dataset("oracle_tags");
  for await (const tag of bulkRows(tags.jsonl_download_uri)) {
    if (typeof tag.slug !== "string" || !Array.isArray(tag.taggings)) throw new Error("Invalid functional-tag record.");
    for (const tagging of tag.taggings) for (const card of byOracle.get(tagging.oracle_id) || []) card.oracle_tags.push(tag.slug);
  }
  console.log("Importing current official rulings...");
  const rulings = dataset("rulings");
  for await (const ruling of bulkRows(rulings.jsonl_download_uri)) {
    if (ruling.source !== "wotc") continue;
    for (const card of byOracle.get(ruling.oracle_id) || []) {
      card.rulings.push({ published_at: ruling.published_at, comment: ruling.comment });
      card.rulings.sort((a, b) => b.published_at.localeCompare(a.published_at)); card.rulings.length = Math.min(6, card.rulings.length);
    }
  }
  for (const card of cards) {
    card.selected_printing = card.printings[0] || null;
    card.cheapest_usd = card.selected_printing?.usd ?? null;
    card.price_updated_at = prints.updated_at;
    card.price_scope = "Lowest tracked English paper nonfoil USD price across imported printings; shipping and tax excluded";
    card.oracle_tags = [...new Set(card.oracle_tags)].sort();
    if (card.selected_printing) { card.image_uris = card.selected_printing.image_uris; card.scryfall_uri = card.selected_printing.scryfall_uri; }
    card.printings = card.printings.map(({ image_uris, ...printing }) => printing);
    if (card.selected_printing) { const { image_uris, ...printing } = card.selected_printing; card.selected_printing = printing; }
  }
  const metadata = JSON.parse(await fs.readFile(path.join(dataDir, "metadata.json"), "utf8"));
  Object.assign(metadata, { enrichmentVersion: 2, priceUpdatedAt: prints.updated_at, tagsUpdatedAt: tags.updated_at,
    rulingsUpdatedAt: rulings.updated_at, pricedPrintings: printingCount, enrichedAt: new Date().toISOString() });
  await fs.writeFile(`${indexPath}.tmp`, JSON.stringify(cards));
  await fs.rename(`${indexPath}.tmp`, indexPath);
  const snapshot = path.join(dataDir, "oracle-cards.compact.jsonl"), stream = createWriteStream(`${snapshot}.tmp`), finished = once(stream, "finish");
  for (const card of cards) if (!stream.write(`${JSON.stringify(card)}\n`)) await once(stream, "drain");
  stream.end(); await finished; await fs.rename(`${snapshot}.tmp`, snapshot);
  await fs.writeFile(path.join(dataDir, "metadata.json.tmp"), JSON.stringify(metadata));
  await fs.rename(path.join(dataDir, "metadata.json.tmp"), path.join(dataDir, "metadata.json"));
  console.log(JSON.stringify({ cards: cards.length, printingCount, ready: true }));
}
if (require.main === module) enrich(process.env.DATA_DIR).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { enrich };
