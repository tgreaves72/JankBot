const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { createGunzip } = require("node:zlib");
const { once } = require("node:events");
async function enrichCombos(dataDir = path.resolve(__dirname, "../data")) {
  const { parser } = await import("stream-json");
  const { pick } = await import("stream-json/filters/pick.js");
  const { streamArray } = await import("stream-json/streamers/stream-array.js");
  const { default: chain } = await import("stream-chain");
  const response = await fetch("https://json.commanderspellbook.com/variants.json.gz", { headers: { "User-Agent": "JankBot/2.0 (owner-only combo snapshot)" }, signal: AbortSignal.timeout(600000), redirect: "error" });
  if (!response.ok) throw new Error(`Spellbook export failed: ${response.status}`);
  const iterator = Readable.fromWeb(response.body)[Symbol.asyncIterator](), first = await iterator.next();
  if (first.done) throw new Error("Empty combo export.");
  const source = Readable.from((async function* () { yield first.value; for (;;) { const next = await iterator.next(); if (next.done) return; yield next.value; } })());
  const decoded = first.value[0] === 31 && first.value[1] === 139 ? source.pipe(createGunzip()) : source;
  let bytes = 0, depth = 0, records = 0;
  const sizeGuard = new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; done(bytes > 1024 * 1024 * 1024 ? new Error("Combo export exceeds the preparation size limit.") : null, chunk); } });
  const tokenGuard = new Transform({ objectMode: true, transform(token, _encoding, done) {
    if (["startObject", "startArray"].includes(token.name)) depth++;
    if (["endObject", "endArray"].includes(token.name)) depth--;
    done(depth > 32 || typeof token.value === "string" && token.value.length > 100000 ? new Error("Combo export exceeds schema limits.") : null, token);
  } });
  const input = chain([decoded, sizeGuard, parser(), tokenGuard, pick({ filter: "variants" }), streamArray()]);
  const target = path.join(dataDir, "combos.jsonl"), output = fs.createWriteStream(`${target}.tmp`), finished = once(output, "finish");
  try {
    for await (const { value: row } of input) {
      if (row.status !== "OK" || row.spoiler || !row.legalities?.commander || row.requires?.length) continue;
      if (!Array.isArray(row.uses) || row.uses.length < 2 || row.uses.length > 6 || !Array.isArray(row.produces)) continue;
      const uses = row.uses.map(use => ({ oracleId: use.card.oracleId, name: use.card.name, quantity: use.quantity, mustBeCommander: use.mustBeCommander, zones: use.zoneLocations,
        state: [use.battlefieldCardState, use.graveyardCardState, use.exileCardState, use.libraryCardState].filter(Boolean).join("; ") }));
      if (uses.some(use => !/^[a-f0-9-]{36}$/.test(use.oracleId) || !Number.isInteger(use.quantity) || use.quantity < 1)) throw new Error("Invalid combo card record.");
      const record = { id: row.id, uses, produces: row.produces.map(p => p.feature.name), prerequisites: [row.easyPrerequisites, row.notablePrerequisites, row.manaNeeded].filter(Boolean),
        description: row.description, source: `https://commanderspellbook.com/combo/${encodeURIComponent(row.id)}/` };
      if (JSON.stringify(record).length > 30000) throw new Error("Combo record exceeds schema limits.");
      if (!output.write(`${JSON.stringify(record)}\n`)) await once(output, "drain"); records++;
    }
    if (!records) throw new Error("No complete, concrete Commander combos found in the export.");
    output.end(); await finished; await fsp.rename(`${target}.tmp`, target);
    const metaPath = path.join(dataDir, "metadata.json"), metadata = JSON.parse(await fsp.readFile(metaPath, "utf8"));
    metadata.combosUpdatedAt = new Date().toISOString(); metadata.comboCount = records;
    metadata.comboScope = "Concrete published combinations only; template-dependent variants are not evaluated. Card presence does not verify board state or prerequisites.";
    await fsp.writeFile(`${metaPath}.tmp`, JSON.stringify(metadata)); await fsp.rename(`${metaPath}.tmp`, metaPath);
    console.log(JSON.stringify({ combos: records, ready: true }));
  } finally { input.destroy(); source.destroy(); if (!output.writableEnded) output.destroy(); }
}
if (require.main === module) enrichCombos(process.env.DATA_DIR).catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { enrichCombos };
