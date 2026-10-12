const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { ScryfallClient, CardStore } = require("./src/scryfall");
const { OllamaClient } = require("./src/ollama");
const { recommendCard, buildCommanderDeck, validateCommanderDeck, roles } = require("./src/recommender");
const { HttpError, securityHeaders, checkOrigin, VisitorSessions, RateLimiter, ChatJobs } = require("./src/hosting");
const { DemoAccess } = require("./src/demo-access");
const { directRequest, normalizeName } = require("./src/card-names");

const FORMATS = new Set(["commander", "modern", "standard", "pioneer", "pauper"]);
const PUBLIC_DIR = path.join(__dirname, "public");

function sendJson(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function readBody(req, maxBytes = 48 * 1024) {
  if (String(req.headers["content-type"] || "").split(";")[0].trim() !== "application/json") {
    throw new HttpError(415, "Send application/json.");
  }
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let exceeded = false;
    const chunks = [];
    req.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        if (!exceeded) reject(new HttpError(413, "Request body is too large."));
        exceeded = true;
      } else if (!exceeded) chunks.push(chunk);
    });
    req.on("end", () => {
      if (exceeded) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch { reject(new HttpError(400, "Invalid JSON object.")); }
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new HttpError(400, "Request interrupted.")));
  });
}

function textInput(value, field, max = 160) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new HttpError(400, `${field} must contain 1 to ${max} characters.`);
  }
  return value.trim();
}

function formatInput(value = "commander") {
  if (!FORMATS.has(value)) throw new HttpError(400, "Unsupported format.");
  return value;
}

function deckStats(items) {
  const curve = {};
  const roleCounts = {};
  let total = 0;
  let unpricedCards = 0;
  for (const item of items) {
    if (item.card.cheapest_usd == null) unpricedCards++;
    else total += Number(item.card.cheapest_usd);
    if (!item.roles.includes("land") && !item.roles.includes("commander")) {
      const key = String(Math.min(7, Math.floor(item.card.cmc || 0)));
      curve[key] = (curve[key] || 0) + 1;
    }
    for (const role of item.roles) roleCounts[role] = (roleCounts[role] || 0) + 1;
  }
  return { totalEstimatedUsd: Number(total.toFixed(2)), unpricedCards, curve, roleCounts };
}

function validateConstructedDeck(format, items) {
  const errors = [];
  const names = new Map();
  if (items.length < 60) errors.push(`${format} decks require at least 60 mainboard cards; found ${items.length}.`);
  for (const { card } of items) {
    if (!/^Basic(?: Snow)? Land\b/i.test(card.type_line)) names.set(card.name, (names.get(card.name) || 0) + 1);
    if (card.legalities?.[format] !== "legal") errors.push(`${card.name} is not ${format} legal.`);
  }
  for (const [name, count] of names) {
    const card = items.find(item => item.card.name === name).card;
    if (/a deck can have any number of cards named/i.test(card.oracle_text)) continue;
    const specialLimit = card.oracle_text.match(/a deck can have up to (\w+) cards named/i);
    const words = { seven: 7, nine: 9 };
    const limit = specialLimit ? (words[specialLimit[1]] || Number(specialLimit[1])) : 4;
    if (!Number.isFinite(limit) || count > limit) errors.push(`${name} exceeds its copy limit.`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

async function validateDeckPayload(body, store) {
  const format = formatInput(body.format);
  if (!Array.isArray(body.cards) || body.cards.length < 1 || body.cards.length > 250) {
    throw new HttpError(400, "cards must contain 1 to 250 card names.");
  }
  const names = body.cards.map(name => textInput(name, "Card name"));
  await store.ensureReady();
  const resolved = new Map();
  for (const name of new Set(names)) {
    const card = await store.resolveCard(name);
    if (!card || card.name !== name) throw new HttpError(422, `Select an exact Scryfall card name: ${name}`);
    resolved.set(name, card);
  }
  const items = names.map(name => ({ card: resolved.get(name), roles: roles(resolved.get(name)), score: 0, reasons: ["manual deck edit"] }));
  let commander = null;
  let validation;
  if (format === "commander") {
    const commanderName = textInput(body.commander, "Commander");
    commander = resolved.get(commanderName);
    if (!commander) throw new HttpError(422, "Include the commander in the deck.");
    validation = validateCommanderDeck(commander, items);
    if (names[0] !== commanderName) validation.errors.push("The commander must occupy the commander slot.");
    validation.ok = validation.errors.length === 0;
    items[0].roles = [...new Set([...items[0].roles, "commander"])];
  } else validation = validateConstructedDeck(format, items);
  return { format, commander, cards: items, validation, ...deckStats(items) };
}

async function serveStatic(req, res, pathname) {
  if (!["GET", "HEAD"].includes(req.method)) throw new HttpError(405, "Method not allowed.");
  const target = path.resolve(PUBLIC_DIR, `.${pathname === "/" ? "/index.html" : pathname}`);
  const relative = path.relative(PUBLIC_DIR, target);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(":")) throw new HttpError(403, "Forbidden.");
  const allowed = new Set(["index.html", "styles.css", "app.js", "storage.js", "access.js", "credits.txt",
    "art-command-tower.jpg", "card-teysa.jpg", "card-yarok.jpg", "card-niv.jpg",
    ...["send", "log-out", "download", "pencil-line", "plus", "x", "trash-2", "check", "layers", "book-open"].map(name => `icon-${name}.svg`)]);
  if (!allowed.has(relative)) throw new HttpError(404, "Not found.");
  let stat;
  try { stat = await fs.stat(target); } catch { throw new HttpError(404, "Not found."); }
  if (!stat.isFile()) throw new HttpError(404, "Not found.");
  if (await fs.realpath(target) !== target) throw new HttpError(403, "Linked assets are not served.");
  const type = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".txt": "text/plain" }[path.extname(target)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Content-Length": stat.size, "Cache-Control": pathname.endsWith(".html") || pathname === "/" ? "no-cache" : "public, max-age=300" });
  if (req.method === "HEAD") return res.end();
  createReadStream(target).on("error", () => res.destroy()).pipe(res);
}

function createApp({ store, ollama, demo = null, production = process.env.NODE_ENV === "production", publicOrigin = process.env.PUBLIC_ORIGIN || "", sessionSecret = process.env.SESSION_SECRET } = {}) {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
  const model = process.env.OLLAMA_MODEL || "qwen2.5:0.5b";
  store ||= new CardStore({ dataDir, snapshotOnly: Boolean(demo), scryfall: new ScryfallClient({ appName: "JankBot/1.0", contact: process.env.SCRYFALL_CONTACT || "JankBot self-hosted" }) });
  ollama ||= new OllamaClient({ baseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434", model, demo: Boolean(demo) });
  if (publicOrigin) publicOrigin = new URL(publicOrigin).origin;
  const sessions = new VisitorSessions({ secret: sessionSecret, secure: publicOrigin.startsWith("https://") });
  const limits = new RateLimiter();
  const jobs = new ChatJobs({ maxPending: demo ? 3 : 8, maxRetained: demo ? 12 : 32 });

  async function generateChat(body, stage, prepared = {}) {
    const started = performance.now();
    stage("Reading your request");
    const parsed = prepared.parsed || await ollama.parseIntent(body.message);
    if (parsed.source !== "selection" && !normalizeName(body.message).includes(normalizeName(parsed.cardName))) {
      throw new HttpError(422, "I could not reliably identify the card name. Try enclosing the name in quotes.");
    }
    const format = body.format;
    if (parsed.intent === "build_deck" && format !== "commander") {
      throw new HttpError(422, "Deck generation currently supports Commander. Other formats support card recommendations and deck validation.");
    }
    stage("Searching cards");
    await store.ensureReady();
    const resolution = prepared.resolution || await store.inferCard(parsed.cardName);
    if (!resolution.card) return { kind: "clarification", resolution: { ...resolution, intent: parsed.intent }, message: body.message,
      format, maxPrice: body.maxPrice };
    const anchor = resolution.card;
    stage("Building and checking synergy");
    const constraints = { format, budget: "budget", maxPrice: body.maxPrice };
    const intent = parsed.intent;
    const result = intent === "recommend_card" ? await recommendCard({ anchor, store, constraints }) : await buildCommanderDeck({ commander: anchor, store, constraints });
    if (intent === "recommend_card" && !result.recommendation) throw new HttpError(422, "No legal matching cards found.");
    if (result.validation && !result.validation.ok) throw new HttpError(422, result.validation.errors.join(" "));
    stage("Preparing your recommendation");
    const response = await ollama.explain({ message: body.message, anchor, result, intent });
    return { intent, format, anchor, result, response, resolution: { status: resolution.status, query: resolution.query, name: anchor.name },
      timing: { parser: parsed.source || "ollama", totalMs: Math.round(performance.now() - started) }, dataFreshness: await store.metadata(), model: { name: model, used: true } };
  }

  async function handleApi(req, res, url) {
    if (req.method === "POST") {
      checkOrigin(req, publicOrigin);
      if (demo && !req.headers.origin) throw new HttpError(403, "A same-origin request is required.");
    }
    if (url.pathname === "/api/session" && req.method === "GET") {
      return sendJson(res, 200, demo ? demo.view(demo.session(req)) : { enabled: false, authenticated: true });
    }
    if (url.pathname === "/api/demo/login" && req.method === "POST" && demo) {
      const body = await readBody(req, 1024);
      return sendJson(res, 200, demo.view(demo.login(req, res, body.code)));
    }
    if (url.pathname === "/api/demo/claim" && req.method === "POST" && demo) {
      const body = await readBody(req, 1024);
      return sendJson(res, 200, demo.view(demo.login(req, res, body.token, { linkOnly: true })));
    }
    if (url.pathname === "/api/demo/logout" && req.method === "POST" && demo) {
      demo.logout(req, res);
      return sendJson(res, 200, demo.view(null));
    }
    if (production && ["/api/sync", "/api/ollama/pull", "/api/ollama/status"].includes(url.pathname)) throw new HttpError(404, "Not found.");
    const hostProbe = demo?.isHost(req) && ["/api/health", "/api/ready"].includes(url.pathname);
    const demoSession = demo && !hostProbe ? demo.require(req) : null;
    const owner = demo ? demoSession?.id : sessions.get(req, res);
    const polling = url.pathname.startsWith("/api/jobs/");
    limits.check(`${owner}:${polling ? "poll" : "api"}`, { limit: polling ? 300 : 120 });
    if (url.pathname === "/api/health" && req.method === "GET") {
      const status = await ollama.status();
      return sendJson(res, 200, { ok: true, ollamaModel: model, ollama: { reachable: status.reachable, requestedModel: model, modelAvailable: status.modelAvailable }, cache: await store.metadata(), capabilities: { maintenance: !production, asyncChat: true, employerDemo: Boolean(demo), oneClickDemo: Boolean(demo?.config.invites.some(invite => invite.kind === "link" && demo.invite(invite.id))) }, deployment: { publicOrigin, accessRequired: Boolean(demo) } });
    }
    if (url.pathname === "/api/ready" && req.method === "GET") {
      const status = await ollama.status();
      const metadata = await store.metadata();
      const snapshotFresh = Number.isFinite(Date.parse(metadata.updatedAt)) && Date.now() - Date.parse(metadata.updatedAt) <= 7 * 86400_000;
      const ready = status.reachable && status.modelAvailable && metadata.loaded && (!demo || (store.loaded && snapshotFresh));
      return sendJson(res, ready ? 200 : 503, { ready });
    }
    if (polling && req.method === "GET") return sendJson(res, 200, jobs.get(url.pathname.slice("/api/jobs/".length), owner));
    if (url.pathname === "/api/chat" && req.method === "POST") {
      limits.check(`${owner}:chat`, { limit: 6 });
      const body = await readBody(req, demo ? 4096 : 48 * 1024);
      body.message = textInput(body.message, "Message", demo ? 700 : 1500);
      if (body.anchorName !== undefined) body.anchorName = textInput(body.anchorName, "Selected card");
      body.format = formatInput(body.format);
      body.maxPrice = body.maxPrice ?? 2;
      if (typeof body.maxPrice !== "number" || !Number.isFinite(body.maxPrice) || body.maxPrice < 0.25 || body.maxPrice > 50) throw new HttpError(400, "Budget must be between $0.25 and $50.");
      const prepared = {};
      if (body.anchorName) {
        if (!["build_deck", "recommend_card"].includes(body.intent)) throw new HttpError(400, "Select a supported request type.");
        const selected = await store.resolveCard(body.anchorName);
        if (!selected || selected.name !== body.anchorName) throw new HttpError(422, "Select an exact card from the suggested choices.");
        prepared.parsed = { intent: body.intent, cardName: body.anchorName, source: "selection" };
        prepared.resolution = { status: "selected", card: selected, query: body.anchorName };
      } else {
        prepared.parsed = directRequest(body.message);
        if (prepared.parsed) {
          prepared.resolution = await store.inferCard(prepared.parsed.cardName);
          if (!prepared.resolution.card) return sendJson(res, 200, { kind: "clarification", resolution: { ...prepared.resolution, intent: prepared.parsed.intent },
            message: body.message, format: body.format, maxPrice: body.maxPrice });
        }
      }
      if (demo) {
        jobs.assertAvailable(owner);
        await demo.admit(demoSession.inviteId);
      }
      const jobId = jobs.submit(owner, stage => generateChat(body, stage, prepared));
      return sendJson(res, 202, { jobId, status: "queued" });
    }
    if (url.pathname === "/api/autocomplete" && req.method === "GET") {
      const q = String(url.searchParams.get("q") || "").trim();
      if (q.length > 160) throw new HttpError(400, "Search is too long.");
      return sendJson(res, 200, { data: q.length < 2 ? [] : await store.autocomplete(q) });
    }
    if (url.pathname === "/api/card" && req.method === "GET") {
      const name = textInput(url.searchParams.get("name"), "Card name");
      const card = await store.resolveCard(name);
      return sendJson(res, card ? 200 : 404, card || { error: "Card not found." });
    }
    if (url.pathname === "/api/deck/validate" && req.method === "POST") {
      limits.check(`${demoSession?.inviteId || owner}:validation`, { limit: 12 });
      return sendJson(res, 200, await validateDeckPayload(await readBody(req), store));
    }

    // Maintenance cannot run through the public deployment, even with forged headers.
    if (["/api/sync", "/api/ollama/pull", "/api/ollama/status"].includes(url.pathname)) {
      if (production || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) throw new HttpError(404, "Not found.");
      if (url.pathname === "/api/sync" && req.method === "POST") return sendJson(res, 200, await store.refreshBulkData());
      if (url.pathname === "/api/ollama/status" && req.method === "GET") return sendJson(res, 200, await ollama.status());
      if (url.pathname === "/api/ollama/pull" && req.method === "POST") {
        await readBody(req);
        return sendJson(res, 200, { pulled: model, result: await ollama.pull(model), status: await ollama.status() });
      }
    }
    throw new HttpError(404, "Not found.");
  }

  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    if (publicOrigin.startsWith("https://")) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    try {
      if (req.url.length > 2048) throw new HttpError(414, "Request URL is too long.");
      if (!["GET", "HEAD", "POST"].includes(req.method)) throw new HttpError(405, "Method not allowed.");
      // Ignore client-supplied forwarding headers for this global backstop.
      limits.check(`network:${req.socket.remoteAddress}`, { limit: demo ? 360 : 1500 });
      const url = new URL(req.url, "http://jankbot.internal");
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
      else {
        if (url.pathname === "/" && publicOrigin && /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(req.headers.host || "")) {
          res.writeHead(302, { Location: `${publicOrigin}/`, "Cache-Control": "no-store" });
          return res.end();
        }
        let pathname;
        try { pathname = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, "Invalid URL encoding."); }
        await serveStatic(req, res, pathname);
      }
    } catch (error) {
      if (error.status === 429) res.setHeader("Retry-After", "60");
      if (!error.status) console.error(JSON.stringify({ event: "request_failed", error: error.message }));
      sendJson(res, error.status || 503, { error: error.status ? error.message : "A required service failed. Try again when service is restored." });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.timeout = 20_000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = demo ? 48 : 128;
  server.maxRequestsPerSocket = 100;
  return { server, store, ollama, jobs };
}

async function main() {
  let demo = null;
  if (process.env.NODE_ENV === "production") {
    if (!process.env.DEMO_CONFIG || !process.env.DEMO_USAGE_PATH || !process.env.PUBLIC_ORIGIN?.startsWith("https://")) {
      throw new Error("Public hosting requires employer access configuration and an HTTPS public origin.");
    }
    const config = JSON.parse(await fs.readFile(process.env.DEMO_CONFIG, "utf8"));
    demo = new DemoAccess({ config, usagePath: process.env.DEMO_USAGE_PATH });
    await demo.initialize();
  }
  const { server, store } = createApp({ demo });
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  await store.ensureReady();
  server.listen(port, host, () => console.log(`JankBot listening on http://${host}:${port}`));
  const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { createApp, validateDeckPayload, validateConstructedDeck, deckStats };
