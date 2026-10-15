const fs = require("node:fs/promises");
const { createWriteStream } = require("node:fs");
const { once } = require("node:events");
const path = require("node:path");
const { ScryfallClient } = require("../src/scryfall");
const { meldComponent } = require("../src/deck-rules");

async function enrichDeckZones(dataDir = path.resolve(__dirname, "../data")) {
  const indexPath = path.join(dataDir, "oracle-cards.compact.json");
  const cards = JSON.parse(await fs.readFile(indexPath, "utf8"));
  const client = new ScryfallClient({ appName: "JankBot/2.0", contact: "owner-only deck-zone preparation" });
  const components = new Map();
  for (let page = 1; ; page++) {
    if (page > 10) throw new Error("Meld metadata exceeded the owner-preparation page limit.");
    const result = await client.search("layout:meld", { unique: "cards", order: "name", page });
    if (!Array.isArray(result.data) || !result.data.length) throw new Error("Scryfall returned no meld metadata.");
    for (const card of result.data) {
      const component = meldComponent(card);
      if (card.layout !== "meld" || !card.oracle_id || !["meld_part", "meld_result"].includes(component)) throw new Error("Invalid Scryfall meld-component record.");
      if (components.has(card.oracle_id) && components.get(card.oracle_id) !== component) throw new Error("Conflicting meld-component metadata.");
      components.set(card.oracle_id, component);
    }
    if (!result.has_more) break;
  }
  let matched = 0;
  for (const card of cards) if (card.layout === "meld") {
    const component = components.get(card.oracle_id);
    if (!component) throw new Error(`Meld metadata is unavailable for ${card.name}; no snapshot was replaced.`);
    card.meld_component = component; matched++;
  }
  const snapshot = path.join(dataDir, "oracle-cards.compact.jsonl");
  await fs.writeFile(`${indexPath}.tmp`, JSON.stringify(cards));
  const output = createWriteStream(`${snapshot}.tmp`), finished = once(output, "finish");
  try {
    for (const card of cards) if (!output.write(`${JSON.stringify(card)}\n`)) await once(output, "drain");
    output.end(); await finished;
    await fs.rename(`${indexPath}.tmp`, indexPath); await fs.rename(`${snapshot}.tmp`, snapshot);
  } finally { if (!output.writableEnded) output.destroy(); }
  const metaPath = path.join(dataDir, "metadata.json"), metadata = JSON.parse(await fs.readFile(metaPath, "utf8"));
  Object.assign(metadata, { deckZonesVersion: 1, deckZonesUpdatedAt: new Date().toISOString(), meldCards: matched });
  await fs.writeFile(`${metaPath}.tmp`, JSON.stringify(metadata)); await fs.rename(`${metaPath}.tmp`, metaPath);
  console.log(JSON.stringify({ meldCards: matched, ready: true }));
}
if (require.main === module) enrichDeckZones(process.env.DATA_DIR).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { enrichDeckZones };
