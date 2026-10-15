const { OllamaClient } = require("../src/ollama");
const cases = require("./evaluation-cases");
const { loadProfile } = require("../src/model-profile");
async function main() {
  const limit = Number(process.argv.find(arg => arg.startsWith("--limit="))?.split("=")[1] || 3);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Use --limit=1 through --limit=100.");
  const profile = loadProfile(), model = profile.model;
  for (const selected of [profile]) {
    const client = new OllamaClient({ ...selected, demo: true, baseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11435" });
    await client.assertReady();
    const durations = []; let correct = 0, failures = 0;
    for (const sample of cases.slice(0, limit)) {
      const start = performance.now();
      try {
        const result = await client.parseIntent(sample.message, { commander: sample.commander, selectedCard: "Arcane Signet", deckCards: [sample.commander, "Arcane Signet", "Sol Ring"], recent: [] });
        const ok = result.intent === sample.expected; if (ok) correct++;
        console.log(JSON.stringify({ model, id: sample.id, expected: sample.expected, actual: result.intent, correct: ok }));
      } catch (error) { failures++; console.log(JSON.stringify({ model, id: sample.id, failure: error.message })); }
      durations.push(Math.round(performance.now() - start));
    }
    const sorted = [...durations].sort((a, b) => a - b);
    console.log(JSON.stringify({ model, evaluated: limit, availableCases: cases.length, correct, failures, coldMs: durations[0], medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)],
      scope: "Intent classification only. Human review is still required for explanation and deck quality. No alternate model is pulled automatically." }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
