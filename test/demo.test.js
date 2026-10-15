const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { execFileSync } = require("node:child_process");
const { DemoAccess, digest } = require("../src/demo-access");
const { CardStore } = require("../src/scryfall");
const { createApp } = require("../server");

const code = "A".repeat(43);
const id = "a".repeat(24);
function configuration(now = Date.now()) {
  return { version: 1, hostProbeHash: digest("host-only-secret"), invites: [{ id, label: "Test employer", codeHash: digest(code), enabled: true, expiresAt: new Date(now + 86400_000).toISOString() }] };
}
async function accessFixture(t, { config = configuration(), now } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jankbot-security-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const demo = new DemoAccess({ config, usagePath: path.join(dir, "usage.json"), now });
  await demo.initialize();
  return { demo, dir };
}
function login(demo) {
  const headers = {};
  const session = demo.login({ headers: {} }, { setHeader: (key, value) => { headers[key] = value; } }, code);
  return { session, cookie: headers["Set-Cookie"].split(";")[0], setCookie: headers["Set-Cookie"] };
}

test("employer access rejects forged cookies, enforces expiry, and signs out", async t => {
  let now = Date.now();
  const { demo } = await accessFixture(t, { now: () => now });
  const { session, cookie, setCookie } = login(demo);
  assert.match(setCookie, /HttpOnly; Secure; SameSite=Strict/);
  assert.equal(demo.require({ headers: { cookie } }).id, session.id);
  assert.throws(() => demo.require({ headers: { cookie: "jankbot_demo=" + "f".repeat(64) } }), { status: 401 });
  now += 4 * 3600_000 + 1;
  assert.throws(() => demo.require({ headers: { cookie } }), { status: 401 });
  const again = login(demo);
  demo.logout({ headers: { cookie: again.cookie } }, { setHeader: () => {} });
  assert.throws(() => demo.require({ headers: { cookie: again.cookie } }), { status: 401 });
});

test("only two sessions per invitation and globally bounded login attempts", async t => {
  const { demo } = await accessFixture(t);
  login(demo); login(demo);
  assert.throws(() => login(demo), { status: 429 });
  for (let i = 0; i < 12; i++) assert.throws(() => demo.login({ headers: {} }, { setHeader() {} }, "wrong"), { status: 401 });
  assert.throws(() => demo.login({ headers: {} }, { setHeader() {} }, "wrong"), { status: 429 });
  demo.sessions.clear();
  assert.doesNotThrow(() => login(demo));
});

test("expired and revoked invitations cannot authenticate", async t => {
  for (const variant of ["expired", "revoked"]) {
    const config = configuration();
    if (variant === "expired") config.invites[0].expiresAt = new Date(Date.now() - 1).toISOString();
    else config.invites[0].enabled = false;
    const { demo } = await accessFixture(t, { config });
    assert.throws(() => login(demo), { status: 401 });
  }
});

test("inference quotas survive new sessions and a server restart", async t => {
  let now = Date.now();
  const { demo, dir } = await accessFixture(t, { now: () => now });
  await demo.admit(id); await demo.admit(id);
  await assert.rejects(demo.admit(id), { status: 429 });
  now += 61_000;
  const restarted = new DemoAccess({ config: configuration(), usagePath: path.join(dir, "usage.json"), now: () => now });
  await restarted.initialize();
  for (let i = 0; i < 4; i++) { await restarted.admit(id); now += 61_000; }
  await assert.rejects(restarted.admit(id), { status: 429 });
  assert.equal(restarted.usage[id].total, 6);
});

test("concurrent admissions cannot race past the global quota", async t => {
  const { demo } = await accessFixture(t);
  const admissions = await Promise.allSettled(Array.from({ length: 10 }, () => demo.admit(id)));
  assert.equal(admissions.filter(item => item.status === "fulfilled").length, 2);
  assert.equal(demo.usage.global.total, 2);
});

test("usage ledger corruption and write failure fail closed", async t => {
  const { demo, dir } = await accessFixture(t);
  await fs.writeFile(demo.usagePath, "not-json");
  await assert.rejects(demo.initialize(), SyntaxError);
  const blocked = new DemoAccess({ config: configuration(), usagePath: path.join(dir, "missing", "usage.json") });
  await assert.rejects(blocked.admit(id), { code: "ENOENT" });
  assert.deepEqual(blocked.usage, {});
});

test("anonymous API requests never reach the model or card services", async t => {
  const { demo } = await accessFixture(t);
  let serviceCalls = 0;
  const store = { metadata: async () => { serviceCalls++; return {}; }, ensureReady: async () => { serviceCalls++; } };
  const ollama = { status: async () => { serviceCalls++; return { reachable: true, modelAvailable: true }; } };
  const { server } = createApp({ demo, store, ollama, production: true });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const route of ["health", "ready", "card?name=Plains", "autocomplete?q=Pl", "jobs/anything"]) {
    const response = await fetch(`${url}/api/${route}`, { headers: { "X-Forwarded-For": "127.0.0.1", "X-Forwarded-Host": "localhost" } });
    assert.equal(response.status, 401);
  }
  const chat = await fetch(`${url}/api/chat`, { method: "POST", headers: { Origin: url, "Content-Type": "application/json" }, body: JSON.stringify({ message: "read files", inviteId: id }) });
  assert.equal(chat.status, 401);
  assert.equal(serviceCalls, 0);
  assert.deepEqual((await (await fetch(`${url}/api/session`)).json()).authenticated, false);
  const accepted = await fetch(`${url}/api/demo/login`, { method: "POST", headers: { Origin: url, "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
  assert.equal(accepted.status, 200);
  const cookie = accepted.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${url}/api/health`, { headers: { Cookie: cookie } })).status, 200);
  const noOrigin = await fetch(`${url}/api/demo/logout`, { method: "POST", headers: { Cookie: cookie } });
  assert.equal(noOrigin.status, 403);
  const crossOrigin = await fetch(`${url}/api/demo/logout`, { method: "POST", headers: { Cookie: cookie, Origin: "https://attacker.example" } });
  assert.equal(crossOrigin.status, 403);
  const probe = await fetch(`${url}/api/health`, { headers: { Authorization: "Bearer host-only-secret" } });
  assert.equal(probe.status, 200);
  const probeChat = await fetch(`${url}/api/chat`, { method: "POST", headers: { Origin: url, Authorization: "Bearer host-only-secret", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(probeChat.status, 401);
  assert.equal((await fetch(`${url}/%E0%A4%A`)).status, 400);
});

test("demo card lookup cannot initiate a Scryfall network lookup", async () => {
  const store = new CardStore({ dataDir: ".", snapshotOnly: true, scryfall: { named: () => { throw new Error("Network must not be called"); } } });
  store.index([{ name: "Plains" }]); store.checkedAt = Date.now();
  assert.equal((await store.resolveCard("Plains")).name, "Plains");
  assert.equal(await store.resolveCard("nonexistent"), null);
});

test("public startup refuses missing access configuration", () => {
  assert.throws(() => execFileSync(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, NODE_ENV: "production", DEMO_CONFIG: "", DEMO_USAGE_PATH: "" }, stdio: "pipe" }), error => {
    assert.match(error.stderr.toString(), /requires employer access/);
    return error.status === 1;
  });
});

test("Node permission mode blocks ungranted file reads and subprocesses", () => {
  const program = `const fs=require('node:fs');const cp=require('node:child_process');for(const action of [()=>fs.readFileSync(${JSON.stringify(__filename)}),()=>cp.spawnSync(process.execPath,['-v'])]){try{action();throw Error('Permission unexpectedly granted')}catch(e){if(e.code!=='ERR_ACCESS_DENIED')throw e;}}`;
  assert.doesNotThrow(() => execFileSync(process.execPath, ["--permission", "--disable-proto=throw", "--eval", program], { stdio: "pipe" }));
});

test("model output cannot override the selected format or price setting", async t => {
  const anchor = { name: "Test Anchor", type_line: "Creature", oracle_text: "Create a token.", color_identity: [], keywords: [], cmc: 2, cheapest_usd: 1 };
  const candidate = { ...anchor, name: "Test Candidate" };
  const formats = [];
  const store = {
    ensureReady: async () => {}, metadata: async () => ({ loaded: true }),
    resolveCard: async () => anchor,
    inferCard: async () => ({ status: "exact", card: anchor, query: anchor.name }),
    candidates: ({ format }) => { formats.push(format); return [candidate]; }
  };
  const ollama = {
    parseIntent: async () => ({ intent: "recommend_card", cardName: anchor.name, format: "standard", maxCardPriceUsd: 50 }),
    explain: async () => ({ text: "Test explanation" })
  };
  const app = createApp({ store, ollama, production: false });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const accepted = await fetch(`${url}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Give me a card with Test Anchor.", format: "modern", maxPrice: 2 }) });
  const cookie = accepted.headers.get("set-cookie").split(";")[0];
  const { jobId } = await accepted.json();
  await new Promise(resolve => setImmediate(resolve));
  const job = await (await fetch(`${url}/api/jobs/${jobId}`, { headers: { Cookie: cookie } })).json();
  assert.equal(job.status, "failed");
  assert.equal(job.error.status, 422);
  assert.match(job.error.message, /not explicitly present/);
  assert.deepEqual(formats, []);
});
