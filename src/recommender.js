const { asText, normalizeName } = require("./scryfall");

const ROLE_PATTERNS = [
  ["ramp", /\b(add|search your library for a basic land|treasure|mana of any color|mana rock|land onto the battlefield)\b/],
  ["draw", /\b(draw|investigate|connive|impulse draw|look at the top)\b/],
  ["removal", /\b(destroy target|exile target|deals? .* damage to target|return target .* to .* hand|counter target)\b/],
  ["wipe", /\b(destroy all|exile all|each creature|all creatures|get -\d\/-\d)\b/],
  ["protection", /\b(hexproof|indestructible|protection from|phase out|prevent all|ward|regenerate)\b/],
  ["recursion", /\b(return .* from your graveyard|graveyard to the battlefield|escape|reanimate|flashback)\b/],
  ["token", /\b(create .* token|populate|incubate)\b/],
  ["sacrifice", /\b(sacrifice|dies|whenever .* dies)\b/],
  ["counter", /\b(counter|proliferate|oil counter|\+1\/\+1 counter|loyalty counter)\b/],
  ["equipment", /\b(equip|equipment|attached|attach)\b/],
  ["combat", /\b(attacks|combat damage|double strike|trample|haste|menace|flying|vigilance)\b/],
  ["finisher", /\b(you win the game|each opponent loses|double.*damage|extra combat|extra turn)\b/]
];

const CURVE_TARGET = {
  0: 3,
  1: 7,
  2: 14,
  3: 14,
  4: 11,
  5: 6,
  6: 4,
  7: 2
};

function uniqueWords(text) {
  return Array.from(new Set(String(text).toLowerCase().match(/[a-z][a-z-]{2,}/g) || []))
    .filter(word => !STOP_WORDS.has(word));
}

const STOP_WORDS = new Set([
  "the", "and", "you", "your", "that", "this", "with", "from", "into", "onto", "card", "cards",
  "creature", "target", "battlefield", "mana", "turn", "until", "each", "whenever", "when", "where"
]);

function roles(card) {
  const text = asText(card);
  const found = ROLE_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([role]) => role);
  if (/land/.test(card.type_line.toLowerCase())) found.push("land");
  if (/creature/.test(card.type_line.toLowerCase())) found.push("creature");
  return Array.from(new Set(found));
}

function priceScore(card, maxPrice = 2) {
  const price = card.cheapest_usd;
  if (!price) return 0.45;
  if (price <= 0.25) return 1;
  if (price <= maxPrice) return 0.9 - (price / maxPrice) * 0.25;
  return Math.max(0.05, 0.55 - Math.log(price / maxPrice + 1) / 2.5);
}

function popularityScore(card) {
  if (!card.edhrec_rank) return 0.35;
  return Math.max(0.1, 1 - Math.log10(card.edhrec_rank) / 5);
}

function overlapScore(anchor, card) {
  const anchorText = asText(anchor);
  const cardText = asText(card);
  const anchorWords = uniqueWords(anchorText);
  const cardWords = new Set(uniqueWords(cardText));
  const hits = anchorWords.filter(word => cardWords.has(word));

  let score = Math.min(0.45, hits.length * 0.035);
  const anchorRoles = new Set(roles(anchor));
  for (const role of roles(card)) {
    if (anchorRoles.has(role)) score += 0.08;
  }

  for (const keyword of anchor.keywords || []) {
    if ((card.keywords || []).includes(keyword)) score += 0.05;
    if (cardText.includes(keyword.toLowerCase())) score += 0.04;
  }

  if (/enters/.test(anchorText) && /(blink|exile .* return|enters)/.test(cardText)) score += 0.18;
  if (/token/.test(anchorText) && /token/.test(cardText)) score += 0.18;
  if (/sacrifice|dies/.test(anchorText) && /sacrifice|dies|graveyard/.test(cardText)) score += 0.18;
  if (/counter|proliferate/.test(anchorText) && /counter|proliferate/.test(cardText)) score += 0.18;
  if (/artifact/.test(anchorText) && /artifact/.test(cardText + " " + card.type_line.toLowerCase())) score += 0.14;
  if (/enchantment/.test(anchorText) && /enchantment/.test(cardText + " " + card.type_line.toLowerCase())) score += 0.14;
  if (/instant|sorcery/.test(anchorText) && /instant|sorcery|magecraft|prowess/.test(cardText + " " + card.type_line.toLowerCase())) score += 0.14;

  return Math.min(1, score);
}

function curveScore(card) {
  const cmc = Math.min(7, Math.floor(card.cmc || 0));
  if (cmc <= 2) return 0.95;
  if (cmc === 3) return 0.85;
  if (cmc === 4) return 0.72;
  if (cmc === 5) return 0.55;
  return 0.35;
}

function scoreCard(anchor, card, constraints = {}) {
  if (normalizeName(anchor.name) === normalizeName(card.name)) return null;
  const r = roles(card);
  const synergy = overlapScore(anchor, card);
  const roleFit = r.includes("land") ? 0.25 : Math.min(1, r.length * 0.18 + 0.25);
  const score =
    synergy * 0.45 +
    roleFit * 0.15 +
    1 * 0.10 +
    curveScore(card) * 0.10 +
    priceScore(card, constraints.maxPrice) * 0.15 +
    popularityScore(card) * 0.05;
  return {
    card,
    score,
    synergy,
    roles: r,
    priceScore: priceScore(card, constraints.maxPrice),
    reasons: reasons(anchor, card, r)
  };
}

function reasons(anchor, card, cardRoles) {
  const text = asText(card);
  const anchorText = asText(anchor);
  const out = [];
  if (cardRoles.length) out.push(`fills ${cardRoles.slice(0, 3).join(", ")}`);
  if (/token/.test(anchorText) && /token/.test(text)) out.push("shares the token plan");
  if (/sacrifice|dies/.test(anchorText) && /sacrifice|dies|graveyard/.test(text)) out.push("supports death and sacrifice loops");
  if (/enters/.test(anchorText) && /(enters|exile .* return|blink)/.test(text)) out.push("improves enter-the-battlefield value");
  if ((anchor.keywords || []).some(keyword => (card.keywords || []).includes(keyword))) out.push("shares relevant keywords");
  if (card.cheapest_usd && card.cheapest_usd <= 1) out.push("keeps the budget low");
  return out.slice(0, 4);
}

async function rankedPool({ anchor, store, constraints }) {
  const pool = store.candidates({
    colorIdentity: anchor.color_identity || [],
    format: constraints.format || "commander"
  });
  return pool
    .map(card => scoreCard(anchor, card, constraints))
    .filter(Boolean)
    .filter(item => item.score > 0.22)
    .sort((a, b) => b.score - a.score);
}

async function recommendCard({ anchor, store, constraints }) {
  const ranked = await rankedPool({ anchor, store, constraints });
  return {
    kind: "single_card",
    recommendation: ranked[0],
    alternatives: ranked.slice(1, 6),
    evaluated: ranked.length
  };
}

function addRole(deck, used, ranked, role, count) {
  for (const item of ranked) {
    if (deck.length >= 99) break;
    if (count <= 0) break;
    if (used.has(normalizeName(item.card.name))) continue;
    if (!item.roles.includes(role)) continue;
    deck.push(item);
    used.add(normalizeName(item.card.name));
    count--;
  }
}

function basicLandsFor(commander, count) {
  const map = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest" };
  const colors = commander.color_identity?.length ? commander.color_identity : ["C"];
  if (colors.includes("C") && colors.length === 1) {
    return Array.from({ length: count }, () => ({ card: basic("Wastes"), roles: ["land"], score: 0.5, reasons: ["basic mana source"] }));
  }
  const lands = [];
  for (let i = 0; i < count; i++) {
    lands.push({ card: basic(map[colors[i % colors.length]]), roles: ["land"], score: 0.5, reasons: ["basic mana source"] });
  }
  return lands;
}

function basic(name) {
  return {
    name,
    type_line: "Basic Land",
    cmc: 0,
    color_identity: [],
    legalities: { commander: "legal" },
    cheapest_usd: 0.05,
    image_uris: {},
    oracle_text: ""
  };
}

async function buildCommanderDeck({ commander, store, constraints }) {
  const ranked = await rankedPool({ anchor: commander, store, constraints: { ...constraints, format: "commander" } });
  const used = new Set([normalizeName(commander.name)]);
  const deck = [];

  const lands = ranked.filter(item => item.roles.includes("land") && item.card.cheapest_usd !== null)
    .filter(item => item.card.cheapest_usd <= Math.max(3, constraints.maxPrice * 2))
    .slice(0, 16);
  for (const land of lands) {
    deck.push(land);
    used.add(normalizeName(land.card.name));
  }

  addRole(deck, used, ranked, "ramp", 12);
  addRole(deck, used, ranked, "draw", 10);
  addRole(deck, used, ranked, "removal", 10);
  addRole(deck, used, ranked, "wipe", 3);
  addRole(deck, used, ranked, "protection", 6);
  addRole(deck, used, ranked, "recursion", 5);
  addRole(deck, used, ranked, "finisher", 5);

  for (const item of ranked) {
    if (deck.length >= 63) break;
    if (used.has(normalizeName(item.card.name))) continue;
    if (item.roles.includes("land")) continue;
    deck.push(item);
    used.add(normalizeName(item.card.name));
  }

  const basicCount = Math.max(0, 99 - deck.length);
  deck.push(...basicLandsFor(commander, basicCount));

  const allCards = [{ card: commander, roles: ["commander"], score: 1, reasons: ["anchor card"] }, ...deck].slice(0, 100);
  const total = allCards.reduce((sum, item) => sum + (Number(item.card.cheapest_usd) || 0), 0);
  const curve = {};
  for (const item of deck) {
    if (item.roles.includes("land")) continue;
    const key = String(Math.min(7, Math.floor(item.card.cmc || 0)));
    curve[key] = (curve[key] || 0) + 1;
  }
  const roleCounts = {};
  for (const item of deck) {
    for (const role of item.roles) roleCounts[role] = (roleCounts[role] || 0) + 1;
  }

  return {
    kind: "commander_deck",
    commander,
    cards: allCards,
    mainboard: deck,
    totalEstimatedUsd: Number(total.toFixed(2)),
    curve,
    curveTarget: CURVE_TARGET,
    roleCounts,
    evaluated: ranked.length,
    validation: validateCommanderDeck(commander, allCards)
  };
}

function validateCommanderDeck(commander, allCards) {
  const names = new Map();
  const allowed = new Set(commander.color_identity || []);
  const errors = [];
  const commanderName = normalizeName(commander.name);
  if (allCards.length !== 100) errors.push(`Commander deck must contain 100 cards; found ${allCards.length}.`);
  if (commander.legalities?.commander !== "legal") errors.push(`${commander.name} is not Commander legal.`);
  if (!/legendary/i.test(commander.type_line || "") && !/can be your commander/i.test(commander.oracle_text || "")) {
    errors.push(`${commander.name} is not a legal commander candidate.`);
  }
  for (const item of allCards) {
    const name = item.card.name;
    if (!/basic land/i.test(item.card.type_line || "")) {
      names.set(name, (names.get(name) || 0) + 1);
    }
    for (const color of item.card.color_identity || []) {
      if (!allowed.has(color)) errors.push(`${name} is outside ${commander.name}'s color identity.`);
    }
    if (item.card.legalities?.commander && item.card.legalities.commander !== "legal") {
      errors.push(`${name} is not Commander legal.`);
    }
  }
  if ((names.get(commander.name) || 0) !== 1 && !allCards.some(item => normalizeName(item.card.name) === commanderName)) {
    errors.push(`${commander.name} must appear exactly once as the commander.`);
  }
  for (const [name, count] of names) {
    if (count > 1) errors.push(`${name} appears ${count} times.`);
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  roles,
  scoreCard,
  recommendCard,
  buildCommanderDeck,
  validateCommanderDeck
};
