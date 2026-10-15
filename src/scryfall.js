const fs = require("node:fs/promises");
const { createReadStream, createWriteStream } = require("node:fs");
const { once } = require("node:events");
const path = require("node:path");
const { Readable } = require("node:stream");
const { createGunzip } = require("node:zlib");
const { createInterface } = require("node:readline");
const { CardNames, normalizeName } = require("./card-names");
const { mainDeckIssue, commanderInclusionErrors, meldComponent } = require("./deck-rules");

const SCRYFALL_ROOT = "https://api.scryfall.com";
const MIN_INTERVAL_MS = 125;
const BULK_MAX_AGE_MS = 1000 * 60 * 60 * 24;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function* jsonLines(stream) {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim()) yield JSON.parse(line);
    }
  } finally { lines.close(); }
}

function asText(card) {
  const faceText = Array.isArray(card.card_faces)
    ? card.card_faces.map(face => `${face.name || ""} ${face.type_line || ""} ${face.oracle_text || ""}`).join(" ")
    : "";
  return `${card.name || ""} ${card.type_line || ""} ${card.oracle_text || ""} ${faceText}`.toLowerCase();
}

function cheapestUsd(card) {
  const values = [
    card.prices?.usd,
    card.prices?.usd_foil,
    card.prices?.usd_etched
  ].map(Number).filter(value => Number.isFinite(value) && value > 0);
  return values.length ? Math.min(...values) : null;
}

function compactCard(card) {
  return {
    id: card.id,
    oracle_id: card.oracle_id,
    name: card.name,
    uri: card.uri,
    scryfall_uri: card.scryfall_uri,
    layout: card.layout,
    meld_component: card.layout === "meld" ? meldComponent(card) : null,
    mana_cost: card.mana_cost || card.card_faces?.map(face => face.mana_cost).filter(Boolean).join(" // ") || "",
    cmc: card.cmc || 0,
    type_line: card.type_line || "",
    oracle_text: card.oracle_text || card.card_faces?.map(face => face.oracle_text).filter(Boolean).join("\n---\n") || "",
    power: card.power,
    toughness: card.toughness,
    colors: card.colors || [],
    color_identity: card.color_identity || [],
    keywords: card.keywords || [],
    legalities: card.legalities || {},
    edhrec_rank: card.edhrec_rank || null,
    prices: card.prices || {},
    cheapest_usd: cheapestUsd(card),
    image_uris: card.image_uris || card.card_faces?.[0]?.image_uris || {},
    card_faces: card.card_faces?.map(face => ({
      name: face.name,
      mana_cost: face.mana_cost,
      type_line: face.type_line,
      oracle_text: face.oracle_text,
      colors: face.colors || [],
      image_uris: face.image_uris || {}
    })) || [],
    produced_mana: card.produced_mana || [],
    games: card.games || []
  };
}

class ScryfallClient {
  constructor({ appName, contact }) {
    this.appName = appName;
    this.contact = contact;
    this.lastRequest = 0;
    this.queue = Promise.resolve();
  }

  request(endpoint, params = {}) {
    const task = this.queue.then(() => this.performRequest(endpoint, params));
    this.queue = task.catch(() => {});
    return task;
  }

  async performRequest(endpoint, params = {}) {
    const elapsed = Date.now() - this.lastRequest;
    if (elapsed < MIN_INTERVAL_MS) {
      await sleep(MIN_INTERVAL_MS - elapsed);
    }
    const url = new URL(endpoint, SCRYFALL_ROOT);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    });
    this.lastRequest = Date.now();
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: {
        "User-Agent": `${this.appName} (${this.contact})`,
        "Accept": "application/json;q=0.9,*/*;q=0.8"
      }
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json.details || json.error || `Scryfall request failed: ${response.status}`);
    }
    return json;
  }

  named(name, mode = "fuzzy") {
    return this.request("/cards/named", { [mode]: name });
  }

  autocomplete(q) {
    return this.request("/cards/autocomplete", { q });
  }

  search(q, options = {}) {
    return this.request("/cards/search", { q, ...options });
  }

  bulkData() {
    return this.request("/bulk-data");
  }
}

class CardStore {
  constructor({ dataDir, scryfall, snapshotOnly = false }) {
    this.snapshotOnly = snapshotOnly;
    this.dataDir = dataDir;
    this.scryfall = scryfall;
    this.cardsPath = path.join(dataDir, "oracle-cards.compact.jsonl");
    this.metaPath = path.join(dataDir, "metadata.json");
    this.cards = [];
    this.byName = new Map();
    this.byNormalizedName = new Map();
    this.loaded = false;
    this.initializing = null;
    this.refreshing = null;
    this.checkedAt = 0;
    this.candidateCache = new Map();
    this.comboCache = new Map();
  }

  async ensureDataDir() {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  async metadata() {
    try {
      return JSON.parse(await fs.readFile(this.metaPath, "utf8"));
    } catch {
      return { loaded: false };
    }
  }

  async ensureReady() {
    if (this.loaded && Date.now() - this.checkedAt < 60_000) return;
    if (!this.initializing) {
      this.initializing = this.prepareIndex().finally(() => { this.initializing = null; });
    }
    await this.initializing;
  }

  async prepareIndex() {
    if (this.snapshotOnly) {
      if (!this.loaded) await this.load();
      const meta = await this.metadata();
      if (!meta.loaded || !Number.isFinite(Date.parse(meta.updatedAt)) || Date.now() - Date.parse(meta.updatedAt) > 7 * BULK_MAX_AGE_MS) {
        throw new Error("The demo card snapshot expired. The host must refresh and redeploy it.");
      }
      this.checkedAt = Date.now();
      return;
    }
    await this.ensureDataDir();
    if (!this.loaded) {
      try { await this.load(); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const meta = await this.metadata();
    if (!this.loaded || !meta.updatedAt || Date.now() - new Date(meta.updatedAt).getTime() > BULK_MAX_AGE_MS) await this.refreshBulkData();
    this.checkedAt = Date.now();
  }

  index(cards) {
    cards = cards.filter(card => !/^Card(?: \/\/ Card)?$/i.test(card.type_line || ""));
    this.cards = cards;
    this.byName.clear();
    this.byNormalizedName.clear();
    for (const card of cards) {
      this.byName.set(card.name, card);
      this.byNormalizedName.set(normalizeName(card.name), card);
    }
    this.loaded = true;
    this.nameIndex = new CardNames(cards);
    this.candidateCache.clear();
    this.comboCache.clear();
  }

  async combosFor(items, commanders = []) {
    const metadata = await this.metadata();
    if (!metadata.comboCount) return { status: "not_prepared", matches: [], matchedCount: 0 };
    const counts = new Map(), leaders = new Set(commanders.map(card => card.oracle_id));
    for (const { card } of items) counts.set(card.oracle_id, (counts.get(card.oracle_id) || 0) + 1);
    const key = [...counts].sort().map(([id, count]) => `${id}:${count}`).join(",") + ":" + [...leaders].sort().join(",");
    if (this.comboCache.has(key)) return this.comboCache.get(key);
    const matches = []; let matchedCount = 0;
    for await (const combo of jsonLines(createReadStream(path.join(this.dataDir, "combos.jsonl")))) {
      if (combo.uses.every(use => (counts.get(use.oracleId) || 0) >= use.quantity && (!use.mustBeCommander || leaders.has(use.oracleId)))) {
        matchedCount++; if (matches.length < 12) matches.push(combo);
      }
    }
    const result = { status: "card_presence_only", matches, matchedCount, updatedAt: metadata.combosUpdatedAt,
      scope: metadata.comboScope, shown: matches.length };
    if (this.comboCache.size >= 8) this.comboCache.delete(this.comboCache.keys().next().value);
    this.comboCache.set(key, result); return result;
  }

  async load() {
    let cards;
    cards = [];
    for await (const card of jsonLines(createReadStream(this.cardsPath))) cards.push(card);
    if (!cards.length) throw new Error("The card snapshot is empty.");
    this.index(cards);
  }

  async refreshBulkData() {
    if (!this.refreshing) {
      this.refreshing = this.downloadBulkData().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async downloadBulkData() {
    await this.ensureDataDir();
    const bulk = await this.scryfall.bulkData();
    const oracle = bulk.data.find(item => item.type === "oracle_cards")
      || bulk.data.find(item => item.name === "Oracle Cards");
    if (!oracle?.jsonl_download_uri) {
      throw new Error("Scryfall did not provide an Oracle Cards bulk download.");
    }

    const response = await fetch(oracle.jsonl_download_uri, {
      signal: AbortSignal.timeout(180_000),
      headers: {
        "User-Agent": `${this.scryfall.appName} (${this.scryfall.contact})`,
        "Accept": "application/json;q=0.9,*/*;q=0.8"
      }
    });
    if (!response.ok) {
      throw new Error(`Bulk download failed: ${response.status}`);
    }
    const input = Readable.fromWeb(response.body);
    // fetch decodes HTTP Content-Encoding; .gz downloads without that header stay compressed.
    const iterator = input[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new Error("Scryfall supplied an empty bulk download.");
    const source = Readable.from((async function* () {
      yield first.value;
      for (;;) { const next = await iterator.next(); if (next.done) return; yield next.value; }
    })());
    const compressed = first.value[0] === 0x1f && first.value[1] === 0x8b;
    const decoded = compressed ? source.pipe(createGunzip()) : source;
    if (compressed) source.on("error", error => decoded.destroy(error));
    const cards = [];
    for await (const card of jsonLines(decoded)) {
      if (card.lang !== "en") continue;
      if (card.digital && !card.games?.includes("paper")) continue;
      if (["scheme", "vanguard", "token", "emblem"].some(type => String(card.type_line || "").toLowerCase().includes(type))) continue;
      cards.push(compactCard(card));
    }

    if (!cards.length) throw new Error("Scryfall supplied an empty card index.");
    const output = createWriteStream(`${this.cardsPath}.tmp`);
    const finished = once(output, "finish");
    for (const card of cards) if (!output.write(`${JSON.stringify(card)}\n`)) await once(output, "drain");
    output.end(); await finished;
    await fs.rename(`${this.cardsPath}.tmp`, this.cardsPath);
    await fs.writeFile(path.join(this.dataDir, "oracle-cards.compact.json.tmp"), JSON.stringify(cards));
    await fs.rename(path.join(this.dataDir, "oracle-cards.compact.json.tmp"), path.join(this.dataDir, "oracle-cards.compact.json"));
    const meta = {
      loaded: true,
      updatedAt: new Date().toISOString(),
      sourceUpdatedAt: oracle.updated_at,
      cardCount: cards.length,
      source: "Scryfall Oracle Cards bulk data"
    };
    await fs.writeFile(`${this.metaPath}.tmp`, JSON.stringify(meta, null, 2));
    await fs.rename(`${this.metaPath}.tmp`, this.metaPath);
    this.index(cards);
    return meta;
  }

  async resolveCard(name) {
    await this.ensureReady();
    const normalized = normalizeName(name);
    const local = this.byNormalizedName.get(normalized);
    if (local) return local;
    if (this.snapshotOnly) return null;
    try {
      const live = compactCard(await this.scryfall.named(name, "fuzzy"));
      return live;
    } catch (error) {
      if (/not found|no cards found|couldn't find/i.test(error.message)) return null;
      throw error;
    }
  }

  async autocomplete(q) {
    await this.ensureReady();
    return this.nameIndex.matches(q).map(({ card }) => card.name);
  }

  async inferCard(name) {
    await this.ensureReady();
    return this.nameIndex.resolve(name);
  }

  candidates({ colorIdentity = [], format = "commander" } = {}) {
    const key = `${format}:${[...colorIdentity].sort().join("")}`;
    if (this.candidateCache.has(key)) return this.candidateCache.get(key);
    const allowedColors = new Set(colorIdentity);
    const cards = this.cards.filter(card => {
      if (mainDeckIssue(card)) return false;
      if (format && card.legalities?.[format] !== "legal") return false;
      if (card.games?.length && !card.games.includes("paper")) return false;
      if (format === "commander" && commanderInclusionErrors(card, allowedColors).length) return false;
      return (card.color_identity || []).every(color => allowedColors.has(color));
    });
    if (this.candidateCache.size >= 64) this.candidateCache.delete(this.candidateCache.keys().next().value);
    this.candidateCache.set(key, cards);
    return cards;
  }
}

module.exports = {
  ScryfallClient,
  CardStore,
  normalizeName,
  asText,
  cheapestUsd,
  jsonLines
};
