const path = require("node:path");
const { ScryfallClient, CardStore } = require("../src/scryfall");
const { OllamaClient } = require("../src/ollama");

async function prepare() {
  const model = process.env.OLLAMA_MODEL || "qwen2.5:0.5b";
  const ollama = new OllamaClient({ model, baseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434" });
  const status = await ollama.status();
  if (!status.reachable) throw new Error("Start Ollama before preparing the host.");
  if (!status.modelAvailable) {
    if (!process.argv.includes("--pull")) throw new Error(`Model missing. Run ollama pull ${model}, or npm run setup -- --pull.`);
    console.log(`Downloading ${model} through Ollama...`);
    await ollama.pull();
  }
  const store = new CardStore({
    dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data")),
    scryfall: new ScryfallClient({ appName: "JankBot/1.0", contact: process.env.SCRYFALL_CONTACT || "JankBot self-hosted" })
  });
  console.log("Preparing current Scryfall data...");
  await store.ensureReady();
  await require("./enrich-data").enrich(store.dataDir);
  await require("./enrich-combos").enrichCombos(store.dataDir);
  console.log("Testing local model inference...");
  const result = await ollama.generate({ prompt: 'Return only {"ready":true}', format: "json", temperature: 0, maxTokens: 20 });
  if (JSON.parse(result.response).ready !== true) throw new Error("Model inference check failed.");
  console.log(JSON.stringify({ ready: true, model, cards: (await store.metadata()).cardCount }));
}

prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
