const { asText } = require("./scryfall");
const { isLand, frontType } = require("./deck-rules");
const cache = new WeakMap();
const patterns = {
  ramp: /\badd \{[WUBRGC0-9]|add (?:one|two|three|an amount of|.*mana of any)|search your library for (?:a |up to .* )?(?:basic )?land|create .*treasure token|additional land on each|additional land during|land card.*onto the battlefield/i,
  draw: /\bdraw (?:a|an|one|two|three|four|five|six|seven|that many|cards|[0-9])|investigate|connive|exile the top.*(?:play|cast)|reveal the top.*put.*hand/i,
  removal: /destroy target|exile target|counter target (?:spell|activated|triggered)|return target.*to.*(?:owner.s|their).*hand|target creature gets -|deals? .*damage to (?:any target|target creature)/i,
  wipe: /destroy all (?:creatures|nonland)|exile all (?:creatures|nonland)|all creatures get -|each creature.*damage/i,
  protection: /hexproof|indestructible|protection from|phase out|ward\b|prevent all.*damage/i,
  recursion: /return .*from your graveyard|graveyard to the battlefield|escape\b|reanimate|flashback/i,
  token: /create .*token|creature tokens|populate|incubate/i,
  sacrifice: /sacrifice (?:a|another|one|two|three|any)|creature.*(?:dies|dying)|whenever .*dies/i,
  counters: /\+1\/\+1 counter|proliferate|charge counter|loyalty counter/i,
  equipment: /equip\b|equipment|attached|attach/i,
  combat: /combat damage|attacks|double strike|trample|haste|menace|flying|vigilance|can.t be blocked/i,
  finisher: /you win the game|each opponent loses|double.*damage|additional combat|extra turn/i,
  evasion: /flying|menace|can.t be blocked|unblockable|shadow\b|fear\b|intimidate/i,
  ninja: /ninja|ninjutsu/i
};
function features(card) {
  if (cache.has(card)) return cache.get(card);
  const text = asText(card), land = isLand(card), tags = new Set(card.oracle_tags || []);
  const roles = Object.entries(patterns).filter(([role, pattern]) => pattern.test(text)
    || [...tags].some(tag => tag === role || tag.startsWith(`${role}-`))).map(([role]) => role);
  if (land) { roles.splice(0, roles.length, "land"); }
  if (/\bCreature\b/i.test(frontType(card))) roles.push("creature");
  const result = { text, land, roles: [...new Set(roles)], tags, evidence: [] };
  for (const role of result.roles) result.evidence.push({ cardId: card.oracle_id || card.id || card.name, role,
    text: (card.oracle_text || card.card_faces?.[0]?.oracle_text || "").slice(0, 600), source: card.scryfall_uri || "", tags: [...tags].filter(tag => tag === role || tag.startsWith(`${role}-`)).slice(0, 5) });
  cache.set(card, result);
  return result;
}
function roles(card) { return [...features(card).roles]; }
function interactions(anchor, card) {
  const a = features(anchor), c = features(card), links = [];
  const add = (condition, strength, reason) => { if (condition) links.push({ strength, reason }); };
  add(/ninja|ninjutsu/.test(a.text) && c.roles.includes("evasion") && card.cmc <= 2, .65, "supplies a low-cost evasive attacker for ninjutsu");
  add(/ninja|ninjutsu/.test(a.text) && c.roles.includes("ninja"), .5, "shares the Ninja plan");
  add(/creature.*(?:dying|dies)|sacrifice a creature/.test(a.text) && c.roles.includes("sacrifice"), .55, "supports creature-death or sacrifice triggers");
  add(/creature.*(?:dying|dies)|sacrifice a creature/.test(a.text) && c.roles.includes("token"), .4, "supplies creatures that can support the death-trigger plan");
  add(/token/.test(a.text) && c.roles.includes("token"), .4, "supports the token plan");
  add(/enters|entering/.test(a.text) && /exile.*return.*battlefield|enters/.test(c.text), .35, "offers enter-the-battlefield interactions");
  add(/\+1\/\+1 counter|proliferate/.test(a.text) && c.roles.includes("counters"), .4, "supports permanent-counter interactions");
  add(/instant|sorcery|noncreature spell/.test(a.text) && /\bInstant\b|\bSorcery\b/i.test(frontType(card)), .3, "provides a spell for the commander's spell-focused plan");
  add(/artifact/.test(a.text) && /\bArtifact\b/i.test(frontType(card)), .25, "adds an artifact to the artifact-focused plan");
  for (const tag of a.tags) if (c.tags.has(tag) && !["creature", "land", "permanent", "removal", "draw"].includes(tag)) add(true, .06, `shares the Scryfall functional tag ${tag}`);
  return links.sort((x, y) => y.strength - x.strength).slice(0, 4);
}
module.exports = { features, roles, interactions };
