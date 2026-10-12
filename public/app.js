const state = {
  lastPayload: null,
  activeCards: [],
  selectedIndex: null,
  history: [],
  busy: false,
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
  return result.kind === "commander_deck"
    ? `${payload.anchor.name} deck`
    : `${result.recommendation.card.name} with ${payload.anchor.name}`;
}

function renderHealth(data) {
  $("#syncButton").hidden = !data.capabilities?.maintenance;
  $("#pullModelButton").hidden = !data.capabilities?.maintenance;
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
  } catch { $("#ollamaStatus").textContent = "Service unavailable"; }
}

function renderHero(item, mode = "Anchor") {
  const card = item?.card || item;
  if (!card) return;
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

function renderMetrics(result) {
  const isDeck = result.kind === "commander_deck";
  const total = isDeck ? result.totalEstimatedUsd : result.recommendation.card.cheapest_usd;
  $("#totalPrice").textContent = money(total);
  $("#deckSize").textContent = isDeck ? result.cards.length : "1";
  $("#validity").textContent = isDeck ? (result.validation.ok ? "Valid" : "Needs work") : "Legal";
  renderCurve(isDeck ? result.curve : { [Math.min(7, Math.floor(result.recommendation.card.cmc || 0))]: 1 });
}

function renderDeck() {
  $("#decklist").innerHTML = state.activeCards.map((item, index) => {
    const card = item.card || item;
    const tags = (item.roles || []).slice(0, 4).map(role => `<span>${escapeHtml(role)}</span>`).join("");
    const active = index === state.selectedIndex ? " selected" : "";
    const thumbnail = card.image_uris?.art_crop || card.card_faces?.[0]?.image_uris?.art_crop;
    return `
      <button class="deck-card${active}" type="button" data-index="${index}">
        ${thumbnail && /^https:\/\/cards\.scryfall\.io\//.test(thumbnail) ? `<img class="deck-thumb" src="${escapeHtml(thumbnail)}" alt="" width="52" height="40" loading="lazy" decoding="async">` : '<span class="deck-thumb no-art" aria-hidden="true"></span>'}
        <span>
          <strong>${escapeHtml(card.name)}</strong>
          <small>${escapeHtml(card.type_line || "")}</small>
        </span>
        <span class="price">${money(card.cheapest_usd)}</span>
        <span class="meta">Score ${Number(item.score || 0).toFixed(2)}</span>
        <span class="role-tags">${tags}</span>
      </button>
    `;
  }).join("");
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

function setActivePayload(payload, { addToHistory = true } = {}) {
  state.lastPayload = payload;
  state.activeCards = allCardsFromResult(payload.result);
  state.selectedIndex = 0;
  renderMetrics(payload.result);
  renderDeck();
  selectCard(0);
  $("#exportButton").disabled = false;
  $("#editDeckButton").disabled = payload.result.kind !== "commander_deck";

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
  setActivePayload(payload);
}

function formatAssistant(payload) {
  const result = payload.result;
  const modelLine = payload.model.used
    ? `<small>${escapeHtml(payload.model.name)} &middot; Scryfall${payload.timing?.totalMs ? ` &middot; ${(payload.timing.totalMs / 1000).toFixed(1)}s` : ""}</small>`
    : `<small>Validated result.</small>`;
  const correction = payload.resolution?.status === "corrected" ? `<p class="correction-note">Using <strong>${escapeHtml(payload.resolution.name)}</strong> for &ldquo;${escapeHtml(payload.resolution.query)}&rdquo;.</p>` : "";
  if (result.kind === "single_card") {
    const rec = result.recommendation;
    return `
      ${correction}
      <p>${escapeHtml(payload.response.text)}</p>
      <p><strong>${escapeHtml(rec.card.name)}</strong> - ${money(rec.card.cheapest_usd)} - score ${rec.score.toFixed(2)}</p>
      ${modelLine}
    `;
  }
  return `
    ${correction}
    <p>${escapeHtml(payload.response.text)}</p>
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
    const isCommander = index === 0 && state.lastPayload?.result.kind === "commander_deck";
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
      cards: validationResult.cards,
      mainboard: validationResult.cards.slice(1),
      totalEstimatedUsd: validationResult.totalEstimatedUsd,
      curve: validationResult.curve,
      roleCounts: validationResult.roleCounts,
      validation: validationResult.validation
    },
    response: {
      ...previous.response,
      text: `Saved edited ${validationResult.cards.length}-card ${validationResult.format} deck around ${previous.anchor.name}.`
    }
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
}

async function pollChatJob(jobId, pending) {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const response = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(15_000) });
    const job = await response.json();
    if (!response.ok) {
      if (response.status === 404) sessionStorage.removeItem("jankbot_job");
      throw new Error(job.error || "Cannot load your request.");
    }
    if (job.status === "failed") {
      sessionStorage.removeItem("jankbot_job");
      throw new Error(job.error.message);
    }
    if (job.status === "complete") {
      sessionStorage.removeItem("jankbot_job");
      completeChat(pending, job.result);
      return;
    }
    const elapsed = Math.floor((Date.now() - job.createdAt) / 1000);
    pending.querySelector(".bubble").textContent = `${job.status === "queued" ? `In queue, position ${job.position}` : job.stage} (${elapsed}s)`;
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  throw new Error("Request took too long. Reload to reconnect to your request.");
}

async function sendChat({ message = input.value.trim(), anchorName, intent, format = $("#format").value, maxPrice = Number($("#maxPrice").value) } = {}) {
  if (!message || state.busy) return;
  const budgetInput = $("#maxPrice");
  budgetInput.setCustomValidity(Number.isFinite(maxPrice) && maxPrice >= 0.25 && maxPrice <= 50
    ? "" : "Enter a card budget between $0.25 and $50.");
  if (!budgetInput.reportValidity()) return;
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
        format, maxPrice, anchorName, intent
      })
    });
    const accepted = await response.json();
    if (!response.ok) throw new Error(accepted.error || "Request failed");
    if (accepted.kind === "clarification") { completeChat(pending, accepted); return; }
    sessionStorage.setItem("jankbot_job", accepted.jobId);
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

$("#history").addEventListener("click", event => {
  const button = event.target.closest("[data-history-index]");
  if (!button) return;
  const entry = state.history[Number(button.dataset.historyIndex)];
  if (!entry) return;
  setActivePayload(structuredClone(entry.payload), { addToHistory: false });
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
  const text = state.activeCards.map(item => `1 ${item.card.name}`).join("\n");
  await navigator.clipboard.writeText(text);
  $("#exportButton").textContent = "Copied";
  setTimeout(() => $("#exportButton").textContent = "Export", 1200);
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
    if (state.history.length) setActivePayload(structuredClone(state.history[0].payload), { addToHistory: false });
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

void initialize().catch(error => {
  $("#ollamaStatus").textContent = error.message;
  setChatBusy(true);
});
