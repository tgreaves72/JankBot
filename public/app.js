const state = {
  lastPayload: null,
  activeCards: [],
  selectedIndex: null,
  history: [],
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

function money(value) {
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
  const response = await fetch("/api/health");
  renderHealth(await response.json());
}

function renderHero(item, mode = "Anchor") {
  const card = item?.card || item;
  if (!card) return;
  const image = cardImage(card);
  const roles = (item.roles || []).slice(0, 5).map(role => `<span>${escapeHtml(role)}</span>`).join("");
  $("#heroCard").innerHTML = `
    ${image ? `<img class="card-art" src="${image}" alt="${escapeHtml(card.name)}">` : `<div class="card-art-placeholder"></div>`}
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
    return `
      <button class="deck-card${active}" type="button" data-index="${index}">
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
  $("#history").innerHTML = state.history.map((entry, index) => `
    <button class="history-item" type="button" data-history-index="${index}">
      <strong>${escapeHtml(entry.title)}</strong>
      <span>${escapeHtml(entry.subtitle)}</span>
    </button>
  `).join("");
}

function selectCard(index) {
  if (!state.activeCards[index]) return;
  state.selectedIndex = index;
  renderHero(state.activeCards[index], index === 0 && state.lastPayload?.result.kind === "commander_deck" ? "Commander" : "Selected card");
  renderDeck();
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
  }
}

function formatAssistant(payload) {
  const result = payload.result;
  const modelLine = payload.model.used
    ? `<small>Explained by ${escapeHtml(payload.model.name)} using validated Scryfall data.</small>`
    : `<small>Validated result.</small>`;
  if (result.kind === "single_card") {
    const rec = result.recommendation;
    return `
      <p>${escapeHtml(payload.response.text)}</p>
      <p><strong>${escapeHtml(rec.card.name)}</strong> - ${money(rec.card.cheapest_usd)} - score ${rec.score.toFixed(2)}</p>
      ${modelLine}
    `;
  }
  return `
    <p>${escapeHtml(payload.response.text)}</p>
    <p><strong>${escapeHtml(payload.anchor.name)}</strong> - ${result.cards.length} cards - ${money(result.totalEstimatedUsd)}</p>
    ${modelLine}
  `;
}

async function autocompleteInto(target, menu, fragment) {
  if (fragment.trim().length < 2) {
    menu.style.display = "none";
    return;
  }
  const response = await fetch(`/api/autocomplete?q=${encodeURIComponent(fragment.trim())}`);
  const data = await response.json();
  if (!data.data?.length) {
    menu.style.display = "none";
    return;
  }
  menu.innerHTML = data.data.map(name => `<button type="button">${escapeHtml(name)}</button>`).join("");
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
        <button type="button" class="remove-card" data-remove-index="${index}" ${isCommander ? "disabled" : ""}>Remove</button>
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
  const payload = {
    format: $("#format").value,
    commander: state.lastPayload?.anchor?.name,
    cards: editorNames()
  };
  const response = await fetch("/api/deck/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Deck validation failed");
  state.editor.validation = result;
  renderEditorValidation(result);
  return result;
}

async function addEditorCard(name) {
  const response = await fetch(`/api/card?name=${encodeURIComponent(name)}`);
  const card = await response.json();
  if (!response.ok) throw new Error(card.error || "Card not found");
  state.editor.cards.push({
    card,
    roles: [],
    score: 0,
    reasons: ["manual add"]
  });
  state.editor.dirty = true;
  renderEditorList();
  renderEditorValidation(null);
}

function openEditor() {
  if (!state.lastPayload || state.lastPayload.result.kind !== "commander_deck") return;
  state.editor.cards = structuredClone(state.activeCards);
  state.editor.validation = state.lastPayload.result;
  state.editor.dirty = false;
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

form.addEventListener("submit", async event => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  suggestions.style.display = "none";
  addMessage("user", `<p>${escapeHtml(message)}</p>`);
  const pending = addMessage("assistant", `<p class="loading">Searching Scryfall, scoring synergy, checking legality, and asking Ollama for a validated response...</p>`);
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        format: $("#format").value,
        maxPrice: Number($("#maxPrice").value || 2)
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Request failed");
    pending.querySelector(".bubble").innerHTML = formatAssistant(payload);
    setActivePayload(payload);
    loadHealth();
  } catch (error) {
    pending.querySelector(".bubble").innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  }
});

let autocompleteTimer;
input.addEventListener("input", () => {
  clearTimeout(autocompleteTimer);
  const text = input.value;
  const fragment = text.match(/(?:around|with|for)\s+([^?.!]*)$/i)?.[1] || text;
  autocompleteTimer = setTimeout(() => autocompleteInto(input, suggestions, fragment), 220);
});

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
  clearTimeout(editorAutocompleteTimer);
  editorAutocompleteTimer = setTimeout(() => autocompleteInto(editorAddInput, editorSuggestions, editorAddInput.value), 220);
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
  try {
    const validation = state.editor.validation?.validation?.ok ? state.editor.validation : await validateEditor();
    if (!validation.validation.ok) return;
    saveEditor(validation);
  } catch (error) {
    $("#editorValidation").innerHTML = `<h3>Validation</h3><p class="invalid-text">${escapeHtml(error.message)}</p>`;
    $("#saveEditorButton").disabled = true;
  }
});

loadHealth();
