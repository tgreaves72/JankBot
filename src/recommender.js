const { normalizeName } = require("./card-names");
const { features, roles, interactions } = require("./features");
const { isLand, isBasic, mainDeckIssue, commanderInclusionErrors, copyLimit, eligibleCommander, canPair, validateCommanderDeck } = require("./deck-rules");
const { constraintsInput, priceStats } = require("./constraints");
const TARGETS = { ramp: 10, draw: 10, removal: 8, wipe: 2, protection: 3, recursion: 3, finisher: 2 };
const MINIMUMS = { ramp: 6, draw: 6, removal: 5 };
const CURVE_TARGET = { 0: 2, 1: 10, 2: 17, 3: 14, 4: 10, 5: 5, 6: 3, 7: 2 };
function fail(message) { const error = new Error(message); error.status = 422; throw error; }
function ownedCount(card, constraints) { return Object.entries(constraints.owned || {}).find(([name]) => normalizeName(name) === normalizeName(card.name))?.[1] || 0; }
function scoreCard(anchor, card, constraints = {}) {
  if (normalizeName(anchor.name) === normalizeName(card.name)) return null;
  const r = roles(card), links = interactions(anchor, card);
  const synergy = Math.min(1, links.reduce((sum, link) => sum + link.strength, 0));
  const priceScore = card.cheapest_usd == null ? 0 : Math.max(0, 1 - card.cheapest_usd / (constraints.maxPrice || 10));
  const roleFit = r.filter(role => Object.hasOwn(TARGETS, role)).length;
  const score = synergy * .55 + Math.min(1, .35 + roleFit * .2) * .18 + priceScore * .12
    + (card.cmc <= 2 ? .1 : card.cmc <= 4 ? .075 : .035) + (card.edhrec_rank ? Math.max(0, 1 - Math.log10(card.edhrec_rank) / 5) : .35) * .05;
  return { card, roles: r, score, synergy, priceScore, reasons: links.map(link => link.reason).concat(roleFit ? [`fills ${r.filter(role => Object.hasOwn(TARGETS, role)).join(", ")}`] : []).slice(0, 4), evidence: features(card).evidence };
}
async function rankedPool({ anchor, store, constraints }) {
  const excluded = new Set(constraints.excluded.map(normalizeName));
  return store.candidates({ format: constraints.format || "commander", colorIdentity: constraints.colorIdentity || anchor.color_identity || [] })
    .filter(card => !mainDeckIssue(card) && ((constraints.format || "commander") !== "commander" || !commanderInclusionErrors(card, constraints.colorIdentity || anchor.color_identity || []).length))
    .filter(card => !excluded.has(normalizeName(card.name)) && (ownedCount(card, constraints) > 0 || card.cheapest_usd != null && card.cheapest_usd <= constraints.maxPrice))
    .map(card => scoreCard(anchor, card, constraints)).filter(Boolean).sort((a, b) => b.score - a.score || a.card.name.localeCompare(b.card.name));
}
async function recommendCard({ anchor, store, constraints: input = {} }) {
  const constraints = { ...constraintsInput(input), format: input.format };
  let ranked = await rankedPool({ anchor, store, constraints });
  if (constraints.totalBudget !== null) ranked = ranked.filter(item => ownedCount(item.card, constraints) > 0 || item.card.cheapest_usd <= constraints.totalBudget);
  if (input.replaceRole) ranked = ranked.filter(item => item.roles.includes(input.replaceRole));
  if (input.inDeck) { const used = new Set(input.inDeck.map(normalizeName)); ranked = ranked.filter(item => !used.has(normalizeName(item.card.name))); }
  return { kind: "single_card", recommendation: ranked[0], alternatives: ranked.slice(1, 6), evaluated: ranked.length, constraints };
}
function deckStats(items, constraints = {}) {
  const curve = {}, roleCounts = {}, sources = {}, demand = {};
  for (const item of items) {
    const r = roles(item.card);
    if (!isLand(item.card)) {
      const key = String(Math.min(7, Math.floor(item.card.cmc || 0))); curve[key] = (curve[key] || 0) + 1;
      for (const symbol of (item.card.mana_cost || "").matchAll(/\{([^}]+)\}/g)) for (const color of new Set(symbol[1].match(/[WUBRG]/g) || [])) demand[color] = (demand[color] || 0) + (item.card.cmc <= 3 ? 2 : 1);
    } else for (const color of item.card.produced_mana || item.card.color_identity || []) sources[color] = (sources[color] || 0) + 1;
    if (!item.roles?.includes("commander")) for (const role of r) roleCounts[role] = (roleCounts[role] || 0) + 1;
  }
  const deficits = Object.entries(MINIMUMS).filter(([role, target]) => (roleCounts[role] || 0) < target).map(([role, target]) => `${role}: ${(roleCounts[role] || 0)} / ${target} minimum`);
  return { ...priceStats(items, constraints), curve, roleCounts, mana: { sources, weightedDemand: demand, landCount: items.filter(item => isLand(item.card)).length, note: "Source counts and weighted mana symbols, not a casting-probability simulation" }, quality: { ok: !deficits.length, errors: deficits, targets: TARGETS }, curveTarget: CURVE_TARGET };
}
async function buildCommanderDeck({ commander, store, constraints: input = {} }) {
  const constraints = constraintsInput(input), commanders = [commander];
  if (constraints.partner) {
    const partner = await store.resolveCard(constraints.partner);
    if (!partner || partner.name !== constraints.partner || !canPair(commander, partner)) fail("Select a legal second commander for this commander.");
    commanders.push(partner);
  }
  if (!eligibleCommander(commander)) fail(`${commander.name} is not a legal commander candidate.`);
  const colorIdentity = [...new Set(commanders.flatMap(card => card.color_identity || []))];
  const ranked = await rankedPool({ anchor: commander, store, constraints: { ...constraints, colorIdentity, format: "commander" } });
  const excluded = new Set(constraints.excluded.map(normalizeName));
  if (commanders.some(card => excluded.has(normalizeName(card.name)))) fail("A commander cannot also be excluded.");
  const deck = commanders.map(card => ({ card, roles: ["commander"], score: 1, reasons: ["commander"], evidence: features(card).evidence }));
  const counts = new Map(commanders.map(card => [normalizeName(card.name), 1]));
  const locked = new Set(commanders.map(card => normalizeName(card.name)));
  const add = item => { deck.push(item); const key = normalizeName(item.card.name); counts.set(key, (counts.get(key) || 0) + 1); };
  for (const name of constraints.locked) {
    const key = normalizeName(name);
    if (commanders.some(card => normalizeName(card.name) === key)) continue;
    const card = await store.resolveCard(name);
    if (card) {
      const issues = commanderInclusionErrors(card, colorIdentity);
      if (issues.length) fail(issues.join(" "));
    }
    if (!card || card.name !== name || excluded.has(key) || (card.color_identity || []).some(color => !colorIdentity.includes(color)) || card.legalities?.commander !== "legal") fail(`Locked card cannot be included: ${name}`);
    if ((counts.get(key) || 0) >= copyLimit(card)) fail(`Locked card exceeds its copy limit: ${name}`);
    add(scoreCard(commander, card, constraints)); locked.add(key);
  }
  if (!priceStats(deck, constraints).budget.ok) fail(priceStats(deck, constraints).budget.errors.join(" "));
  if (deck.filter(item => isLand(item.card)).length > constraints.landCount || deck.filter(item => !isLand(item.card)).length > 100 - constraints.landCount) fail("Locked cards exceed the selected land or spell slots.");
  const nonlands = ranked.filter(item => !isLand(item.card) && !commanders.some(card => normalizeName(card.name) === normalizeName(item.card.name)));
  const available = item => (counts.get(normalizeName(item.card.name)) || 0) < copyLimit(item.card);
  const spellSlots = 100 - constraints.landCount;
  const spells = () => deck.filter(item => !isLand(item.card)).length;
  const countRole = role => deck.filter(item => !item.roles.includes("commander") && !isLand(item.card) && item.roles.includes(role)).length;
  for (const [role, target] of Object.entries(TARGETS)) while (countRole(role) < target && spells() < spellSlots) {
    const candidate = nonlands.find(item => available(item) && item.roles.includes(role)); if (!candidate) break; add(candidate);
  }
  while (spells() < spellSlots) {
    const curve = {};
    for (const item of deck.filter(item => !isLand(item.card))) { const key = Math.min(7, Math.floor(item.card.cmc || 0)); curve[key] = (curve[key] || 0) + 1; }
    const candidate = nonlands.filter(available).map(item => ({ item, score: item.score + Math.max(-.15, Math.min(.15, ((CURVE_TARGET[Math.min(7, Math.floor(item.card.cmc || 0))] || 0) - (curve[Math.min(7, Math.floor(item.card.cmc || 0))] || 0)) * .015)) })).sort((a, b) => b.score - a.score)[0]?.item;
    if (!candidate) fail("The constraints leave too few legal, priced nonland cards. Raise a budget limit or remove exclusions."); add(candidate);
  }
  const landPool = ranked.filter(item => isLand(item.card) && !isBasic(item.card) && available(item));
  for (const item of landPool.filter(item => (item.card.produced_mana || []).filter(color => colorIdentity.includes(color)).length >= Math.min(2, colorIdentity.length)).slice(0, 8)) {
    if (deck.filter(item => isLand(item.card)).length >= constraints.landCount) break; add(item);
  }
  const map = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest", C: "Wastes" };
  const colors = colorIdentity.length ? colorIdentity : ["C"];
  const basics = colors.map(color => {
    const card = store.byName.get(map[color]); if (!card || excluded.has(normalizeName(card.name))) fail(`Required basic land is missing or excluded: ${map[color]}`);
    return { color, item: { card, roles: ["land"], score: .5, reasons: ["colored mana source"], evidence: features(card).evidence } };
  });
  while (deck.length < 100) {
    const { mana } = deckStats(deck, constraints);
    const totalDemand = Object.values(mana.weightedDemand).reduce((sum, value) => sum + value, 0) || colors.length;
    const next = basics.map(basic => ({ ...basic, deficit: ((mana.weightedDemand[basic.color] || 1) / totalDemand) * constraints.landCount - (mana.sources[basic.color] || 0) })).sort((a, b) => b.deficit - a.deficit)[0]; add(next.item);
  }
  // Search cheaper legal substitutes without dropping nonland role coverage below minima.
  for (let step = 0; step < 100; step++) {
    const stats = deckStats(deck, constraints); if (stats.budget.ok) break;
    let best;
    for (let index = commanders.length; index < deck.length; index++) {
      const old = deck[index]; if (locked.has(normalizeName(old.card.name))) continue;
      const oldCost = ownedCount(old.card, constraints) >= (counts.get(normalizeName(old.card.name)) || 0) ? 0 : old.card.cheapest_usd ?? Infinity;
      for (const item of isLand(old.card) ? basics.map(b => b.item) : nonlands) {
        if (!available(item) || item.card.name === old.card.name) continue;
        const cost = ownedCount(item.card, constraints) > (counts.get(normalizeName(item.card.name)) || 0) ? 0 : item.card.cheapest_usd ?? Infinity;
        if (!(cost < oldCost)) continue;
        if (isLand(old.card)) {
          const oldSources = old.card.produced_mana || [], newSources = item.card.produced_mana || [];
          if (oldSources.some(color => colors.includes(color) && !newSources.includes(color)
              && (stats.mana.sources[color] || 0) - 1 < Math.min(8, Math.max(1, (stats.mana.weightedDemand[color] || 0))))) continue;
        }
        if (!isLand(old.card) && Object.entries(MINIMUMS).some(([role, min]) => old.roles.includes(role) && !item.roles.includes(role) && countRole(role) <= min)) continue;
        const saving = oldCost - cost; if (!best || saving > best.saving) best = { index, item, saving };
      }
    }
    if (!best) fail(`No budget-compliant deck found under these constraints. ${stats.budget.errors.join(" ")}`);
    const oldKey = normalizeName(deck[best.index].card.name); counts.set(oldKey, counts.get(oldKey) - 1); deck[best.index] = best.item;
    const key = normalizeName(best.item.card.name); counts.set(key, (counts.get(key) || 0) + 1);
  }
  const stats = deckStats(deck, constraints), validation = validateCommanderDeck(commanders, deck);
  if (!validation.ok || !stats.budget.ok || !stats.quality.ok) fail([...validation.errors, ...stats.budget.errors, ...stats.quality.errors.map(error => `Deck role requirement not met: ${error}`)].join(" "));
  return { kind: "commander_deck", format: "commander", commander, commanders, cards: deck, mainboard: deck.slice(commanders.length), ...stats, evaluated: ranked.length, validation, constraints,
    bracket: { status: "not_certified", note: "Discuss combos, extra turns, land denial and Game Changers with your table; legality is not a bracket certification." } };
}
module.exports = { roles, scoreCard, recommendCard, buildCommanderDeck, validateCommanderDeck, deckStats, TARGETS, MINIMUMS };
