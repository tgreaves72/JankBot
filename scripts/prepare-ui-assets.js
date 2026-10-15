const fs = require("node:fs/promises");
const path = require("node:path");
const { ScryfallClient } = require("../src/scryfall");

async function main() {
  const root = path.join(__dirname, "..");
  const cards = JSON.parse(await fs.readFile(path.join(root, "data/oracle-cards.compact.json"), "utf8"));
  const client = new ScryfallClient({ appName: "JankBot/1.0", contact: "JankBot employer demo artwork preparation" });
  const assets = [["Command Tower", "art_crop", "art-command-tower.jpg"], ["Teysa Karlov", "normal", "card-teysa.jpg"],
    ["Yarok, the Desecrated", "normal", "card-yarok.jpg"], ["Niv-Mizzet, Parun", "normal", "card-niv.jpg"]];
  const credits = [];
  for (const [name, kind, filename] of assets) {
    const card = cards.find(item => item.name === name);
    const url = new URL(card?.image_uris?.[kind]);
    if (url.protocol !== "https:" || url.hostname !== "cards.scryfall.io") throw Error(`Invalid artwork source for ${name}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "JankBot/1.0 (employer demo artwork preparation)", Accept: "image/jpeg" } });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/jpeg")) throw Error(`Artwork download failed for ${name}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 3_000_000 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw Error(`Invalid artwork bytes for ${name}`);
    const destination = path.join(root, "public", filename);
    await fs.writeFile(`${destination}.tmp`, bytes);
    await fs.rename(`${destination}.tmp`, destination);
    const uuid = url.pathname.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/)?.[0];
    if (!uuid) throw Error("Missing source printing ID.");
    const printing = await client.request(`/cards/${uuid}`);
    credits.push(`${name} - illustration by ${printing.artist}. ${printing.scryfall_uri}`);
  }
  for (const name of ["send", "log-out", "download", "pencil-line", "plus", "x", "trash-2", "check", "layers", "book-open", "undo-2", "redo-2", "upload"]) {
    await fs.copyFile(path.join(root, "node_modules/lucide-static/icons", `${name}.svg`), path.join(root, "public", `icon-${name}.svg`));
  }
  const license = await fs.readFile(path.join(root, "node_modules/lucide-static/LICENSE"), "utf8");
  await fs.writeFile(path.join(root, "public", "credits.txt"), `Magic: The Gathering card names, images and artwork are copyright Wizards of the Coast and their respective artists. JankBot is an unofficial fan project, not affiliated with Wizards of the Coast. Card data and imagery provided by Scryfall.\n\nOracle text, card legality, printing prices, functional tags and official rulings: https://scryfall.com/docs/api/bulk-data\nPublished combo records: https://commanderspellbook.com/ and https://spacecowmedia.github.io/commander-spellbook-backend/api.html\nCombo matching checks card quantities and required commanders, not board state or all prerequisites.\n\n${credits.join("\n")}\n\nLucide icons (lucide-static 0.468.0):\n${license}`);
  console.log("Prepared four Scryfall artwork assets, thirteen Lucide icons, and source credits.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
