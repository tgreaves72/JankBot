const state = {
  lastPayload: null,
  activeCards: [],
  selectedIndex: null,
  history: [],
  busy: false,
  revision: 0,
  recent: [],
  constraints: { owned: {}, locked: [], excluded: [] },
  undo: [], redo: [], proposal: null,
  editor: {
    cards: [],
    validation: null,
    dirty: false
  }
};

const $ = selector => document.querySelector(selector);

const messages = $("#messages");
const input = $("#messageInput");
const form = $("#chatForm");
const suggestions = $("#suggestions");
const editorDialog = $("#deckEditor");
const editorAddInput = $("#editorAddInput");
const editorSuggestions = $("#editorSuggestions");

async function apiFetch(url, options) {
  const response = await fetch(url, { ...options, signal: options?.signal || AbortSignal.timeout(15_000) });
  if (response.status === 401) {
    void JankBotAccess.lock();
    throw new Error("Demo session expired. Reopen your JankBot invitation link to continue.");
  }
  return response;
}

function money(value) {
  if (value == null) return "Unpriced";
  const number = Number(value);
  if (!Number.isFinite(number)) return "n/a";
  return `$${number.toFixed(2)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function addMessage(role, html) {
  $("#opening").hidden = true;
  const article = document.createElement("article");
  article.className = `message ${role}`;
  article.innerHTML = `
    <div class="avatar">${role === "user" ? "You" : "JB"}</div>
    <div class="bubble">${html}</div>
  `;
  messages.append(article);
  messages.scrollTop = messages.scrollHeight;
  return article;
}

function cardImage(card) {
  return card?.image_uris?.normal || card?.image_uris?.large || card?.card_faces?.[0]?.image_uris?.normal || "";
}

function allCardsFromResult(result) {
  if (!result) return [];
  if (result.kind === "single_card") return [result.recommendation, ...result.alternatives];
  return result.cards;
}

function deckNames() {
  return state.activeCards.map(item => item.card.name);
}

function summarizeResultTitle(payload) {
  const result = payload.result;
  return result.kind !== "single_card"
    ? `${payload.anchor.name} deck`
    : `${result.recommendation.card.name} with ${payload.anchor.name}`;
}

function renderHealth(data) {
  $("#syncButton").hidden = true;
  $("#pullModelButton").hidden = true;
  state.metadata = data.cache;
  $("#cardCount").textContent = data.cache?.cardCount?.toLocaleString?.() || "not synced";
  $("#updatedAt").textContent = data.cache?.updatedAt ? new Date(data.cache.updatedAt).toLocaleString() : "not synced";
  const requested = data.ollama?.requestedModel || data.ollamaModel || "qwen2.5:0.5b";
  $("#modelName").textContent = requested;
  if (!data.ollama?.reachable) {
    $("#ollamaStatus").textContent = "service offline";
  } else if (!data.ollama?.modelAvailable) {
    $("#ollamaStatus").textContent = "model missing";
  } else {
    $("#ollamaStatus").textContent = "ready";
  }
}

async function loadHealth() {
  try {
    const response = await apiFetch("/api/health");
    if (!response.ok) throw new Error("Service unavailable");
    renderHealth(await response.json());
    if (state.lastPayload) renderMetrics(state.lastPayload.result);
  } catch { $("#ollamaStatus").textContent = "Service unavailable"; }
}

function renderHero(item, mode = "Anchor") {
  const card = item?.card || item;
  if (!card) return;
  state.inspectCard = card;
  const image = cardImage(card);
  const roles = (item.roles || []).slice(0, 5).map(role => `<span>${escapeHtml(role)}</span>`).join("");
  $("#heroCard").innerHTML = `
    ${image && /^https:\/\/cards\.scryfall\.io\//.test(image) ? `<img class="card-art" src="${escapeHtml(image)}" alt="${escapeHtml(card.name)}" width="488" height="680" decoding="async">` : `<div class="card-art-placeholder">No card image</div>`}
    <div>
      <p class="eyebrow">${escapeHtml(mode)}</p>
      <h2>${escapeHtml(card.name)}</h2>
      <p>${escapeHtml(card.type_line || "")}</p>
      <div class="hero-meta">
        <strong>${money(card.cheapest_usd)}</strong>
        <span>MV ${Number(card.cmc || 0)}</span>
        ${item.score ? `<span>Score ${Number(item.score).toFixed(2)}</span>` : ""}
      </div>
      <div class="role-tags">${roles}</div>
    </div>
  `;
  $("#selectedPrice").textContent = money(card.cheapest_usd);
  const source = card.scryfall_uri && /^https:\/\/scryfall\.com\/card\//.test(card.scryfall_uri) ? `<a href="${escapeHtml(card.scryfall_uri)}" target="_blank" rel="noopener noreferrer">Scryfall printing</a>` : "";
  $("#cardEvidence").innerHTML = `<details><summary>Oracle text &amp; evidence</summary><p class="oracle-text">${escapeHtml(card.oracle_text || "No Oracle text.")}</p>
    ${source}<p>${escapeHtml(card.selected_printing ? `${card.selected_printing.set.toUpperCase()} ${card.selected_printing.collector_number} · ${card.selected_printing.finish}` : "Printing price not verified")}</p>
    ${(card.rulings || []).map(ruling => `<p><small>${escapeHtml(ruling.published_at)}</small><br>${escapeHtml(ruling.comment)}</p>`).join("")}</details>`;
  $("#lockSelected").disabled = item.roles?.includes("commander") || state.lastPayload?.result.kind !== "commander_deck" || !state.activeCards.some(item => item.card.name === card.name);
  $("#lockSelected").checked = state.constraints.locked.includes(card.name) || item.roles?.includes("commander");
  $("#excludeSelected").disabled = Boolean(item.roles?.includes("commander"));
  $("#excludeSelected").checked = state.constraints.excluded.includes(card.name);
  $("#ownedQuantity").disabled = false; $("#ownedQuantity").value = state.constraints.owned[card.name] || 0;
  $("#explainSelected").disabled = false;
  $("#replaceSelected").disabled = $("#lockSelected").disabled;
}

function renderCurve(curve = {}) {
  const max = Math.max(1, ...Object.values(curve).map(Number));
  $("#curve").innerHTML = Array.from({ length: 8 }, (_, i) => {
    const count = Number(curve[String(i)] || 0);
    const label = i === 7 ? "7+" : String(i);
    const height = Math.max(8, (count / max) * 128);
    return `
      <div class="bar">
        <div class="bar-fill" style="height:${height}px" title="${count} cards"></div>
        <span>${label}</span>
      </div>
    `;
  }).join("");
}

function renderComboEvidence(result) {
  const analysis = result.comboAnalysis;
  if (!analysis) return "<p>Published combo checks have not run for this list.</p>";
  if (analysis.status !== "card_presence_only") return "<p>Published combo evidence is unavailable for this list. No combo conclusion is shown.</p>";
  const zones = { B: "battlefield", H: "hand", G: "graveyard", E: "exile", L: "library", C: "command zone" };
  return `<p>${analysis.matchedCount} published variants match card quantities; showing ${analysis.shown}. Card presence does not verify board state or prerequisites.</p><p>${escapeHtml(analysis.scope)}</p>` + (result.combos || []).map(combo =>
    `<details><summary>${escapeHtml(combo.produces.join(", "))}</summary><ul>${combo.uses.map(use => `<li>${use.quantity} ${escapeHtml(use.name)}: ${escapeHtml((use.zones || []).map(zone => zones[zone] || zone).join(" or "))}${use.mustBeCommander ? "; must be a commander" : ""}${use.state ? `; ${escapeHtml(use.state)}` : ""}</li>`).join("")}</ul><p class="oracle-text">${escapeHtml(combo.prerequisites.join("\n"))}</p><p class="oracle-text">${escapeHtml(combo.description)}</p>${/^https:\/\/commanderspellbook\.com\/combo\//.test(combo.source) ? `<a href="${escapeHtml(combo.source)}" target="_blank" rel="noopener noreferrer">Commander Spellbook</a>` : ""}</details>`).join("");
}

function renderMetrics(result) {
  const isDeck = result.kind !== "single_card";
  const total = isDeck ? result.totalEstimatedUsd : result.recommendation.card.cheapest_usd;
  $("#totalPrice").textContent = money(total);
  $("#deckSize").textContent = isDeck ? result.cards.length : "1";
  $("#validity").textContent = isDeck ? (result.validation.ok ? "Valid" : "Needs work") : "Legal";
  renderCurve(isDeck ? result.curve : { [Math.min(7, Math.floor(result.recommendation.card.cmc || 0))]: 1 });
  $("#priceCoverage").textContent = isDeck ? `Purchase estimate: ${money(result.purchaseEstimatedUsd)} · ${result.unpricedPurchases || 0} unpriced to buy · ${result.budget?.ok ? "within budget" : "budget needs validation"}. Prices as of ${state.metadata?.priceUpdatedAt ? new Date(state.metadata.priceUpdatedAt).toLocaleDateString() : "unknown"}. Shipping and tax excluded.` : "Tracked English paper nonfoil pricing; shipping and tax excluded.";
  $("#deckHealth").innerHTML = isDeck ? `<h3>Nonland roles</h3><dl class="role-counts">${Object.entries(result.quality?.targets || {}).map(([role, target]) => `<div><dt>${escapeHtml(role)}</dt><dd>${Number(result.roleCounts?.[role] || 0)} / ${target}</dd></div>`).join("")}</dl><h3>Mana sources</h3><p>${Object.entries(result.mana?.sources || {}).map(([color, count]) => `${escapeHtml(color)}: ${Number(count)}`).join(" · ")}</p><p>${escapeHtml(result.mana?.note || "Source analysis unavailable.")}</p><p>Bracket compatibility is not certified.</p><h3>Published combo evidence</h3>${renderComboEvidence(result)}` : "";
}

function renderDeck() {
  const query = $("#deckFilter").value.toLowerCase(), grouped = new Map(), groupMode = $("#deckGroup").value;
  const unique = new Map();
  state.activeCards.forEach((item, index) => { const name = item.card.name; if (!unique.has(name)) unique.set(name, { item, index, count: 0 }); unique.get(name).count++; });
  let rows = [...unique.values()].filter(({ item }) => `${item.card.name} ${item.card.type_line} ${(item.roles || []).join(" ")}`.toLowerCase().includes(query));
  const sort = $("#deckSort").value;
  rows.sort((a, b) => (sort === "name" ? a.item.card.name.localeCompare(b.item.card.name) : sort === "price" ? (a.item.card.cheapest_usd ?? Infinity) - (b.item.card.cheapest_usd ?? Infinity) : sort === "mana" ? a.item.card.cmc - b.item.card.cmc : b.item.score - a.item.score) || a.item.card.name.localeCompare(b.item.card.name));
  for (const row of rows) {
    const type = row.item.roles?.includes("commander") ? "Commanders" : ["Land", "Creature", "Instant", "Sorcery", "Planeswalker", "Artifact", "Enchantment", "Battle"].find(type => (row.item.card.card_faces?.[0]?.type_line || row.item.card.type_line).includes(type)) || "Other";
    const group = groupMode === "type" ? type : groupMode === "role" ? row.item.roles?.[0] || "Other" : "Cards";
    if (!grouped.has(group)) grouped.set(group, []); grouped.get(group).push(row);
  }
  $("#decklist").innerHTML = [...grouped].map(([group, entries]) => `<section class="deck-group"><h3>${escapeHtml(group)} <span>${entries.reduce((sum, row) => sum + row.count, 0)}</span></h3>${entries.map(({ item, index, count }) => {
    const card = item.card || item;
    const tags = (item.roles || []).slice(0, 4).map(role => `<span>${escapeHtml(role)}</span>`).join("");
    const active = index === state.selectedIndex ? " selected" : "";
    const thumbnail = card.image_uris?.art_crop || card.card_faces?.[0]?.image_uris?.art_crop;
    return `
      <button class="deck-card${active}" type="button" data-index="${index}">
        ${thumbnail && /^https:\/\/cards\.scryfall\.io\//.test(thumbnail) ? `<img class="deck-thumb" src="${escapeHtml(thumbnail)}" alt="" width="52" height="40" loading="lazy" decoding="async">` : '<span class="deck-thumb no-art" aria-hidden="true"></span>'}
        <span>
          <strong>${count > 1 ? `${count}x ` : ""}${escapeHtml(card.name)}</strong>
          <small>${escapeHtml(card.type_line || "")}</small>
        </span>
        <span class="price">${money(card.cheapest_usd)}</span>
        <span class="meta">Synergy ${Number(item.score || 0).toFixed(2)}${state.constraints.locked.includes(card.name) ? " · Locked" : ""}</span>
        <span class="role-tags">${tags}</span>
      </button>
    `;
  }).join("")}</section>`).join("") || '<p class="empty-history">No matching cards.</p>';
}

function renderHistory() {
  $("#history").innerHTML = state.history.length ? state.history.map((entry, index) => `
    <button class="history-item" type="button" data-history-index="${index}">
      <strong>${escapeHtml(entry.title)}</strong>
      <span>${escapeHtml(entry.subtitle)}</span>
    </button>
  `).join("") : '<p class="empty-history">No saved builds</p>';
}

function selectCard(index) {
  if (!state.activeCards[index]) return;
  state.selectedIndex = index;
  renderHero(state.activeCards[index], index === 0 && state.lastPayload?.result.kind === "commander_deck" ? "Commander" : "Selected card");
  for (const button of $("#decklist").querySelectorAll("[data-index]")) {
    button.classList.toggle("selected", Number(button.dataset.index) === index);
    button.setAttribute("aria-pressed", String(Number(button.dataset.index) === index));
  }
}

function setActivePayload(payload, { addToHistory = true, trackUndo = true } = {}) {
  if (state.lastPayload && trackUndo) { state.undo.push(structuredClone(state.lastPayload)); state.undo = state.undo.slice(-20); state.redo = []; }
  state.revision++;
  state.lastPayload = payload;
  $("#format").value = payload.format || "commander";
  const constraints = { ...(payload.constraints || payload.result.constraints || getConstraints()),
    partner: payload.result.kind === "commander_deck" ? payload.result.commanders?.[1]?.name || null : null };
  payload.constraints = constraints;
  writeConstraints(constraints);
  state.activeCards = allCardsFromResult(payload.result);
  state.selectedIndex = 0;
  renderMetrics(payload.result);
  renderDeck();
  selectCard(0);
  $("#exportButton").disabled = false;
  $("#editDeckButton").disabled = payload.result.kind !== "commander_deck";
  $("#undoButton").disabled = !state.undo.length; $("#redoButton").disabled = !state.redo.length;

  if (addToHistory) {
    const title = summarizeResultTitle(payload);
    state.history.unshift({
      title,
      subtitle: `${payload.result.kind === "commander_deck" ? payload.result.cards.length : 1} cards`,
      payload: structuredClone(payload)
    });
    state.history = state.history.slice(0, 8);
    renderHistory();
    void JankBotStorage.saveHistory(state.history).catch(error => addMessage("assistant", `<p>${escapeHtml(error.message)}</p>`));
  }
}

function completeChat(pending, payload) {
  if (payload.kind === "question") { pending.querySelector(".bubble").textContent = payload.message; return; }
  if (payload.kind === "clarification") {
    const choices = payload.resolution.suggestions || [];
    pending.clarification = payload;
    pending.querySelector(".bubble").innerHTML = `
      <p>${choices.length ? "Which card did you mean?" : "I couldn't find a matching card in the archive."}</p>
      <p class="query-note">${escapeHtml(payload.resolution.query)}</p>
      <div class="card-choices">${choices.map((card, index) => `<button type="button" class="card-choice" data-confirm-index="${index}">
        ${/^https:\/\/cards\.scryfall\.io\//.test(card.image) ? `<img src="${escapeHtml(card.image)}" width="44" height="61" alt="" loading="lazy">` : ""}
        <span><strong>${escapeHtml(card.name)}</strong><small>${escapeHtml(card.type_line || "")}</small></span><span>${money(card.price)}</span>
      </button>`).join("")}</div>`;
    input.value = payload.message;
    return;
  }
  pending.querySelector(".bubble").innerHTML = formatAssistant(payload);
  state.recent.push({ role: "assistant", content: payload.response.text.slice(0, 700) }); state.recent = state.recent.slice(-6);
  $("#requestStatus").textContent = "Assistant response ready.";
  if (payload.kind === "analysis") return;
  if (payload.kind === "proposal") { openProposal(payload); return; }
  if (payload.result.kind === "single_card" && state.lastPayload?.result.kind === "commander_deck") {
    const choices = [payload.result.recommendation, ...payload.result.alternatives];
    const holder = document.createElement("div"); holder.className = "recommendation-choices";
    holder.innerHTML = choices.map(item => `<button type="button" data-inspect-name="${escapeHtml(item.card.name)}">${escapeHtml(item.card.name)} · ${money(item.card.cheapest_usd)}</button>`).join("");
    pending.querySelector(".bubble").append(holder); return;
  }
  if (payload.baseRevision !== undefined && payload.baseRevision !== state.revision && payload.result.kind === "commander_deck") { payload.baseRevision = state.revision - 1; openProposal(payload); return; }
  setActivePayload(payload);
}

function formatAssistant(payload) {
  const result = payload.result;
  const modelLine = payload.model?.used
    ? `<small>${escapeHtml(payload.model.name)} &middot; ${payload.response.grounding === "evidence_selected" ? "Evidence-selected" : "Scryfall"}${payload.timing?.totalMs ? ` &middot; ${(payload.timing.totalMs / 1000).toFixed(1)}s` : ""}</small>`
    : `<small>Validated result.</small>`;
  const correction = payload.resolution?.status === "corrected" ? `<p class="correction-note">Using <strong>${escapeHtml(payload.resolution.name)}</strong> for &ldquo;${escapeHtml(payload.resolution.query)}&rdquo;.</p>` : "";
  const explanation = `<p>${escapeHtml(payload.response.text)}</p>${payload.response.synergySummary?.length ? `<ul>${payload.response.synergySummary.map(point => `<li>${escapeHtml(point)}</li>`).join("")}</ul>` : ""}${payload.response.budgetSummary ? `<p>${escapeHtml(payload.response.budgetSummary)}</p>` : ""}`;
  if (result.kind === "analysis") return `${explanation}<div class="analysis-cards">${result.cards.map(item => `<strong>${escapeHtml(item.card.name)} · ${money(item.card.cheapest_usd)}</strong><p class="oracle-text">${escapeHtml(item.card.oracle_text)}</p>`).join("")}</div>${modelLine}`;
  if (result.kind === "single_card") {
    const rec = result.recommendation;
    return `
      ${correction}
      ${explanation}
      <p><strong>${escapeHtml(rec.card.name)}</strong> - ${money(rec.card.cheapest_usd)} - score ${rec.score.toFixed(2)}</p>
      ${modelLine}
    `;
  }
  return `
    ${correction}
    ${explanation}
    <p><strong>${escapeHtml(payload.anchor.name)}</strong> - ${result.cards.length} cards - ${money(result.totalEstimatedUsd)}</p>
    ${modelLine}
  `;
}

const autocompleteRequests = new WeakMap();
async function autocompleteInto(target, menu, fragment) {
  autocompleteRequests.get(menu)?.abort();
  const controller = new AbortController();
  autocompleteRequests.set(menu, controller);
  const original = target.value;
  if (fragment.trim().length < 2) {
    menu.style.display = "none";
    return;
  }
  const response = await apiFetch(`/api/autocomplete?q=${encodeURIComponent(fragment.trim())}`, { signal: controller.signal });
  if (!response.ok) throw new Error("Card suggestions are unavailable.");
  const data = await response.json();
  if (controller.signal.aborted || target.value !== original) return;
  if (!data.data?.length) {
    menu.style.display = "none";
    return;
  }
  menu.innerHTML = data.data.map((name, index) => `<button type="button" role="option" aria-selected="false" id="${menu.id}-${index}">${escapeHtml(name)}</button>`).join("");
  menu.setAttribute("role", "listbox");
  menu.style.display = "block";
}

function editorNames() {
  return state.editor.cards.map(item => item.card.name);
}

function renderEditorList() {
  $("#editorList").innerHTML = state.editor.cards.map((item, index) => {
    const card = item.card;
    const isCommander = commanderNames().includes(card.name) || state.constraints.locked.includes(card.name);
    return `
      <article class="editor-row">
        <button type="button" class="editor-card-select" data-editor-index="${index}">
          <strong>${escapeHtml(card.name)}</strong>
          <span>${escapeHtml(card.type_line || "")}</span>
        </button>
        <span>${money(card.cheapest_usd)}</span>
        <button type="button" class="remove-card icon-button" aria-label="Remove ${escapeHtml(card.name)}" title="${isCommander ? "Commander slot is locked" : "Remove card"}" data-remove-index="${index}" ${isCommander ? "disabled" : ""}><span class="icon icon-trash-2" aria-hidden="true"></span></button>
      </article>
    `;
  }).join("");
}

function renderEditorValidation(validationResult) {
  const validation = validationResult?.validation;
  const ok = validation?.ok === true;
  $("#editorCount").textContent = state.editor.cards.length;
  $("#editorPrice").textContent = money(validationResult?.totalEstimatedUsd ?? state.editor.cards.reduce((sum, item) => sum + (Number(item.card.cheapest_usd) || 0), 0));
  $("#editorStatus").textContent = validation ? (ok ? "Valid" : "Invalid") : "Unchecked";
  $("#saveEditorButton").disabled = !ok;
  $("#editorValidation").innerHTML = `
    <h3>Validation</h3>
    ${validation ? `<p class="${ok ? "valid-text" : "invalid-text"}">${ok ? "This deck is legal for the selected format." : "Resolve these issues before saving."}</p>` : "<p>Make an edit to check format legality.</p>"}
    ${validation?.errors?.length ? `<ul>${validation.errors.map(error => `<li>${escapeHtml(error)}</li>`).join("")}</ul>` : ""}
  `;
}

async function validateEditor() {
  const revision = state.editor.revision;
  const payload = {
    format: state.lastPayload.format || state.lastPayload.result.format || "commander",
    commander: state.lastPayload?.anchor?.name,
    commanders: commanderNames(), constraints: getConstraints(),
    cards: editorNames()
  };
  const response = await apiFetch("/api/deck/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Deck validation failed");
  if (revision !== state.editor.revision) throw new Error("Deck changed during validation. Validate the current draft.");
  state.editor.validation = result;
  renderEditorValidation(result);
  return result;
}

async function addEditorCard(name) {
  const response = await apiFetch(`/api/card?name=${encodeURIComponent(name)}`);
  const card = await response.json();
  if (!response.ok) throw new Error(card.error || "Card not found");
  state.editor.cards.push({
    card,
    roles: [],
    score: 0,
    reasons: ["manual add"]
  });
  state.editor.dirty = true;
  state.editor.validation = null;
  state.editor.revision++;
  renderEditorList();
  renderEditorValidation(null);
}

function openEditor() {
  if (!state.lastPayload || state.lastPayload.result.kind !== "commander_deck") return;
  state.editor.cards = structuredClone(state.activeCards);
  state.editor.validation = state.lastPayload.result;
  state.editor.dirty = false;
  state.editor.revision = 0;
  $("#editorTitle").textContent = `Edit ${state.lastPayload.anchor.name}`;
  editorAddInput.value = "";
  editorSuggestions.style.display = "none";
  renderEditorList();
  renderEditorValidation(state.lastPayload.result);
  editorDialog.showModal();
}

function saveEditor(validationResult) {
  const previous = state.lastPayload;
  const updated = {
    ...previous,
    result: {
      ...previous.result,
      ...validationResult,
      cards: validationResult.cards,
      mainboard: validationResult.cards.slice(commanderNames().length),
      totalEstimatedUsd: validationResult.totalEstimatedUsd,
      curve: validationResult.curve,
      roleCounts: validationResult.roleCounts,
      validation: validationResult.validation
    },
    response: {
      text: `Saved edited ${validationResult.cards.length}-card ${validationResult.format} deck around ${previous.anchor.name}.`
    }, constraints: getConstraints(), model: { used: false }
  };
  setActivePayload(updated, { addToHistory: true });
  editorDialog.close();
}

function setChatBusy(busy) {
  $("#demoSignOut").disabled = busy;
  state.busy = busy;
  form.querySelector('[type="submit"]').disabled = busy;
  input.disabled = busy;
  form.setAttribute("aria-busy", String(busy));
  $("#cancelRequest").hidden = !busy;
  $("#cancelRequest").disabled = !state.jobId;
  $("#importButton").disabled = busy;
}

async function pollChatJob(jobId, pending) {
  state.jobId = jobId; $("#cancelRequest").disabled = false;
  const response = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}/events`, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!response.ok) { const data = await response.json(); throw new Error(data.error || "Cannot connect to request progress."); }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 4_000_000) throw new Error("Request result exceeds the client size limit.");
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (!frame.startsWith("data: ")) continue;
        const job = JSON.parse(frame.slice(6));
        if (["failed", "canceled", "complete"].includes(job.status)) {
          sessionStorage.removeItem("jankbot_job"); state.jobId = null;
          if (job.status === "complete") { completeChat(pending, job.result); return; }
          throw new Error(job.status === "canceled" ? "Request canceled. No changes were applied." : job.error.message);
        }
        const stage = job.status === "queued" ? `Queued, position ${job.position}` : job.stage;
        pending.querySelector(".bubble").textContent = stage; $("#requestStatus").textContent = stage;
      }
    }
    throw new Error("Progress connection closed. Reload to reconnect to the same request; no duplicate request was submitted.");
  } finally { await reader.cancel(); }
}

async function sendChat({ message = input.value.trim(), anchorName, intent, format = $("#format").value, maxPrice = Number($("#maxPrice").value) } = {}) {
  if (!message || state.busy) return;
  const budgetInput = $("#maxPrice");
  budgetInput.setCustomValidity(Number.isFinite(maxPrice) && maxPrice >= 0.25 && maxPrice <= 50
    ? "" : "Enter a card budget between $0.25 and $50.");
  if (!budgetInput.reportValidity()) return;
  if (!form.reportValidity()) return;
  const constraints = getConstraints(), context = workspaceContext();
  state.recent.push({ role: "user", content: message.slice(0, 700) }); state.recent = state.recent.slice(-6);
  setChatBusy(true);
  input.value = "";
  suggestions.style.display = "none";
  addMessage("user", `<p>${escapeHtml(message)}</p>`);
  const pending = addMessage("assistant", `<p class="loading">Checking the archive...</p>`);
  try {
    const response = await apiFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        format, maxPrice, anchorName, intent, constraints, context
      })
    });
    const accepted = await response.json();
    if (!response.ok) throw new Error(accepted.error || "Request failed");
    if (accepted.kind === "clarification") { completeChat(pending, accepted); return; }
    state.jobId = accepted.jobId; sessionStorage.setItem("jankbot_job", accepted.jobId);
    await pollChatJob(accepted.jobId, pending);
  } catch (error) {
    pending.querySelector(".bubble").innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    if (!input.value) input.value = message;
  } finally {
    setChatBusy(false);
  }
}

$("#maxPrice").addEventListener("input", event => event.target.setCustomValidity(""));
form.addEventListener("submit", event => { event.preventDefault(); void sendChat(); });
messages.addEventListener("click", event => {
  const button = event.target.closest("[data-confirm-index]");
  if (!button || state.busy) return;
  const request = button.closest(".message").clarification;
  const selected = request?.resolution.suggestions[Number(button.dataset.confirmIndex)];
  if (!selected) return;
  void sendChat({ message: request.message, anchorName: selected.name, intent: request.resolution.intent,
    format: request.format, maxPrice: request.maxPrice });
});
$("#opening").addEventListener("click", event => {
  const button = event.target.closest("[data-commander]");
  if (!button) return;
  input.value = `Give me a deck based around ${button.dataset.commander}.`;
  input.focus();
});

let autocompleteTimer;
input.addEventListener("input", () => {
  autocompleteRequests.get(suggestions)?.abort();
  clearTimeout(autocompleteTimer);
  const text = input.value;
  const fragment = text.match(/(?:around|with|for)\s+([^?.!]*)$/i)?.[1] || text;
  autocompleteTimer = setTimeout(() => autocompleteInto(input, suggestions, fragment).catch(error => {
    if (error.name === "AbortError") return;
    suggestions.style.display = "none";
    $("#ollamaStatus").textContent = error.message;
  }), 220);
});

function suggestionKeyboard(target, menu) {
  target.addEventListener("keydown", event => {
    if (menu.style.display !== "block") return;
    const buttons = Array.from(menu.querySelectorAll("button"));
    if (!buttons.length) return;
    const active = buttons.findIndex(button => button.getAttribute("aria-selected") === "true");
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const next = active < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1)
        : (active + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons.forEach((button, index) => button.setAttribute("aria-selected", String(index === next)));
      target.setAttribute("aria-activedescendant", buttons[next].id);
    } else if (event.key === "Enter" && active >= 0) { event.preventDefault(); buttons[active].click(); }
    else if (event.key === "Escape") { event.preventDefault(); menu.style.display = "none"; target.removeAttribute("aria-activedescendant"); }
  });
}
suggestionKeyboard(input, suggestions);
suggestionKeyboard(editorAddInput, editorSuggestions);

suggestions.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) return;
  const name = button.textContent;
  input.value = input.value.replace(/(around|with|for)\s+([^?.!]*)$/i, `$1 ${name}`);
  if (!/(around|with|for)\s+/i.test(input.value)) input.value = `Give me a deck based around ${name}.`;
  suggestions.style.display = "none";
  input.focus();
});

$("#decklist").addEventListener("click", event => {
  const button = event.target.closest("[data-index]");
  if (!button) return;
  selectCard(Number(button.dataset.index));
});

$("#history").addEventListener("click", async event => {
  const button = event.target.closest("[data-history-index]");
  if (!button) return;
  const entry = state.history[Number(button.dataset.historyIndex)];
  if (!entry) return;
  try { setActivePayload(await refreshSaved(entry.payload), { addToHistory: false }); }
  catch (error) { addMessage("assistant", `<p>${escapeHtml(error.message)}</p>`); }
});

$("#syncButton").addEventListener("click", async () => {
  const button = $("#syncButton");
  button.disabled = true;
  button.querySelector("span:last-child").textContent = "Refreshing...";
  try {
    const response = await fetch("/api/sync", { method: "POST" });
    renderHealth({ cache: await response.json(), ollamaModel: $("#modelName").textContent });
  } finally {
    button.disabled = false;
    button.querySelector("span:last-child").textContent = "Refresh Scryfall";
  }
});

$("#pullModelButton").addEventListener("click", async () => {
  const button = $("#pullModelButton");
  button.disabled = true;
  button.querySelector("span:last-child").textContent = "Pulling model...";
  addMessage("assistant", `<p class="loading">Pulling the configured Ollama model. This can take several minutes for a first install.</p>`);
  try {
    const response = await fetch("/api/ollama/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Model pull failed");
    renderHealth({ cache: (await (await fetch("/api/health")).json()).cache, ollama: payload.status });
    addMessage("assistant", `<p>Ollama model ready: ${escapeHtml(payload.pulled)}.</p>`);
  } catch (error) {
    addMessage("assistant", `<p>${escapeHtml(error.message)}</p>`);
  } finally {
    button.disabled = false;
    button.querySelector("span:last-child").textContent = "Pull Ollama Model";
  }
});

$("#exportButton").addEventListener("click", async () => {
  if (!state.lastPayload) return;
  const text = JankBotDeckIO.format(deckNames(), commanderNames());
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = `${state.lastPayload.anchor.name.replace(/[^a-z0-9-]/gi, "_")}.txt`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("#editDeckButton").addEventListener("click", openEditor);
$("#closeEditorButton").addEventListener("click", () => editorDialog.close());

$("#editorList").addEventListener("click", event => {
  const remove = event.target.closest("[data-remove-index]");
  if (remove) {
    state.editor.cards.splice(Number(remove.dataset.removeIndex), 1);
    state.editor.dirty = true;
    state.editor.validation = null;
    state.editor.revision++;
    renderEditorList();
    renderEditorValidation(null);
    return;
  }
  const select = event.target.closest("[data-editor-index]");
  if (select) {
    renderHero(state.editor.cards[Number(select.dataset.editorIndex)], "Editing");
  }
});

let editorAutocompleteTimer;
editorAddInput.addEventListener("input", () => {
  autocompleteRequests.get(editorSuggestions)?.abort();
  clearTimeout(editorAutocompleteTimer);
  editorAutocompleteTimer = setTimeout(() => autocompleteInto(editorAddInput, editorSuggestions, editorAddInput.value).catch(error => {
    if (error.name === "AbortError") return;
    editorSuggestions.style.display = "none";
    $("#editorValidation").textContent = error.message;
  }), 220);
});

editorSuggestions.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) return;
  editorAddInput.value = button.textContent;
  editorSuggestions.style.display = "none";
});

$("#editorAddButton").addEventListener("click", async () => {
  const name = editorAddInput.value.trim();
  if (!name) return;
  try {
    await addEditorCard(name);
    editorAddInput.value = "";
  } catch (error) {
    $("#editorValidation").innerHTML = `<h3>Validation</h3><p class="invalid-text">${escapeHtml(error.message)}</p>`;
  }
});

$("#validateEditorButton").addEventListener("click", async () => {
  try {
    await validateEditor();
  } catch (error) {
    $("#editorValidation").innerHTML = `<h3>Validation</h3><p class="invalid-text">${escapeHtml(error.message)}</p>`;
    $("#saveEditorButton").disabled = true;
  }
});

$("#saveEditorButton").addEventListener("click", async () => {
  const button = $("#saveEditorButton");
  button.disabled = true;
  try {
    const validation = await validateEditor();
    if (!validation.validation.ok) return;
    saveEditor(validation);
  } catch (error) {
    $("#editorValidation").innerHTML = `<h3>Validation</h3><p class="invalid-text">${escapeHtml(error.message)}</p>`;
    $("#saveEditorButton").disabled = true;
  }
});

async function initialize() {
  await JankBotAccess.ensure();
  const health = loadHealth();
  try {
    state.history = await JankBotStorage.loadHistory();
    renderHistory();
    if (state.history.length) setActivePayload(await refreshSaved(state.history[0].payload), { addToHistory: false });
  } catch (error) { addMessage("assistant", `<p>${escapeHtml(error.message)}</p>`); }
  await health;
  const jobId = sessionStorage.getItem("jankbot_job");
  if (jobId) {
    setChatBusy(true);
    const pending = addMessage("assistant", "<p>Reconnecting to your request...</p>");
    try { await pollChatJob(jobId, pending); }
    catch (error) { pending.querySelector(".bubble").textContent = error.message; }
    finally { setChatBusy(false); }
  }
}

const libraryViewport = window.matchMedia("(min-width: 1000px)");
$("#libraryDrawer").open = libraryViewport.matches;
libraryViewport.addEventListener("change", event => { $("#libraryDrawer").open = event.matches; });

function commanderNames() {
  return state.lastPayload?.result.kind === "commander_deck" ? (state.lastPayload.result.commanders || [state.lastPayload.anchor]).map(card => card.name) : [];
}
async function refreshSaved(payload) {
  const saved = structuredClone(payload);
  if (saved.result.kind === "single_card") return saved;
  $("#format").value = saved.format || "commander";
  const constraints = saved.constraints || saved.result.constraints || getConstraints();
  const commanders = (saved.result.commanders || [saved.anchor]).map(card => card.name);
  const result = await validateNames(saved.result.cards.map(item => item.card.name), saved.result.kind === "commander_deck" ? commanders : [], constraints);
  return { ...saved, constraints, result: { ...saved.result, ...result }, response: { text: "Saved deck refreshed against the current catalog. Review its current budget and validation status." }, model: { used: false } };
}
function getConstraints() {
  return { maxPrice: Number($("#maxPrice").value), totalBudget: $("#totalBudget").value === "" ? null : Number($("#totalBudget").value),
    landCount: Number($("#landCount").value), partner: $("#partnerName").value.trim() || null,
    owned: { ...state.constraints.owned }, locked: [...state.constraints.locked], excluded: [...state.constraints.excluded] };
}
function writeConstraints(value) {
  state.constraints = { owned: {}, locked: [], excluded: [], ...structuredClone(value) };
  $("#maxPrice").value = value.maxPrice ?? 10; $("#totalBudget").value = value.totalBudget ?? "";
  $("#landCount").value = value.landCount ?? 37; $("#partnerName").value = value.partner || "";
  $("#constraintSummary").textContent = `${$("#landCount").value} lands · ${value.totalBudget == null ? "no total limit" : money(value.totalBudget) + " to buy"}`;
}
function workspaceContext() {
  if (!state.lastPayload) return undefined;
  return { kind: state.lastPayload.result.kind, revision: state.revision, cards: deckNames(), commander: state.lastPayload.anchor.name,
    commanders: commanderNames(), selectedName: state.inspectCard?.name || state.lastPayload.anchor.name, recent: state.recent.slice(-6) };
}
async function validateNames(names, commanders, constraints = getConstraints()) {
  const response = await apiFetch("/api/deck/validate", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format: $("#format").value, commander: commanders[0], commanders, cards: names, constraints }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || "Deck validation failed."); return result;
}
function openProposal(payload) {
  state.proposal = payload;
  const changes = payload.result.changes;
  $("#proposalBody").innerHTML = `<p>Purchase estimate ${money(payload.result.purchaseEstimatedUsd)} · ${payload.result.cards.length} cards</p><p>${payload.constraints?.totalBudget == null ? "No total purchase limit" : `Total limit ${money(payload.constraints.totalBudget)}`} · per-card limit ${money(payload.constraints?.maxPrice)}</p><div class="proposal-diff"><section><h3>Remove</h3><pre>${escapeHtml(JankBotDeckIO.quantities(changes?.removed || []))}</pre></section><section><h3>Add</h3><pre>${escapeHtml(JankBotDeckIO.quantities(changes?.added || []))}</pre></section></div>`;
  $("#proposalError").textContent = payload.baseRevision !== state.revision ? "This proposal belongs to an older deck revision. Request a new proposal." : "";
  $("#applyProposal").disabled = payload.baseRevision !== state.revision || !payload.result.validation.ok || !payload.result.budget?.ok;
  $("#proposalDialog").showModal();
}
$("#applyProposal").addEventListener("click", async () => {
  const proposal = state.proposal, revision = state.revision, button = $("#applyProposal"); button.disabled = true;
  try {
    if (proposal.baseRevision !== revision) throw new Error("The deck changed. Request a fresh proposal.");
    const result = await validateNames(proposal.result.cards.map(item => item.card.name), proposal.result.commanders.map(card => card.name), proposal.constraints);
    if (revision !== state.revision) throw new Error("The deck changed during validation. Request a fresh proposal.");
    if (!result.validation.ok) throw new Error(result.validation.errors.join(" "));
    setActivePayload({ ...proposal, kind: "result", result: { ...proposal.result, ...result } });
    $("#proposalDialog").close(); state.proposal = null;
  } catch (error) { $("#proposalError").textContent = error.message; }
});
for (const id of ["closeProposal", "discardProposal"]) $("#" + id).addEventListener("click", () => { $("#proposalDialog").close(); state.proposal = null; });
for (const id of ["deckFilter", "deckSort", "deckGroup"]) $("#" + id).addEventListener(id === "deckFilter" ? "input" : "change", renderDeck);
$("#undoButton").addEventListener("click", () => { if (!state.undo.length) return; state.redo.push(structuredClone(state.lastPayload)); setActivePayload(state.undo.pop(), { trackUndo: false }); });
$("#redoButton").addEventListener("click", () => { if (!state.redo.length) return; state.undo.push(structuredClone(state.lastPayload)); setActivePayload(state.redo.pop(), { trackUndo: false }); });
$("#explainSelected").addEventListener("click", () => { if (state.inspectCard) void sendChat({ message: `Explain why ${state.inspectCard.name} works with this deck.` }); });
$("#replaceSelected").addEventListener("click", () => { if (state.inspectCard) void sendChat({ message: `Find a cheaper replacement for ${state.inspectCard.name}, preserving its deck role.` }); });
$("#cancelRequest").addEventListener("click", async () => {
  if (!state.jobId) return;
  try { const response = await apiFetch(`/api/jobs/${encodeURIComponent(state.jobId)}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); if (!response.ok) throw new Error("Could not cancel the request."); $("#requestStatus").textContent = "Canceling request."; }
  catch (error) { addMessage("assistant", `<p>${escapeHtml(error.message)}</p>`); }
});
async function settingsChanged() {
  state.revision++; const revision = state.revision;
  state.constraints = getConstraints(); writeConstraints(state.constraints);
  if (!state.lastPayload) return;
  state.lastPayload.constraints = structuredClone(state.constraints);
  renderHero(state.activeCards[state.selectedIndex] || state.inspectCard, "Selected card"); renderDeck();
  if (state.lastPayload.result.kind === "single_card") return;
  $("#priceCoverage").textContent = "Checking current budget constraints...";
  try {
    const result = await validateNames(deckNames(), commanderNames());
    if (revision !== state.revision) return;
    state.lastPayload.result = { ...state.lastPayload.result, ...result }; state.activeCards = result.cards;
    renderMetrics(result);
    const title = summarizeResultTitle(state.lastPayload), currentNames = JSON.stringify(deckNames());
    const entry = state.history.find(entry => entry.title === title && JSON.stringify(allCardsFromResult(entry.payload.result).map(item => item.card.name)) === currentNames);
    if (entry) entry.payload = structuredClone(state.lastPayload);
    await JankBotStorage.saveHistory(state.history);
  } catch (error) { if (revision === state.revision) $("#priceCoverage").textContent = error.message; }
}
for (const id of ["maxPrice", "totalBudget", "landCount", "partnerName"]) $("#" + id).addEventListener("change", () => { if (form.reportValidity()) void settingsChanged(); });
$("#lockSelected").addEventListener("change", event => {
  const name = state.inspectCard?.name; if (!name) return;
  if (event.target.checked) state.constraints.excluded = state.constraints.excluded.filter(card => card !== name);
  state.constraints.locked = state.constraints.locked.filter(card => card !== name); if (event.target.checked) state.constraints.locked.push(name); void settingsChanged();
});
$("#excludeSelected").addEventListener("change", event => {
  const name = state.inspectCard?.name; if (!name) return;
  if (event.target.checked) state.constraints.locked = state.constraints.locked.filter(card => card !== name);
  state.constraints.excluded = state.constraints.excluded.filter(card => card !== name);
  if (event.target.checked) state.constraints.excluded.push(name);
  void settingsChanged();
});
$("#ownedQuantity").addEventListener("change", event => {
  if (!event.target.reportValidity() || !state.inspectCard) return;
  state.constraints.owned = { ...state.constraints.owned, [state.inspectCard.name]: Number(event.target.value) }; void settingsChanged();
});
messages.addEventListener("click", async event => {
  const button = event.target.closest("[data-inspect-name]"); if (!button) return;
  try { const response = await apiFetch(`/api/card?name=${encodeURIComponent(button.dataset.inspectName)}`); const card = await response.json(); if (!response.ok) throw new Error(card.error); renderHero(card, "Recommendation"); showView("card"); }
  catch (error) { $("#requestStatus").textContent = error.message; }
});
function showView(view) {
  document.body.dataset.view = view;
  for (const button of document.querySelectorAll("[data-view]")) button.setAttribute("aria-selected", String(button.dataset.view === view));
}
document.querySelector(".workspace-tabs").addEventListener("click", event => { const button = event.target.closest("[data-view]"); if (button) showView(button.dataset.view); });
$("#decklist").addEventListener("click", event => { if (event.target.closest("[data-index]")) showView("card"); });
showView("chat");
$("#importButton").addEventListener("click", () => { $("#importError").textContent = ""; $("#importCommander").value = commanderNames()[0] || ""; $("#importPartner").value = commanderNames()[1] || ""; $("#importDialog").showModal(); });
$("#closeImport").addEventListener("click", () => $("#importDialog").close());
$("#importFile").addEventListener("change", async event => {
  try { const file = event.target.files[0]; if (!file) return; if (file.size > 16000) throw new Error("Text files may contain at most 16,000 bytes."); $("#importText").value = await file.text(); }
  catch (error) { $("#importError").textContent = error.message; }
});
$("#importForm").addEventListener("submit", async event => {
  event.preventDefault(); const button = event.target.querySelector('[type="submit"]'); button.disabled = true;
  try {
    const parsed = JankBotDeckIO.parse($("#importText").value);
    const commanders = parsed.commanders.length ? parsed.commanders : [$("#importCommander").value.trim(), $("#importPartner").value.trim()].filter(Boolean);
    if ($("#format").value === "commander" && !commanders.length) throw new Error("Select a commander or include a Commander section.");
    for (const name of [...commanders].reverse()) { const index = parsed.cards.indexOf(name); if (index < 0) throw new Error(`${name} is missing from the imported list.`); parsed.cards.splice(index, 1); parsed.cards.unshift(name); }
    const result = await validateNames(parsed.cards, commanders);
    if (!result.validation.ok) throw new Error(result.validation.errors.join(" "));
    const anchor = result.commander || result.cards[0].card;
    setActivePayload({ anchor, result, constraints: getConstraints(), format: result.format, response: { text: `Imported and validated ${result.cards.length} cards.` }, model: { used: false } });
    $("#importDialog").close(); showView("deck");
  } catch (error) { $("#importError").textContent = error.message; }
  finally { button.disabled = false; }
});

void initialize().catch(error => {
  $("#ollamaStatus").textContent = error.message;
  setChatBusy(true);
});
