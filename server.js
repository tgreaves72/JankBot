const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const { existsSync, createReadStream } = require("node:fs");
const { URL } = require("node:url");
const { ScryfallClient, CardStore } = require("./src/scryfall");
const { OllamaClient, normalizeModelName } = require("./src/ollama");
const { recommendCard, buildCommanderDeck, validateCommanderDeck, roles } = require("./src/recommender");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const MODEL = process.env.OLLAMA_MODEL || "qwen2.5:0.5b";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const scryfall = new ScryfallClient({
  appName: "JankBot/1.0",
  contact: process.env.SCRYFALL_CONTACT || "local-user@example.com"
});
const store = new CardStore({ dataDir: DATA_DIR, scryfall });
const ollama = new OllamaClient({ baseUrl: OLLAMA_BASE_URL, model: MODEL });

function sendJson(res, status, payload) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(payload, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  }[ext] || "application/octet-stream";
}

function deckStats(items) {
  const totalEstimatedUsd = items.reduce((sum, item) => sum + (Number(item.card.cheapest_usd) || 0), 0);
  const curve = {};
  const roleCounts = {};
  for (const item of items) {
    if (!item.roles.includes("land")) {
      const key = String(Math.min(7, Math.floor(item.card.cmc || 0)));
      curve[key] = (curve[key] || 0) + 1;
    }
    for (const role of item.roles) roleCounts[role] = (roleCounts[role] || 0) + 1;
  }
  return {
    totalEstimatedUsd: Number(totalEstimatedUsd.toFixed(2)),
    curve,
    roleCounts
  };
}

function validateConstructedDeck(format, items) {
  const errors = [];
  const names = new Map();
  const minimum = format === "brawl" || format === "standardbrawl" ? 60 : 60;
  if (items.length < minimum) errors.push(`${format} decks must contain at least ${minimum} cards; found ${items.length}.`);
  for (const item of items) {
    const name = item.card.name;
    if (!/basic land/i.test(item.card.type_line || "")) {
      names.set(name, (names.get(name) || 0) + 1);
    }
    if (item.card.legalities?.[format] && item.card.legalities[format] !== "legal") {
      errors.push(`${name} is not ${format} legal.`);
    }
  }
  for (const [name, count] of names) {
    if (count > 4) errors.push(`${name} appears ${count} times; constructed formats allow at most 4 copies.`);
  }
  return { ok: errors.length === 0, errors };
}

async function resolveDeckItems(names) {
  const items = [];
  for (const name of names) {
    const resolved = await store.resolveCard(name);
    if (!resolved) {
      throw new Error(`No Scryfall card found for "${name}".`);
    }
    items.push({
      card: resolved,
      roles: roles(resolved),
      score: 0,
      reasons: ["manual deck edit"]
    });
  }
  return items;
}

async function validateDeckPayload(body) {
  await store.ensureReady();
  const format = String(body.format || "commander").toLowerCase();
  const names = Array.isArray(body.cards) ? body.cards.map(name => String(name).trim()).filter(Boolean) : [];
  if (!names.length) {
    throw new Error("cards must be a non-empty array of card names.");
  }
  const items = await resolveDeckItems(names);
  let commander = null;
  let validation;
  if (format === "commander") {
    const commanderName = String(body.commander || names[0] || "").trim();
    commander = await store.resolveCard(commanderName);
    if (!commander) throw new Error(`No Scryfall commander found for "${commanderName}".`);
    validation = validateCommanderDeck(commander, items);
  } else {
    validation = validateConstructedDeck(format, items);
  }
  return {
    format,
    commander,
    cards: items,
    validation,
    ...deckStats(items)
  };
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const target = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!existsSync(target)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType(target),
    "Cache-Control": "public, max-age=120"
  });
  createReadStream(target).pipe(res);
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const message = String(body.message || "").trim();
  const format = String(body.format || "commander").toLowerCase();
  const budget = String(body.budget || "budget").toLowerCase();
  const maxPrice = Number(body.maxPrice || 2);

  if (!message) {
    sendJson(res, 400, { error: "Message is required." });
    return;
  }

  await store.ensureReady();

  let parsed;
  try {
    parsed = await ollama.parseIntent(message);
  } catch (error) {
    sendJson(res, 503, {
      error: "Ollama is required for chat and is not ready.",
      details: error.message,
      ollama: error.details || await ollama.status(),
      setup: [
        `Ollama service: ${OLLAMA_BASE_URL}`,
        `Required model: ${normalizeModelName(MODEL)}`,
        "Use the app's Pull Model button or run the matching ollama pull command."
      ],
      note: "No fallback parser, chatbot, or fabricated response was used."
    });
    return;
  }
  const targetName = parsed.cardName;
  if (!targetName) {
    sendJson(res, 422, {
      error: "I could not identify a card name in that request.",
      hint: "Try: Give me a deck based around Teysa Karlov."
    });
    return;
  }

  const anchor = await store.resolveCard(targetName);
  if (!anchor) {
    sendJson(res, 404, {
      error: `No Scryfall card found for "${targetName}".`,
      hint: "Use the autocomplete search to pick the exact card name."
    });
    return;
  }

  const intent = parsed.intent === "recommend_card" ? "recommend_card" : "build_deck";
  const constraints = {
    format: parsed.format || format,
    budget: parsed.budgetMode || budget,
    maxPrice: parsed.maxCardPriceUsd || maxPrice
  };
  const result = intent === "recommend_card"
    ? await recommendCard({ anchor, store, constraints })
    : await buildCommanderDeck({ commander: anchor, store, constraints });

  let response;
  try {
    response = await ollama.explain({
      message,
      anchor,
      result,
      intent
    });
  } catch (error) {
    sendJson(res, 503, {
      error: "Ollama could not generate the chat response.",
      details: error.message,
      ollama: error.details,
      note: "The app stopped instead of using a fallback response.",
      partialResult: result
    });
    return;
  }

  sendJson(res, 200, {
    intent,
    anchor,
    result,
    response,
    dataFreshness: await store.metadata(),
    model: {
      name: MODEL,
      used: response.usedOllama
    }
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health") {
    await store.ensureDataDir();
    sendJson(res, 200, {
      ok: true,
      ollamaModel: MODEL,
      ollama: await ollama.status(),
      cache: await store.metadata()
    });
    return;
  }

  if (url.pathname === "/api/ollama/status") {
    sendJson(res, 200, await ollama.status());
    return;
  }

  if (url.pathname === "/api/ollama/pull" && req.method === "POST") {
    const body = await readBody(req);
    const model = String(body.model || MODEL).trim();
    if (!model) {
      sendJson(res, 400, { error: "model is required" });
      return;
    }
    const result = await ollama.pull(model);
    sendJson(res, 200, {
      pulled: normalizeModelName(model),
      result,
      status: await ollama.status()
    });
    return;
  }

  if (url.pathname === "/api/sync" && req.method === "POST") {
    const result = await store.refreshBulkData();
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/autocomplete") {
    const q = String(url.searchParams.get("q") || "").trim();
    if (q.length < 2) {
      sendJson(res, 200, { data: [] });
      return;
    }
    sendJson(res, 200, { data: await store.autocomplete(q) });
    return;
  }

  if (url.pathname === "/api/card") {
    const name = String(url.searchParams.get("name") || "").trim();
    if (!name) {
      sendJson(res, 400, { error: "name query parameter is required" });
      return;
    }
    await store.ensureReady();
    const card = await store.resolveCard(name);
    sendJson(res, card ? 200 : 404, card || { error: "Card not found" });
    return;
  }

  if (url.pathname === "/api/deck/validate" && req.method === "POST") {
    const body = await readBody(req);
    const result = await validateDeckPayload(body);
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/chat" && req.method === "POST") {
    await handleChat(req, res);
    return;
  }

  sendJson(res, 404, { error: "Unknown API route" });
}

async function bootstrap() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      await serveStatic(req, res, decodeURIComponent(url.pathname));
    } catch (error) {
      sendJson(res, 500, {
        error: error.message,
        note: "JankBot does not fabricate fallback card data; fix the failing dependency and retry."
      });
    }
  });

  server.listen(PORT, () => {
    console.log(`JankBot running at http://localhost:${PORT}`);
  });
}

bootstrap();
