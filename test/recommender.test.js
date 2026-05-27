const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreCard, validateCommanderDeck, roles } = require("../src/recommender");

const commander = {
  name: "Teysa Karlov",
  color_identity: ["W", "B"],
  type_line: "Legendary Creature — Human Advisor",
  oracle_text: "If a creature dying causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time. Creature tokens you control have vigilance and lifelink.",
  keywords: []
};

test("roles detect sacrifice and token cards", () => {
  const card = {
    name: "Example",
    type_line: "Creature",
    oracle_text: "Whenever another creature dies, create a 1/1 token. Sacrifice a creature: draw a card."
  };
  assert.equal(roles(card).includes("sacrifice"), true);
  assert.equal(roles(card).includes("token"), true);
  assert.equal(roles(card).includes("draw"), true);
});

test("scoreCard rewards overlapping sacrifice/token text and budget", () => {
  const card = {
    name: "Cruel Celebrant",
    color_identity: ["W", "B"],
    type_line: "Creature — Vampire",
    oracle_text: "Whenever Cruel Celebrant or another creature or planeswalker you control dies, each opponent loses 1 life and you gain 1 life.",
    keywords: [],
    cmc: 2,
    cheapest_usd: 0.3,
    legalities: { commander: "legal" }
  };
  const score = scoreCard(commander, card, { maxPrice: 2 });
  assert.ok(score.score > 0.45);
  assert.equal(score.roles.includes("sacrifice"), true);
});

test("validateCommanderDeck catches color identity violations", () => {
  const cards = [
    { card: commander, roles: ["commander"] },
    {
      card: {
        name: "Lightning Bolt",
        type_line: "Instant",
        color_identity: ["R"],
        legalities: { commander: "legal" }
      },
      roles: ["removal"]
    },
    ...Array.from({ length: 98 }, () => ({
      card: {
        name: "Plains",
        type_line: "Basic Land",
        color_identity: [],
        legalities: { commander: "legal" }
      },
      roles: ["land"]
    }))
  ];
  const validation = validateCommanderDeck(commander, cards);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /outside Teysa Karlov/);
});

test("validateCommanderDeck requires the commander to be present", () => {
  const cards = Array.from({ length: 100 }, () => ({
    card: {
      name: "Plains",
      type_line: "Basic Land",
      color_identity: [],
      legalities: { commander: "legal" }
    },
    roles: ["land"]
  }));
  const validation = validateCommanderDeck(commander, cards);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /must appear exactly once/);
});
