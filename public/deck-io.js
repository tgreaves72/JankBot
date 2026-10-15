(function(root) {
  function parse(text) {
    if (typeof text !== "string" || text.length > 16000) throw new Error("Deck text must contain at most 16,000 characters.");
    const cards = [], commanders = [];
    let section = "main";
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (/^\[?(commander|commanders|command zone)\]?:?$/i.test(line)) { section = "commander"; continue; }
      if (/^\[?(deck|mainboard|main|decklist)\]?:?$/i.test(line)) { section = "main"; continue; }
      if (/^\[?(sideboard|maybeboard)\]?:?$/i.test(line)) throw new Error("Import only the main deck and commander sections, not sideboards or maybeboards.");
      const match = line.match(/^(?:(\d+)x?\s+)?(.+)$/i);
      const count = Number(match[1] || 1);
      const name = match[2].replace(/\s+\([A-Z0-9]{2,8}\)\s+[A-Za-z0-9-]+(?:\s+\*F\*)?$/i, "").trim();
      if (!Number.isInteger(count) || count < 1 || count > 100 || name.length > 160 || !name) throw new Error(`Invalid deck line: ${line}`);
      if (cards.length + count > 250) throw new Error("Imports may contain at most 250 cards.");
      for (let i = 0; i < count; i++) { cards.push(name); if (section === "commander") commanders.push(name); }
    }
    if (!cards.length) throw new Error("Enter a deck list first.");
    if (commanders.length > 2) throw new Error("Commander sections may contain at most two cards.");
    return { cards, commanders };
  }
  function quantities(names) {
    const map = new Map(); for (const name of names) map.set(name, (map.get(name) || 0) + 1);
    return [...map].map(([name, count]) => `${count} ${name}`).join("\n");
  }
  function format(names, commanders = []) {
    const remaining = [...names]; for (const name of commanders) { const index = remaining.indexOf(name); if (index < 0) throw new Error("Commander is missing from the deck."); remaining.splice(index, 1); }
    return (commanders.length ? `Commander\n${quantities(commanders)}\n\nDeck\n` : "Deck\n") + quantities(remaining) + "\n";
  }
  const api = { parse, format, quantities };
  if (typeof module === "object" && module.exports) module.exports = api; else root.JankBotDeckIO = api;
})(typeof globalThis === "undefined" ? this : globalThis);
