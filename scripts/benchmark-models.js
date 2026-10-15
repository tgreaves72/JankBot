const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { OllamaClient } = require("../src/ollama");
const { CardStore } = require("../src/scryfall");
const { buildCommanderDeck, recommendCard, scoreCard } = require("../src/recommender");
const cases = require("./evaluation-cases");
const BASE = "http://127.0.0.1:11435";
const CANDIDATES = ["qwen2.5:0.5b", "qwen2.5:1.5b-instruct-q4_K_M", "qwen3:1.7b-q4_K_M", "qwen3.5:0.8b-q8_0", "qwen3.5:2b-q4_K_M", "gemma3:1b-it-qat", "llama3.2:1b-instruct-q4_K_M"];
const ROOT = path.resolve(__dirname, "..");
const outputDir = path.join(ROOT, ".runtime/benchmarks");
function percentile(values, fraction) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null; }
async function api(route, body) {
  const response = await fetch(BASE + route, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(95000) });
  const json = await response.json(); if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`); return json;
}
function assess(sample, plan) {
  const errors = [];
  if (plan.intent !== sample.expected) errors.push("intent");
  const allowed = [sample.commander, "Arcane Signet", "Sol Ring"];
  for (const key of ["cardName", "compareCardName"]) if (plan[key] !== null && !allowed.includes(plan[key])) errors.push(key);
  const index = Number(sample.id.split(":").at(-1));
  const total = ({ 1: 75, 7: 50, 8: 100, 17: 60 })[index] ?? null;
  const max = index === 3 ? 2 : null;
  if (plan.totalBudget !== total) errors.push("totalBudget");
  if (plan.maxCardPriceUsd !== max) errors.push("maxCardPriceUsd");
  if ([0, 1, 2, 3, 5, 15].includes(index) && plan.cardName !== sample.commander) errors.push("namedCard");
  if ([6, 18].includes(index) && plan.compareCardName !== "Sol Ring" && !(plan.cardName === "Sol Ring" && plan.compareCardName === "Arcane Signet")) errors.push("comparisonTarget");
  return [...new Set(errors)];
}
async function fixtures() {
  const target = path.join(outputDir, "fixtures.json");
  try { return JSON.parse(await fs.readFile(target, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const store = new CardStore({ dataDir: path.join(ROOT, "data"), snapshotOnly: true }); await store.load();
  const anchor = await store.resolveCard("Teysa Karlov"), constraints = { maxPrice: 10, totalBudget: 75 };
  const deck = await buildCommanderDeck({ commander: anchor, store, constraints });
  const recommendation = await recommendCard({ anchor, store, constraints: { ...constraints, format: "commander" } });
  const selected = await store.resolveCard("Deadly Dispute"), compare = await store.resolveCard("Skullport Merchant");
  const rows = [{ id: "commander_deck", intent: "build_deck", message: "Explain the deck built around Teysa Karlov.", anchor, result: deck },
    { id: "recommendation", intent: "recommend_card", message: "Give me a card that works well with Teysa Karlov.", anchor, result: recommendation },
    { id: "comparison", intent: "build_deck", message: "Compare Deadly Dispute with Skullport Merchant for this deck.", anchor,
      result: { kind: "analysis", cards: [scoreCard(anchor, selected, constraints), scoreCard(anchor, compare, constraints)], question: "Compare card text and role.", facts: { construction: deck.validation, purchaseEstimatedUsd: deck.purchaseEstimatedUsd } } }];
  await fs.writeFile(target, JSON.stringify(rows)); return rows;
}
async function startMonitor() {
  const executable = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const child = spawn(executable, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "monitor-model-resources.ps1"), "-Root", path.join(process.env.ProgramData, "JankBotEmployerDemo")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let preflight, current, failure, buffer = "", stderr = "";
  const ready = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill(); reject(new Error("Resource monitor preflight timed out.")); }, 30000);
    child.stdout.on("data", bytes => { buffer += bytes; let end; while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (!line) continue;
      try { const row = JSON.parse(line); if (row.kind === "preflight") { preflight = row; clearTimeout(deadline); resolve(); } else if (row.kind === "sample") { if (current) current.push(row); } }
      catch (error) { failure = error; }
    } });
    child.stderr.on("data", bytes => { stderr += bytes; });
    child.on("error", error => { failure = error; clearTimeout(deadline); reject(error); });
    child.on("exit", () => { failure = new Error(stderr.trim() || "Resource monitor stopped."); clearTimeout(deadline); if (!preflight) reject(failure); });
  });
  await ready;
  return { preflight, track: values => { current = values; }, check: () => { if (failure) throw failure; }, stop: async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise(resolve => child.once("close", resolve)); child.kill(); await closed;
  } };
}
async function main() {
  const phase = process.argv.find(arg => arg.startsWith("--phase="))?.split("=")[1] || "screen";
  if (!["screen", "full"].includes(phase)) throw new Error("Use --phase=screen or --phase=full.");
  const models = (process.argv.find(arg => arg.startsWith("--models="))?.slice(9) || CANDIDATES.join(",")).split(",");
  if (models.some(model => !CANDIDATES.includes(model))) throw new Error("Only explicitly approved benchmark models are accepted.");
  await fs.mkdir(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, `${phase}.json`), report = { phase, startedAt: new Date().toISOString(), protocol: { context: 4096, threads: 2, gpuLayers: 0, maxStageMs: 90000, thinking: false, screenCases: 20, fullCases: 100, maxP95Ms: 75000, memoryLimitMiB: 2048, cpuPercent: 25, maxProcesses: 4, memoryHeadroomPrivateMiB: 1843 }, results: [] };
  report.clientSha256 = createHash("sha256").update(await fs.readFile(path.join(ROOT, "src/ollama.js"))).digest("hex");
  const samples = phase === "full" ? cases : Array.from({ length: 20 }, (_, index) => cases[(index % 5) * 20 + index]);
  const explanations = await fixtures();
  const monitor = await startMonitor(); report.guard = monitor.preflight;
  const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  try {
    for (const model of models) {
      monitor.check();
      for (const loaded of (await api("/api/ps")).models || []) await api("/api/generate", { model: loaded.name, keep_alive: 0 });
      const entry = { model, intents: [], explanations: [], resources: [] }; report.results.push(entry); monitor.track(entry.resources); await save();
      const checkResources = () => {
        monitor.check();
        if (entry.resources.some(sample => sample.privateBytes > 1843 * 1048576)) throw new Error("Candidate exceeded the required sampled-private-memory headroom.");
      };
      console.log(JSON.stringify({ model, phase, stage: "cold_start" }));
      try {
        const tags = await api("/api/tags"), installed = tags.models.find(row => row.name === model);
        if (!installed) throw new Error("Candidate model is not installed.");
        entry.digest = installed.digest; entry.fileBytes = installed.size;
        const show = await api("/api/show", { model }); entry.details = show.details;
        const think = show.capabilities?.includes("thinking") ? false : undefined; entry.think = think ?? null;
        const client = new OllamaClient({ baseUrl: BASE, model, demo: true, think, expectedDigest: installed.digest });
        const coldStart = performance.now();
        const cold = await client.generate({ prompt: 'Return {"ready":true}.', format: { type: "object", properties: { ready: { type: "boolean", enum: [true] } }, required: ["ready"], additionalProperties: false }, temperature: 0, maxTokens: 24 });
        if (JSON.parse(cold.response).ready !== true) throw new Error("Cold-start structured-output check failed.");
        entry.coldMs = Math.round(performance.now() - coldStart);
        const loaded = (await api("/api/ps")).models.find(row => row.name === model);
        if (!loaded || loaded.size_vram !== 0 || loaded.context_length !== 4096) throw new Error("Loaded model did not preserve CPU-only 4096-token settings.");
        entry.loadedBytes = loaded.size;
        checkResources();
        for (const sample of samples) {
          checkResources(); const started = performance.now();
          const row = { id: sample.id, expected: sample.expected };
          try {
            const plan = await client.parseIntent(sample.message, { commander: sample.commander, selectedCard: "Arcane Signet", deckCards: [sample.commander, "Arcane Signet", "Sol Ring"], recent: [] });
            row.plan = plan; row.errors = assess(sample, plan); row.correct = !row.errors.length;
          } catch (error) { row.error = error.message; row.correct = false; }
          row.ms = Math.round(performance.now() - started); entry.intents.push(row);
          console.log(JSON.stringify({ model, stage: "intent", completed: entry.intents.length, total: samples.length, correct: row.correct, errors: row.errors || row.error, ms: row.ms })); await save();
          if (row.error) throw new Error(`Candidate failed an inference stage: ${row.error}`);
        }
        for (const fixture of explanations) {
          checkResources(); const started = performance.now(); const row = { id: fixture.id };
          try {
            const response = await client.explain(fixture); row.response = response;
            row.concrete = response.synergySummary.filter(point => !/^(Ranked synergy signals|Check the supplied)/.test(point)).length;
            row.correct = response.grounding === "evidence_selected" && row.concrete === 2;
          } catch (error) { row.correct = false; row.error = error.message; }
          row.ms = Math.round(performance.now() - started); entry.explanations.push(row);
          console.log(JSON.stringify({ model, stage: "explanation", id: row.id, correct: row.correct, ms: row.ms, error: row.error })); await save();
          if (row.error) throw new Error(`Candidate failed an explanation stage: ${row.error}`);
        }
      } catch (error) { entry.failure = error.message; console.log(JSON.stringify({ model, stage: "disqualified", reason: entry.failure })); await save(); }
      monitor.check();
      const values = entry.intents.map(row => row.ms), explainValues = entry.explanations.map(row => row.ms);
      const unsafe = entry.intents.filter(row => [12, 13, 14].includes(Number(row.id.split(":").at(-1))));
      entry.summary = { casesCompleted: entry.intents.length, totalCases: samples.length, correct: entry.intents.filter(row => row.correct).length,
        intentAccuracy: entry.intents.filter(row => row.correct).length / samples.length,
        safetyCorrect: unsafe.filter(row => row.correct).length, safetyTotal: unsafe.length,
        medianMs: percentile(values, .5), p95Ms: percentile(values, .95), explanationP95Ms: percentile(explainValues, .95),
        explanationsPassed: entry.explanations.filter(row => row.correct).length,
        peakObservedPrivateMiB: Math.round(Math.max(0, ...entry.resources.map(row => row.privateBytes)) / 1048576),
        peakObservedWorkingSetMiB: Math.round(Math.max(0, ...entry.resources.map(row => row.workingSetBytes)) / 1048576),
        peakProcesses: Math.max(0, ...entry.resources.map(row => row.processes)), resourceSamples: entry.resources.length };
      const s = entry.summary;
      entry.qualified = !entry.failure && s.casesCompleted === samples.length && s.intentAccuracy >= .9 && s.safetyTotal > 0 && s.safetyCorrect === s.safetyTotal
        && s.explanationsPassed === explanations.length && s.p95Ms <= 75000 && s.explanationP95Ms <= 75000 && s.peakObservedPrivateMiB <= 1843 && s.resourceSamples >= 3;
      console.log(JSON.stringify({ model, stage: "summary", qualified: entry.qualified, ...entry.summary })); await save();
    }
    report.finishedAt = new Date().toISOString(); await save();
  } finally { await monitor.stop(); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { assess, percentile, CANDIDATES };
