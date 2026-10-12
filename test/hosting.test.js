const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createApp } = require("../server");
const { ChatJobs, RateLimiter, VisitorSessions } = require("../src/hosting");
const { OllamaError } = require("../src/ollama");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, options = {}) {
  const store = {
    metadata: async () => ({ loaded: true, cardCount: 1 }),
    ensureReady: async () => {},
    autocomplete: async () => ["Plains"],
    resolveCard: async () => null
  };
  const ollama = { status: async () => ({ reachable: true, modelAvailable: true }), parseIntent: async () => { throw new Error("Model unavailable"); } };
  const app = createApp({ store, ollama, production: true, ...options });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  return { ...app, url: `http://127.0.0.1:${app.server.address().port}` };
}

test("chat jobs serialize inference and reject duplicate visitor work", async () => {
  const jobs = new ChatJobs({ maxPending: 2 });
  const gate = deferred();
  const order = [];
  const first = jobs.submit("one", async () => { order.push("first"); await gate.promise; return "ok"; });
  const second = jobs.submit("two", async () => { order.push("second"); return "ok"; });
  assert.throws(() => jobs.submit("one", async () => {}), { status: 409 });
  assert.throws(() => jobs.submit("three", async () => {}), { status: 503 });
  assert.equal(jobs.get(second, "two").position, 1);
  assert.throws(() => jobs.get(first, "two"), { status: 404 });
  assert.deepEqual(order, ["first"]);
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(jobs.get(first, "one").result, "ok");
});

test("failed model work does not become a success result", async () => {
  const jobs = new ChatJobs();
  const id = jobs.submit("one", async () => { throw new Error("Dependency failed"); });
  await new Promise(resolve => setImmediate(resolve));
  const job = jobs.get(id, "one");
  assert.equal(job.status, "failed");
  assert.equal(job.result, undefined);
  assert.match(job.error.message, /required service failed/);
  assert.doesNotMatch(job.error.message, /Dependency failed/);
});

test("invalid model output stays failed with an actionable, infrastructure-safe message", async () => {
  const jobs = new ChatJobs();
  const id = jobs.submit("one", async () => { throw new OllamaError('Ollama response field "synergySummary item" has invalid length.'); });
  await new Promise(resolve => setImmediate(resolve));
  const job = jobs.get(id, "one");
  assert.equal(job.status, "failed");
  assert.equal(job.result, undefined);
  assert.equal(job.error.status, 503);
  assert.match(job.error.message, /No result was saved/);
  assert.doesNotMatch(job.error.message, /Ollama|synergySummary|11435/);
});

test("visitor cookies reject a forged signature", () => {
  const sessions = new VisitorSessions({ secret: "test-secret" });
  const headers = {};
  const res = { setHeader: (key, value) => { headers[key] = value; } };
  const owner = sessions.get({ headers: {} }, res);
  const cookie = headers["Set-Cookie"].split(";")[0];
  assert.equal(sessions.get({ headers: { cookie } }, res), owner);
  assert.notEqual(sessions.get({ headers: { cookie: cookie.slice(0, -1) + "x" } }, res), owner);
});

test("rate limits expire instead of accumulating forever", () => {
  const limiter = new RateLimiter();
  limiter.check("visitor", { limit: 1, now: 10, windowMs: 100 });
  assert.throws(() => limiter.check("visitor", { limit: 1, now: 11 }), { status: 429 });
  assert.doesNotThrow(() => limiter.check("visitor", { limit: 1, now: 111 }));
});

test("public site hides infrastructure and blocks maintenance", async t => {
  const { url } = await fixture(t);
  const response = await fetch(`${url}/api/health`);
  const health = await response.json();
  assert.equal(health.capabilities.maintenance, false);
  assert.equal(health.ollama.baseUrl, undefined);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  for (const route of ["/api/sync", "/api/ollama/pull"]) {
    const result = await fetch(`${url}${route}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.1" }, body: "{}" });
    assert.equal(result.status, 404);
  }
});

test("public API rejects cross-origin mutation and oversized bodies", async t => {
  const { url } = await fixture(t);
  const crossSite = await fetch(`${url}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://other.example" }, body: "{}" });
  assert.equal(crossSite.status, 403);
  const huge = await fetch(`${url}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "x".repeat(70_000) }) });
  assert.equal(huge.status, 413);
  const bad = await fetch(`${url}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(bad.status, 400);
});

test("job polling requires the originating browser cookie", async t => {
  const { url } = await fixture(t);
  const health = await fetch(`${url}/api/health`);
  const cookie = health.headers.get("set-cookie").split(";")[0];
  const accepted = await fetch(`${url}/api/chat`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ message: "Give me a card with Teysa Karlov.", format: "commander", maxPrice: 2 }) });
  assert.equal(accepted.status, 202);
  const { jobId } = await accepted.json();
  const outsider = await fetch(`${url}/api/jobs/${jobId}`);
  assert.equal(outsider.status, 404);
  const own = await fetch(`${url}/api/jobs/${jobId}`, { headers: { Cookie: cookie } });
  const job = await own.json();
  assert.equal(job.status, "failed");
  assert.equal(job.result, undefined);
});

test("static serving prevents encoded Windows path traversal", async t => {
  const { url } = await fixture(t);
  const response = await fetch(`${url}/%2e%2e%5cpackage.json`);
  assert.equal(response.status, 403);
  const head = await fetch(`${url}/`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("deck validation rejects unsupported formats and excessive input", async t => {
  const { url } = await fixture(t);
  for (const body of [{ format: "made-up", cards: ["Plains"] }, { format: "commander", cards: Array(251).fill("Plains") }]) {
    const response = await fetch(`${url}/api/deck/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
});
