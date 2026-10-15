const { normalizeName } = require("./card-names");

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
function frontType(card) { return card.card_faces?.[0]?.type_line || (card.type_line || "").split(" // ")[0]; }
function isLand(card) { return /\bLand\b/i.test(frontType(card)); }
function isBasic(card) { return /^Basic(?: Snow)? Land\b/i.test(frontType(card)); }
function eligibleCommander(card) {
  const type = frontType(card);
  return /can be your commander/i.test(card.oracle_text || "") || /\bLegendary\b/i.test(type)
    && (/\bCreature\b/i.test(type) || /\b(Vehicle|Spacecraft)\b/i.test(type) && card.power != null && card.toughness != null);
}
function copyLimit(card, singleton = true) {
  if (isBasic(card) || /a deck can have any number of cards named/i.test(card.oracle_text || "")) return Infinity;
  const match = (card.oracle_text || "").match(/a deck can have up to (\w+) cards named/i);
  return match ? NUMBER_WORDS[match[1].toLowerCase()] || Number(match[1]) || 1 : singleton ? 1 : 4;
}
function canPair(a, b) {
  const at = a.oracle_text || "", bt = b.oracle_text || "";
  const partnerWith = card => (card.oracle_text || "").match(/Partner with ([^\n(]+)/i)?.[1]?.trim();
  if (partnerWith(a) || partnerWith(b)) return normalizeName(partnerWith(a)) === normalizeName(b.name)
    && normalizeName(partnerWith(b)) === normalizeName(a.name);
  if (/Choose a Background/i.test(at) && /Legendary Enchantment.*Background/i.test(frontType(b))
      || /Choose a Background/i.test(bt) && /Legendary Enchantment.*Background/i.test(frontType(a))) return true;
  const doctor = card => /Legendary Creature/i.test(frontType(card)) && /Time Lord Doctor/i.test(frontType(card))
    && frontType(card).split(/—|--/)[1]?.trim() === "Time Lord Doctor";
  if (/Doctor's companion/i.test(at) && doctor(b) || /Doctor's companion/i.test(bt) && doctor(a)) return true;
  if (/Friends forever/i.test(at) && /Friends forever/i.test(bt)) return true;
  const partner = card => (card.keywords || []).includes("Partner") || /^Partner(?:\s*\(|\s*$)/mi.test(card.oracle_text || "");
  return partner(a) && partner(b);
}
function validateCommanderDeck(commanders, items) {
  commanders = Array.isArray(commanders) ? commanders : [commanders];
  const errors = [], counts = new Map();
  const primary = commanders[0];
  if (!primary || commanders.length > 2) return { ok: false, errors: ["Select one commander or a legal pair."] };
  if (commanders.length === 2 && (!canPair(...commanders) || normalizeName(commanders[0].name) === normalizeName(commanders[1].name))) errors.push("These commanders do not form a legal commander pair.");
  for (const card of commanders) {
    const background = commanders.length === 2 && /Legendary Enchantment.*Background/i.test(frontType(card));
    if (!eligibleCommander(card) && !background) errors.push(`${card.name} is not a legal commander candidate.`);
    if (items.filter(item => normalizeName(item.card.name) === normalizeName(card.name)).length !== 1) errors.push(`${card.name} must appear exactly once as the commander.`);
  }
  const allowed = new Set(commanders.flatMap(card => card.color_identity || []));
  if (items.length !== 100) errors.push(`Commander deck must contain 100 cards; found ${items.length}.`);
  for (const { card } of items) {
    const key = normalizeName(card.name);
    counts.set(key, (counts.get(key) || 0) + 1);
    if (card.legalities?.commander !== "legal") errors.push(`${card.name} is not Commander legal.`);
    if ((card.color_identity || []).some(color => !allowed.has(color))) errors.push(`${card.name} is outside ${commanders.map(c => c.name).join(" / ")}'s color identity.`);
    if (counts.get(key) > copyLimit(card)) errors.push(`${card.name} exceeds its copy limit.`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], rulesVersion: "Commander 2026-10", scope: "Deck construction; not a game simulator or bracket certification" };
}
module.exports = { frontType, isLand, isBasic, eligibleCommander, copyLimit, canPair, validateCommanderDeck };
