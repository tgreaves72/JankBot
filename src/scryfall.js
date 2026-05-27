const fs = require("node:fs/promises");
const path = require("node:path");

const SCRYFALL_ROOT = "https://api.scryfall.com";
const MIN_INTERVAL_MS = 125;
const BULK_MAX_AGE_MS = 1000 * 60 * 60 * 24;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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
  }

  async request(endpoint, params = {}) {
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
  constructor({ dataDir, scryfall }) {
    this.dataDir = dataDir;
    this.scryfall = scryfall;
    this.cardsPath = path.join(dataDir, "oracle-cards.compact.json");
    this.metaPath = path.join(dataDir, "metadata.json");
    this.cards = [];
    this.byName = new Map();
    this.byNormalizedName = new Map();
    this.loaded = false;
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
    await this.ensureDataDir();
    if (this.loaded) return;
    try {
      await this.load();
      const meta = await this.metadata();
      if (!meta.updatedAt || Date.now() - new Date(meta.updatedAt).getTime() > BULK_MAX_AGE_MS) {
        this.refreshBulkData().catch(error => {
          console.warn(`Background Scryfall refresh failed: ${error.message}`);
        });
      }
    } catch {
      await this.refreshBulkData();
    }
  }

  index(cards) {
    this.cards = cards;
    this.byName.clear();
    this.byNormalizedName.clear();
    for (const card of cards) {
      this.byName.set(card.name, card);
      this.byNormalizedName.set(normalizeName(card.name), card);
    }
    this.loaded = true;
  }

  async load() {
    const cards = JSON.parse(await fs.readFile(this.cardsPath, "utf8"));
    this.index(cards);
  }

  async refreshBulkData() {
    await this.ensureDataDir();
    const bulk = await this.scryfall.bulkData();
    const oracle = bulk.data.find(item => item.type === "oracle_cards")
      || bulk.data.find(item => item.name === "Oracle Cards");
    if (!oracle?.download_uri) {
      throw new Error("Scryfall did not provide an Oracle Cards bulk download.");
    }

    const response = await fetch(oracle.download_uri, {
      headers: {
        "User-Agent": "JankBot/1.0 (local-user@example.com)",
        "Accept": "application/json;q=0.9,*/*;q=0.8"
      }
    });
    if (!response.ok) {
      throw new Error(`Bulk download failed: ${response.status}`);
    }
    const raw = await response.json();
    const cards = raw
      .filter(card => card.lang === "en")
      .filter(card => !card.digital || card.games?.includes("paper"))
      .filter(card => !["scheme", "vanguard", "token", "emblem"].some(type => String(card.type_line || "").toLowerCase().includes(type)))
      .map(compactCard);

    await fs.writeFile(this.cardsPath, JSON.stringify(cards));
    const meta = {
      loaded: true,
      updatedAt: new Date().toISOString(),
      sourceUpdatedAt: oracle.updated_at,
      cardCount: cards.length,
      source: "Scryfall Oracle Cards bulk data"
    };
    await fs.writeFile(this.metaPath, JSON.stringify(meta, null, 2));
    this.index(cards);
    return meta;
  }

  async resolveCard(name) {
    await this.ensureReady();
    const normalized = normalizeName(name);
    const local = this.byNormalizedName.get(normalized);
    if (local) return local;
    try {
      const live = compactCard(await this.scryfall.named(name, "fuzzy"));
      return live;
    } catch {
      return null;
    }
  }

  async autocomplete(q) {
    await this.ensureReady();
    const needle = normalizeName(q);
    const local = this.cards
      .filter(card => normalizeName(card.name).includes(needle))
      .slice(0, 12)
      .map(card => card.name);
    if (local.length >= 8) return local;
    try {
      const live = await this.scryfall.autocomplete(q);
      return Array.from(new Set([...local, ...(live.data || [])])).slice(0, 12);
    } catch {
      return local;
    }
  }

  candidates({ colorIdentity = [], format = "commander" } = {}) {
    const allowedColors = new Set(colorIdentity);
    return this.cards.filter(card => {
      if (format && card.legalities?.[format] !== "legal") return false;
      if (card.games?.length && !card.games.includes("paper")) return false;
      return (card.color_identity || []).every(color => allowedColors.has(color));
    });
  }
}

module.exports = {
  ScryfallClient,
  CardStore,
  normalizeName,
  asText,
  cheapestUsd
};
