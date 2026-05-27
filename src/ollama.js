const DEFAULT_BASE_URL = "http://localhost:11434";

class OllamaError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OllamaError";
    this.details = details;
  }
}

function normalizeModelName(name) {
  const model = String(name || "").trim();
  return model.includes(":") ? model : `${model}:latest`;
}

function withoutLatest(name) {
  return String(name || "").replace(/:latest$/, "");
}

function parseJsonObject(text, context) {
  const raw = String(text || "").trim();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON was not an object");
    }
    return parsed;
  } catch (error) {
    throw new OllamaError(`Ollama returned invalid JSON for ${context}.`, {
      cause: error.message,
      raw: raw.slice(0, 500)
    });
  }
}

function assertString(value, field, { min = 1, max = 200 } = {}) {
  if (typeof value !== "string") {
    throw new OllamaError(`Ollama response field "${field}" must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new OllamaError(`Ollama response field "${field}" has invalid length.`);
  }
  return trimmed;
}

function summarizeCard(item) {
  const card = item.card || item;
  return {
    name: card.name,
    type_line: card.type_line,
    mana_value: card.cmc,
    oracle_text: card.oracle_text,
    color_identity: card.color_identity || [],
    keywords: card.keywords || [],
    price_usd: card.cheapest_usd,
    roles: item.roles || [],
    score: typeof item.score === "number" ? Number(item.score.toFixed(3)) : undefined,
    reasons: item.reasons || [],
    scryfall_uri: card.scryfall_uri
  };
}

function summarizeCardLite(item) {
  const card = item.card || item;
  return {
    name: card.name,
    type_line: card.type_line,
    mana_value: card.cmc,
    price_usd: card.cheapest_usd,
    roles: item.roles || [],
    score: typeof item.score === "number" ? Number(item.score.toFixed(3)) : undefined,
    reasons: item.reasons || []
  };
}

function collectAllowedNames(anchor, result, intent) {
  const names = new Set([anchor.name]);
  if (intent === "recommend_card") {
    names.add(result.recommendation.card.name);
    for (const item of result.alternatives || []) names.add(item.card.name);
    return names;
  }
  for (const item of result.cards || []) names.add(item.card.name);
  return names;
}

function composeAnswer({ anchor, result, intent, parsed }) {
  if (intent === "recommend_card") {
    const rec = result.recommendation;
    const card = rec.card;
    const reasons = [
      ...(rec.reasons || []),
      ...(Array.isArray(parsed.synergySummary) ? parsed.synergySummary : [])
    ];
    const uniqueReasons = Array.from(new Set(reasons)).slice(0, 4);
    const price = card.cheapest_usd == null ? "an unknown current USD price" : `$${card.cheapest_usd.toFixed(2)}`;
    return `${card.name} is the strongest budget match I found for ${anchor.name}. It scores ${rec.score.toFixed(2)} because it ${uniqueReasons.join(", ") || "matches the anchor card's core plan"}, and its cheapest tracked Scryfall USD price is ${price}.`;
  }

  const roleParts = Object.entries(result.roleCounts || {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([role, count]) => `${count} ${role}`);
  const validation = result.validation.ok
    ? "The generated list passes the local Commander validation checks."
    : `The generated list failed validation: ${result.validation.errors.slice(0, 2).join(" ")}`;
  return `I built a ${result.cards.length}-card Commander deck around ${anchor.name} with an estimated Scryfall low-price total of $${result.totalEstimatedUsd.toFixed(2)}. The role spread emphasizes ${roleParts.join(", ")}, with the highest-ranked synergy cards selected before budget lands filled the curve. ${validation}`;
}

function validateMentionedCards(mentionedCards, allowedNames) {
  if (!Array.isArray(mentionedCards)) {
    throw new OllamaError("Ollama response field \"mentionedCards\" must be an array.");
  }
  const allowed = new Set(Array.from(allowedNames).map(name => name.toLowerCase()));
  for (const name of mentionedCards) {
    if (typeof name !== "string" || !allowed.has(name.toLowerCase())) {
      throw new OllamaError(`Ollama mentioned a card outside the validated result set: ${name}`);
    }
  }
}

class OllamaClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, model }) {
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.model = model;
  }

  async request(endpoint, payload, { timeoutMs = 120_000 } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: payload ? "POST" : "GET",
        headers: payload ? { "Content-Type": "application/json" } : {},
        body: payload ? JSON.stringify(payload) : undefined,
        signal: controller.signal
      });
      const text = await response.text();
      const json = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new OllamaError(`Ollama ${endpoint} failed with HTTP ${response.status}.`, json);
      }
      return json;
    } catch (error) {
      if (error instanceof OllamaError) throw error;
      if (error.name === "AbortError") {
        throw new OllamaError(`Ollama ${endpoint} exceeded ${Math.round(timeoutMs / 1000)} seconds.`, {
          cause: "timeout",
          timeoutMs
        });
      }
      throw new OllamaError(`Ollama is not reachable at ${this.baseUrl}.`, {
        cause: error.message
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async status() {
    try {
      const tags = await this.request("/api/tags", null, { timeoutMs: 5_000 });
      const models = Array.isArray(tags.models) ? tags.models : [];
      const requested = normalizeModelName(this.model);
      const available = models.some(model => {
        const name = model.name || model.model;
        return name === requested || withoutLatest(name) === withoutLatest(requested);
      });
      return {
        reachable: true,
        baseUrl: this.baseUrl,
        requestedModel: requested,
        modelAvailable: available,
        models: models.map(model => ({
          name: model.name || model.model,
          size: model.size,
          modified_at: model.modified_at
        }))
      };
    } catch (error) {
      return {
        reachable: false,
        baseUrl: this.baseUrl,
        requestedModel: normalizeModelName(this.model),
        modelAvailable: false,
        models: [],
        error: error.message,
        details: error.details
      };
    }
  }

  async assertReady() {
    const status = await this.status();
    if (!status.reachable) {
      throw new OllamaError("Ollama service is not reachable.", status);
    }
    if (!status.modelAvailable) {
      throw new OllamaError(`Ollama model ${status.requestedModel} is not installed.`, status);
    }
    return status;
  }

  async pull(model = this.model) {
    const requested = normalizeModelName(model);
    return this.request("/api/pull", {
      model: requested,
      stream: false
    }, { timeoutMs: 1000 * 60 * 30 });
  }

  async generate({ prompt, format, system, temperature = 0.05, timeoutMs = 300_000, maxTokens = 700 }) {
    await this.assertReady();
    return this.request("/api/generate", {
      model: normalizeModelName(this.model),
      prompt,
      system,
      format,
      stream: false,
      keep_alive: "2m",
      options: {
        temperature,
        top_p: 0.85,
        repeat_penalty: 1.08,
        num_ctx: 4096,
        num_predict: maxTokens
      }
    }, { timeoutMs });
  }

  async parseIntent(message) {
    const system = [
      "You are a strict Magic: The Gathering intent parser.",
      "Return only valid JSON matching the requested schema.",
      "Do not infer a card that is not named by the user.",
      "Do not add commentary."
    ].join(" ");
    const prompt = [
      "Classify this request for an MTG Scryfall deckbuilding app.",
      "Schema:",
      "{",
      "  \"intent\": \"build_deck\" | \"recommend_card\",",
      "  \"cardName\": \"exact card name text from the user\",",
      "  \"format\": \"commander\" | \"modern\" | \"standard\" | \"pioneer\" | \"pauper\" | null,",
      "  \"budgetMode\": \"budget\" | \"balanced\" | \"power\" | null,",
      "  \"maxCardPriceUsd\": number | null",
      "}",
      "Rules:",
      "- build_deck means the user asks for a deck/list/shell around a card.",
      "- recommend_card means the user asks for one card, a compatible card, or a card that works well with another card.",
      "- cardName must preserve the named card only, without braces, punctuation, or surrounding prose.",
      "- If a field is not explicit, use null except intent.",
      `User message: ${JSON.stringify(message)}`
    ].join("\n");
    const result = await this.generate({ prompt, system, format: "json", temperature: 0, maxTokens: 140 });
    const parsed = parseJsonObject(result.response, "intent parsing");
    const intent = assertString(parsed.intent, "intent");
    if (!["build_deck", "recommend_card"].includes(intent)) {
      throw new OllamaError(`Unsupported intent from Ollama: ${intent}`);
    }
    const cardName = assertString(parsed.cardName, "cardName", { min: 2, max: 120 })
      .replace(/[{}]/g, "")
      .replace(/[?.!]+$/g, "")
      .trim();
    return {
      intent,
      cardName,
      format: parsed.format || null,
      budgetMode: parsed.budgetMode || null,
      maxCardPriceUsd: Number.isFinite(Number(parsed.maxCardPriceUsd)) ? Number(parsed.maxCardPriceUsd) : null,
      source: "ollama"
    };
  }

  async explain({ message, anchor, result, intent }) {
    const allowedNames = collectAllowedNames(anchor, result, intent);
    const compact = intent === "recommend_card"
      ? {
        recommendation: summarizeCard(result.recommendation),
        alternatives: result.alternatives.slice(0, 3).map(summarizeCard),
        evaluatedCandidateCount: result.evaluated
      }
      : {
        commander: summarizeCardLite(anchor),
        totalEstimatedUsd: result.totalEstimatedUsd,
        roleCounts: result.roleCounts,
        manaCurve: result.curve,
        validation: result.validation,
        topSynergyCards: result.mainboard.slice(0, 8).map(summarizeCardLite),
        sampleLands: result.mainboard.filter(item => item.roles.includes("land")).slice(0, 3).map(summarizeCardLite)
      };

    const system = [
      "You are JankBot, a precise Magic: The Gathering deckbuilding assistant.",
      "Scryfall and the deterministic scoring engine are the source of truth.",
      "Use only supplied JSON card data.",
      "Never invent cards, card text, legality, prices, or rules.",
      "Return only valid JSON."
    ].join(" ");
    const prompt = [
      "Write the user-facing answer for this MTG recommendation.",
      "Schema:",
      "{",
      "  \"answer\": \"concise markdown-free explanation\",",
      "  \"synergySummary\": [\"short point\", \"short point\"],",
      "  \"budgetSummary\": \"short price/tradeoff note\",",
      "  \"mentionedCards\": [\"only card names from the supplied data\"]",
      "}",
      "Requirements:",
      "- Mention only cards present in Result data.",
      "- Explain why the scored card or deck works with the anchor.",
      "- Mention budget pressure using supplied prices only.",
      "- If validation is not ok, clearly state that the generated list failed validation.",
      "- Do not use markdown tables.",
      `User message: ${message}`,
      `Anchor card: ${JSON.stringify(summarizeCard(anchor))}`,
      `Allowed card names: ${JSON.stringify(Array.from(allowedNames))}`,
      `Result data: ${JSON.stringify(compact)}`
    ].join("\n\n");
    const generated = await this.generate({ prompt, system, format: "json", temperature: 0.08, timeoutMs: 300_000, maxTokens: 420 });
    const parsed = parseJsonObject(generated.response, "recommendation explanation");
    const answer = assertString(parsed.answer, "answer", { min: 8, max: 2500 });
    validateMentionedCards(parsed.mentionedCards || [], allowedNames);
    const synergySummary = Array.isArray(parsed.synergySummary)
      ? parsed.synergySummary
      : typeof parsed.synergySummary === "string"
        ? [parsed.synergySummary]
        : [];
    return {
      text: composeAnswer({ anchor, result, intent, parsed: { ...parsed, answer } }),
      synergySummary: synergySummary.map(item => assertString(item, "synergySummary item", { min: 2, max: 220 })).slice(0, 5),
      budgetSummary: typeof parsed.budgetSummary === "string" ? parsed.budgetSummary.trim() : "",
      mentionedCards: parsed.mentionedCards || [],
      usedOllama: true
    };
  }
}

module.exports = {
  OllamaClient,
  OllamaError,
  normalizeModelName,
  summarizeCard
};
