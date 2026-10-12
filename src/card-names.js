const Fuse = require("fuse.js");

function normalizeName(value) {
  return String(value || "").normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")
    .replace(/[\u2019']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

class CardNames {
  constructor(cards) {
    this.exact = new Map();
    this.cache = new Map();
    const records = [];
    for (const card of cards) {
      if (/^Card(?: \/\/ Card)?$/i.test(card.type_line || "")) continue;
      for (const name of new Set([card.name, ...(card.card_faces || []).map(face => face.name)].filter(Boolean))) {
        const normalized = normalizeName(name);
        const matches = this.exact.get(normalized) || [];
        if (!matches.includes(card)) matches.push(card);
        this.exact.set(normalized, matches);
        records.push({ normalized, card });
      }
    }
    this.records = records;
    this.fuse = new Fuse(records, { keys: ["normalized"], includeScore: true, ignoreLocation: true,
      ignoreFieldNorm: true, threshold: 0.32, minMatchCharLength: 2 });
  }

  matches(query) {
    const key = normalizeName(query);
    if (key.length < 2 || key.length > 160) return [];
    if (this.cache.has(key)) return this.cache.get(key);
    const seen = new Set();
    const matches = this.fuse.search(key, { limit: 32 }).filter(({ item }) => {
      if (seen.has(item.card.name)) return false;
      seen.add(item.card.name);
      return true;
    }).slice(0, 8).map(({ item, score }) => ({ card: item.card, score }));
    if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, matches);
    return matches;
  }

  resolve(query) {
    const key = normalizeName(query);
    const exact = this.exact.get(key);
    if (exact?.length === 1) return { status: "exact", card: exact[0], query };
    const matches = exact?.length ? exact.map(card => ({ card, score: 0 })) : this.matches(query);
    const first = matches[0];
    const gap = matches[1] ? matches[1].score - first.score : 1;
    // Fuzzy scores are ranking signals, not probabilities. Ambiguity always asks the user.
    if (!exact && key.length >= 7 && first && first.score <= 0.2 && gap >= 0.12
        && Math.abs(normalizeName(first.card.name).length - key.length) <= 3) {
      return { status: "corrected", card: first.card, query };
    }
    return { status: matches.length ? "ambiguous" : "missing", query,
      suggestions: matches.filter(match => match.score <= first.score + 0.12).slice(0, 5).map(({ card }) => ({ name: card.name, type_line: card.type_line,
        image: card.image_uris?.small || card.card_faces?.[0]?.image_uris?.small || "", price: card.cheapest_usd })) };
  }
}

function directRequest(message) {
  const text = message.trim().replace(/[?.!]+$/, "").trim();
  const deck = text.match(/^(?:(?:please\s+)?(?:give me|build(?: me)?|make(?: me)?|create(?: me)?)\s+)(?:(?:a|an)\s+)?(?:commander\s+)?deck\s+(?:based\s+)?(?:around|built around|based on|for)\s+(.+)$/i);
  const card = text.match(/^(?:(?:please\s+)?(?:give me|find(?: me)?|suggest(?: me)?|recommend(?: me)?)\s+)(?:(?:a|an|one)\s+)?card\s+(?:(?:that\s+)?(?:works well|pairs well|synergizes|works|goes well)\s+with|for)\s+(.+)$/i);
  const match = deck || card;
  if (!match || match[1].length > 120) return null;
  const cardName = match[1].replace(/^[{"']+|[}"']+$/g, "").trim();
  if (/\b(?:under|budget|less than|and|but|with a)\b|[$\n]/i.test(cardName)) return null;
  return { intent: deck ? "build_deck" : "recommend_card", cardName, source: "direct" };
}

module.exports = { CardNames, normalizeName, directRequest };
