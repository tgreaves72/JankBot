const fs = require("node:fs/promises");
const { createWriteStream } = require("node:fs");
const { once } = require("node:events");

async function main() {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error("Provide source and destination snapshot paths.");
  const cards = JSON.parse(await fs.readFile(source, "utf8"));
  if (!Array.isArray(cards) || !cards.length) throw new Error("Source index is empty.");
  const stream = createWriteStream(`${destination}.tmp`);
  const finished = once(stream, "finish");
  // The server reads line-by-line to avoid holding the full serialized index during startup.
  for (const card of cards) if (!stream.write(`${JSON.stringify(card)}\n`)) await once(stream, "drain");
  stream.end();
  await finished;
  await fs.rename(`${destination}.tmp`, destination);
  console.log(`Prepared read-only demo snapshot: ${cards.length} cards.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
