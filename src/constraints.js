const { normalizeName } = require("./card-names");
function constraintsInput(input = {}) {
  const value = { maxPrice: input.maxPrice ?? 10, totalBudget: input.totalBudget ?? null, landCount: input.landCount ?? 37,
    owned: input.owned ?? {}, locked: input.locked ?? [], excluded: input.excluded ?? [], partner: input.partner ?? null };
  const fail = message => { const error = new Error(message); error.status = 400; throw error; };
  if (typeof value.maxPrice !== "number" || !Number.isFinite(value.maxPrice) || value.maxPrice < .25 || value.maxPrice > 50) fail("Budget must be between $0.25 and $50.");
  if (value.totalBudget !== null && (typeof value.totalBudget !== "number" || !Number.isFinite(value.totalBudget) || value.totalBudget < 1 || value.totalBudget > 10000)) fail("Total deck budget must be between $1 and $10,000, or blank.");
  if (!Number.isInteger(value.landCount) || value.landCount < 20 || value.landCount > 48) fail("Land count must be an integer between 20 and 48.");
  if (!value.owned || typeof value.owned !== "object" || Array.isArray(value.owned) || Object.keys(value.owned).length > 120) fail("Invalid owned-card quantities.");
  for (const [name, count] of Object.entries(value.owned)) if (!name || name.length > 160 || !Number.isInteger(count) || count < 0 || count > 100) fail("Owned quantities must be integers from 0 to 100.");
  for (const key of ["locked", "excluded"]) if (!Array.isArray(value[key]) || value[key].length > 100 || value[key].some(name => typeof name !== "string" || !name || name.length > 160)) fail(`Invalid ${key} card list.`);
  if (value.partner !== null && (typeof value.partner !== "string" || value.partner.length > 160)) fail("Invalid second commander.");
  return value;
}
function priceStats(items, input = {}) {
  const constraints = constraintsInput(input), used = new Map(), errors = [];
  const owned = new Map(Object.entries(constraints.owned).map(([name, count]) => [normalizeName(name), count]));
  let totalCents = 0, purchaseCents = 0, unpricedCards = 0, unpricedPurchases = 0;
  for (const { card } of items) {
    const key = normalizeName(card.name), count = (used.get(key) || 0) + 1;
    used.set(key, count);
    const purchased = count > (owned.get(key) || 0);
    if (card.cheapest_usd == null || !Number.isFinite(card.cheapest_usd)) {
      unpricedCards++;
      if (purchased) unpricedPurchases++;
      if (purchased) errors.push(`${card.name} has no tracked price; budget compliance cannot be verified.`);
    } else {
      const cents = Math.round(card.cheapest_usd * 100);
      totalCents += cents;
      if (purchased) {
        purchaseCents += cents;
        if (cents > Math.round(constraints.maxPrice * 100)) errors.push(`${card.name} exceeds the $${constraints.maxPrice.toFixed(2)} per-card limit.`);
      }
    }
  }
  if (constraints.totalBudget !== null && purchaseCents > Math.round(constraints.totalBudget * 100)) errors.push(`Purchase estimate $${(purchaseCents / 100).toFixed(2)} exceeds the $${constraints.totalBudget.toFixed(2)} total budget.`);
  return { totalEstimatedUsd: totalCents / 100, purchaseEstimatedUsd: purchaseCents / 100, unpricedCards, unpricedPurchases,
    budget: { ok: errors.length === 0, errors: [...new Set(errors)], complete: !unpricedPurchases, constraints,
      excludes: "Owned quantities; shipping and tax are not included" } };
}
module.exports = { constraintsInput, priceStats };
