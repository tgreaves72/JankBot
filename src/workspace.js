const { normalizeName } = require("./card-names");
const { constraintsInput } = require("./constraints");
const { validateCommanderDeck } = require("./deck-rules");
const { scoreCard, roles, recommendCard, deckStats } = require("./recommender");
function invalid(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
async function exactCard(store, name) {
  if (typeof name !== "string" || !name || name.length > 160) invalid("Select an exact catalog card name.");
  const card = await store.resolveCard(name);
  if (!card || card.name !== name) invalid(`Select an exact catalog card: ${name}`, 422);
  return card;
}
async function readWorkspace(input, store) {
  if (input === undefined || input === null) return null;
  if (!input || typeof input !== "object" || !Array.isArray(input.cards) || input.cards.length < 1 || input.cards.length > 100
      || !Number.isSafeInteger(input.revision) || input.revision < 0) invalid("Invalid workspace revision or card list.");
  const cards = [], resolved = new Map();
  for (const name of input.cards) { if (!resolved.has(name)) resolved.set(name, await exactCard(store, name)); cards.push({ card: resolved.get(name), roles: roles(resolved.get(name)) }); }
  const anchor = await exactCard(store, input.commander);
  const selected = resolved.get(input.selectedName) || (input.selectedName === anchor.name ? anchor : await exactCard(store, input.selectedName));
  if (!selected) invalid("Selected card does not belong to this workspace.");
  let commanders = [];
  if (input.kind === "commander_deck") {
    const names = input.commanders || [anchor.name];
    if (!Array.isArray(names) || names.length < 1 || names.length > 2 || names[0] !== anchor.name) invalid("Invalid commander selection.");
    commanders = names.map(name => resolved.get(name));
    if (commanders.some(card => !card)) invalid("A workspace commander is missing.");
    const validation = validateCommanderDeck(commanders, cards);
    if (!validation.ok) invalid(validation.errors.join(" "), 422);
    commanders.forEach(card => { const item = cards.find(item => item.card.name === card.name); item.roles = [...new Set([...item.roles, "commander"])]; });
  }
  const recent = input.recent || [];
  if (!Array.isArray(recent) || recent.length > 6 || recent.some(row => !row || !["user", "assistant"].includes(row.role) || typeof row.content !== "string" || row.content.length > 700)) invalid("Conversation context is too large or invalid.");
  return { revision: input.revision, kind: input.kind, anchor, selected, cards, commanders, recent };
}
function directAction(message, workspace) {
  if (!workspace) return null;
  const text = message.trim();
  const budget = text.match(/^(?:keep (?:the|my) commander and )?(?:bring|make|rebuild|change)\b.*?(?:under|below|budget(?: of| to)?)\s*\$(\d+(?:\.\d{1,2})?)\.?$/i);
  if (budget) return { intent: "revise_constraints", cardName: workspace.anchor.name, totalBudget: Number(budget[1]), source: "workspace" };
  const explain = text.match(/^Explain (?:why )?(.+?) (?:works with this deck|was chosen)\.?$/i);
  if (explain) return { intent: "explain_choice", cardName: explain[1], source: "workspace" };
  const replace = text.match(/^Find a cheaper replacement for (.+?), preserving its deck role\.?$/i);
  if (replace) return { intent: "propose_replacements", cardName: replace[1], source: "workspace" };
  if (/^(?:why was this selected card chosen|explain this card|explain the selected card)[?.!]*$/i.test(text)) return { intent: "explain_choice", cardName: workspace.selected.name, source: "workspace" };
  if (/^make (?:this|it|the deck) cheaper[?.!]*$/i.test(text)) return { intent: "clarify", question: "What total purchase budget should I use?", source: "workspace" };
  return null;
}
function modelContext(workspace, message = "") {
  return workspace ? { commander: workspace.anchor.name, selectedCard: workspace.selected.name, deckVersion: workspace.revision,
    deckCards: [...new Set([workspace.anchor.name, workspace.selected.name, ...workspace.cards.filter(item => normalizeName(message).includes(normalizeName(item.card.name))).map(item => item.card.name)])], recent: workspace.recent.slice(-3) } : { commander: null, selectedCard: null, deckCards: [], recent: [] };
}
function proposedConstraints(plan, body) {
  const next = { ...body.constraints };
  for (const [key, field] of [["totalBudget", "totalBudget"], ["maxCardPriceUsd", "maxPrice"]]) if (plan[key] != null) {
    const numbers = [...body.message.matchAll(/\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
    if (!/budget|under|below|less than|cheaper|cost|price|limit|\$/i.test(body.message) || !numbers.includes(plan[key])) invalid("The model proposed a budget not explicitly present in your request. Use the budget controls.", 422);
    next[field] = plan[key];
  }
  return constraintsInput(next);
}
async function analyze({ plan, workspace, store, message, constraints }) {
  if (!workspace) invalid("Select a card or load a deck before requesting a contextual analysis.", 422);
  const card = plan.cardName ? await exactCard(store, plan.cardName) : workspace.selected;
  const cards = [card];
  if (plan.intent === "compare_cards") {
    if (!plan.compareCardName) invalid("Name a second card to compare.", 422);
    cards.push(await exactCard(store, plan.compareCardName));
  }
  const stats = deckStats(workspace.cards, constraints);
  return { kind: "analysis", cards: cards.map(card => scoreCard(workspace.anchor, card, constraints) || { card, roles: roles(card), score: 1 }),
    question: message, facts: { selected: workspace.selected.name, deckStats: { purchaseEstimatedUsd: stats.purchaseEstimatedUsd, roleCounts: stats.roleCounts, mana: stats.mana, budgetOk: stats.budget.ok },
      evidenceScope: "Supplied Oracle text, tracked prices, functional tags and latest official rulings. Not a full rules simulation." } };
}
async function replacements({ plan, workspace, store, constraints, message }) {
  if (!workspace?.commanders.length) invalid("Load a legal Commander deck before replacing a card.", 422);
  const old = plan.cardName ? await exactCard(store, plan.cardName) : workspace.selected;
  const index = workspace.cards.findIndex(item => item.card.name === old.name);
  if (index < 0 || workspace.commanders.some(card => card.name === old.name) || constraints.locked.includes(old.name)) invalid("This card is not replaceable. Unlock it or select a noncommander card in the deck.", 422);
  const rec = await recommendCard({ anchor: workspace.anchor, store, constraints: { ...constraints, format: "commander", inDeck: workspace.cards.map(item => item.card.name) } });
  const previous = deckStats(workspace.cards, constraints);
  for (const item of [rec.recommendation, ...rec.alternatives].filter(Boolean)) {
    if (/cheap|budget|less expensive|lower.*cost/i.test(message) && !(item.card.cheapest_usd < old.cheapest_usd)) continue;
    const next = workspace.cards.map((value, i) => i === index ? item : value);
    const stats = deckStats(next, constraints), validation = validateCommanderDeck(workspace.commanders, next);
    if (!stats.budget.ok || !validation.ok || Object.entries(previous.roleCounts).some(([role, count]) => ["ramp", "draw", "removal"].includes(role) && (stats.roleCounts[role] || 0) < Math.min(count, { ramp: 6, draw: 6, removal: 5 }[role]))) continue;
    return { kind: "commander_deck", format: "commander", commander: workspace.anchor, commanders: workspace.commanders, cards: next,
      mainboard: next.filter(value => !workspace.commanders.some(card => card.name === value.card.name)), ...stats, validation, constraints,
      changes: { removed: [old.name], added: [item.card.name] } };
  }
  invalid("No replacement in the ranked shortlist satisfies the budget, copy limits and role requirements. Change constraints or compare specific cards.", 422);
}
function diffCards(before, after) {
  const counts = new Map();
  for (const item of before) counts.set(item.card.name, (counts.get(item.card.name) || 0) - 1);
  for (const item of after) counts.set(item.card.name, (counts.get(item.card.name) || 0) + 1);
  return { added: [...counts].flatMap(([name, count]) => count > 0 ? Array(count).fill(name) : []), removed: [...counts].flatMap(([name, count]) => count < 0 ? Array(-count).fill(name) : []) };
}
module.exports = { exactCard, readWorkspace, directAction, modelContext, proposedConstraints, analyze, replacements, diffCards };
