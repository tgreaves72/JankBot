const { Readable } = require("node:stream");
const { createGunzip } = require("node:zlib");
const { jsonLines } = require("./scryfall");
const HEADERS = { "User-Agent": "JankBot/2.0 (owner-controlled dataset preparation)", Accept: "application/json" };
async function* bulkRows(url) {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.hostname !== "data.scryfall.io") throw new Error("Unapproved bulk-data origin.");
  const response = await fetch(target, { headers: HEADERS, signal: AbortSignal.timeout(600_000), redirect: "error" });
  if (!response.ok) throw new Error(`Scryfall bulk data failed: ${response.status}`);
  const iterator = Readable.fromWeb(response.body)[Symbol.asyncIterator](), first = await iterator.next();
  if (first.done) throw new Error("Empty bulk dataset.");
  const source = Readable.from((async function* () { yield first.value; for (;;) { const next = await iterator.next(); if (next.done) return; yield next.value; } })());
  const decoded = first.value[0] === 31 && first.value[1] === 139 ? source.pipe(createGunzip()) : source;
  source.on("error", error => decoded.destroy(error));
  try { yield* jsonLines(decoded); } finally { source.destroy(); await iterator.return?.(); }
}
module.exports = { bulkRows, HEADERS };
