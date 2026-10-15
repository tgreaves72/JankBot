const fs = require("node:fs/promises");
const path = require("node:path");
async function main() {
  const text = await fs.readFile(path.resolve(__dirname, "../.runtime/jankbot-link.txt"), "utf8");
  const invite = text.match(/https:\/\/[^\s]+#demo=[A-Za-z0-9_-]{43}/)?.[0];
  if (!invite) throw new Error("No complete demo invitation found.");
  const url = new URL(invite), origin = url.origin, base = "http://127.0.0.1:3000";
  let cookies = [];
  async function request(route, body) {
    const response = await fetch(base + route, { method: body ? "POST" : "GET", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookies.join("; ") }, body: body ? JSON.stringify(body) : undefined });
    for (const value of response.headers.getSetCookie()) { const cookie = value.split(";")[0], name = cookie.split("=")[0]; cookies = cookies.filter(value => !value.startsWith(`${name}=`)); cookies.push(cookie); }
    const data = await response.json(); if (!response.ok) throw new Error(`${route}: ${response.status} ${data.error}`); return data;
  }
  await request("/api/demo/claim", { token: url.hash.slice(6) });
  async function chat(body) {
    const { jobId } = await request("/api/chat", body);
    const stream = await fetch(`${base}/api/jobs/${jobId}/events`, { headers: { Cookie: cookies.join("; ") }, signal: AbortSignal.timeout(240000) });
    if (!stream.ok) throw new Error(`Progress HTTP ${stream.status}`);
    const reader = stream.body.getReader(), decoder = new TextDecoder(); let buffer = "";
    try { for (;;) {
      const next = await reader.read(); if (next.done) throw new Error("Progress disconnected before completion.");
      buffer += decoder.decode(next.value, { stream: true }); let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (!frame.startsWith("data: ")) continue;
        const job = JSON.parse(frame.slice(6)); console.log(JSON.stringify({ status: job.status, stage: job.stage }));
        if (job.status === "failed") throw new Error(job.error.message);
        if (job.status === "complete") return job.result;
      }
    } } finally { await reader.cancel(); }
  }
  const first = process.argv.includes("--followup-only") ? JSON.parse(await fs.readFile(path.resolve(__dirname, "../.runtime/smoke-result.json"), "utf8")) : await chat({ message: "Give me a deck based around Teysa Karlov.", format: "commander", maxPrice: 10,
    constraints: { totalBudget: 75, landCount: 37 } });
  console.log(JSON.stringify({ cards: first.result.cards.length, lands: first.result.mana.landCount, purchase: first.result.purchaseEstimatedUsd, budget: first.result.budget.ok, model: first.model.used, text: first.response.text, usage: first.response.usage }));
  await fs.writeFile(path.resolve(__dirname, "../.runtime/smoke-result.json"), JSON.stringify(first));
  if (process.argv.includes("--followup") || process.argv.includes("--followup-only")) {
    const second = await chat({ message: "Keep the commander and bring the total deck purchase budget under $30.", format: "commander", maxPrice: 10,
      constraints: first.constraints, context: { kind: "commander_deck", revision: 1, commander: first.anchor.name, commanders: first.result.commanders.map(card => card.name),
        cards: first.result.cards.map(item => item.card.name), selectedName: first.result.cards[1].card.name, recent: [] } });
    console.log(JSON.stringify({ kind: second.kind, intent: second.intent, baseRevision: second.baseRevision, purchase: second.result?.purchaseEstimatedUsd, budget: second.result?.budget?.ok, text: second.response?.text, timing: second.timing, usage: second.response?.usage }));
    await fs.writeFile(path.resolve(__dirname, "../.runtime/smoke-proposal.json"), JSON.stringify(second));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
