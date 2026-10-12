const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { once } = require("node:events");
const { execFileSync } = require("node:child_process");
const { DemoAccess, digest } = require("../src/demo-access");
const { createApp } = require("../server");
const { renderDemoLink } = require("../scripts/manage-demo");

const token = "L".repeat(43);
const id = "b".repeat(24);
const configFor = () => ({ version: 1, hostProbeHash: digest("host-probe"), invites: [{ id, kind: "link", label: "Portfolio", codeHash: digest(token), enabled: true, expiresAt: new Date(Date.now() + 86400_000).toISOString() }] });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jankbot-links-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = configFor();
  const demo = new DemoAccess({ config, usagePath: path.join(dir, "usage.json") });
  await demo.initialize();
  return { dir, config, demo };
}
function claim(demo, cookie = "") {
  const headers = {};
  const session = demo.login({ headers: { cookie } }, { setHeader: (key, value) => { headers[key] = value; } }, token, { linkOnly: true });
  return { session, cookie: headers["Set-Cookie"]?.split(";")[0] || cookie };
}

test("shared links have bounded visitor sessions and reuse an existing session", async t => {
  const { demo } = await fixture(t);
  const first = claim(demo);
  for (let i = 0; i < 40; i++) assert.equal(claim(demo, first.cookie).session.id, first.session.id);
  for (let i = 0; i < 29; i++) claim(demo);
  assert.throws(() => claim(demo), { status: 429 });
  demo.loginLimits.entries.clear();
  claim(demo); claim(demo);
  assert.equal(demo.sessions.size, 32);
  assert.throws(() => claim(demo), { status: 429 });
  assert.equal(demo.require({ headers: { cookie: first.cookie } }).id, first.session.id);
});

test("link exchange rejects incorrect, legacy-code, expired, and revoked credentials", async t => {
  const { demo, config } = await fixture(t);
  for (const invalid of [undefined, "", "L", "X".repeat(43), { token }]) {
    assert.throws(() => demo.login({ headers: {} }, { setHeader() {} }, invalid, { linkOnly: true }), { status: 401 });
  }
  config.invites[0].kind = "code";
  assert.throws(() => claim(demo), { status: 401 });
  config.invites[0].kind = "link";
  const accepted = claim(demo);
  config.invites[0].enabled = false;
  assert.throws(() => claim(demo), { status: 401 });
  assert.throws(() => demo.require({ headers: { cookie: accepted.cookie } }), { status: 401 });
  config.invites[0].enabled = true;
  config.invites[0].expiresAt = new Date(Date.now() - 1).toISOString();
  assert.throws(() => claim(demo), { status: 401 });
});

test("the claim endpoint requires same-origin JSON POST and grants no maintenance access", async t => {
  const { demo } = await fixture(t);
  const app = createApp({ demo, production: true, store: {}, ollama: {} });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = (origin, body = JSON.stringify({ token })) => fetch(`${url}/api/demo/claim`, { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body });
  assert.equal((await post()).status, 403);
  assert.equal((await post("https://attacker.example")).status, 403);
  assert.equal((await post(url, JSON.stringify({ token: "X".repeat(43) }))).status, 401);
  assert.equal((await post(url, JSON.stringify({ token, extra: "x".repeat(1024) }))).status, 413);
  assert.equal((await fetch(`${url}/api/demo/claim?token=${token}`)).status, 401);
  const response = await post(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Strict/);
  const data = await response.json();
  assert.equal(data.authenticated, true);
  assert.ok(!JSON.stringify(data).includes(token));
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${url}/api/sync`, { headers: { Cookie: cookie } })).status, 404);
});

test("link generation reuses credentials and rotation preserves invitation quotas", async t => {
  const { dir, config, demo } = await fixture(t);
  const root = path.join(dir, "deployment");
  const privateDir = path.join(dir, "private");
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.mkdir(privateDir);
  await fs.writeFile(path.join(root, "config", "demo-access.json"), JSON.stringify(config));
  await fs.writeFile(path.join(privateDir, "demo-links.json"), JSON.stringify({ [id]: token }));
  const run = operation => execFileSync(process.execPath, [path.join(__dirname, "../scripts/manage-demo.js"), operation, root, privateDir, "Portfolio", "https://jankbot.example"], { stdio: "pipe" }).toString();
  assert.ok(!run("link").includes(token));
  const generated = await fs.readFile(path.join(privateDir, "jankbot-link.txt"), "utf8");
  assert.match(generated, /#demo=L{43}/);
  run("link");
  assert.equal(await fs.readFile(path.join(privateDir, "jankbot-link.txt"), "utf8"), generated);
  await demo.admit(id);
  run("rotate-link");
  const rotated = JSON.parse(await fs.readFile(path.join(root, "config", "demo-access.json"), "utf8"));
  assert.equal(rotated.invites[0].id, id);
  assert.notEqual(rotated.invites[0].codeHash, digest(token));
  const restarted = new DemoAccess({ config: rotated, usagePath: demo.usagePath });
  await restarted.initialize();
  assert.equal(restarted.usage[id].total, 1);
  assert.throws(() => claim(restarted), { status: 401 });
  const rotatedTokens = JSON.parse(await fs.readFile(path.join(privateDir, "demo-links.json"), "utf8"));
  assert.doesNotThrow(() => restarted.login({ headers: {} }, { setHeader() {} }, rotatedTokens[id], { linkOnly: true }));
  await fs.rm(path.join(privateDir, "demo-links.json"));
  assert.throws(() => run("link"), error => /missing or mismatched/.test(error.stderr.toString()));
});

test("link rendering uses JankBot text, a fragment, and an HTTPS-only origin", () => {
  const link = renderDemoLink("https://jankbot.example", token);
  assert.equal(link.href, `https://jankbot.example/#demo=${token}`);
  assert.match(link.html, /rel="noopener noreferrer">JankBot<\/a>/);
  for (const origin of ["http://example.org", "https://example.org/path", "https://example.org/?token=bad", "https://user:pass@example.org"]) {
    assert.throws(() => renderDemoLink(origin, token));
  }
});

async function clientFixture(hash, fetch) {
  const nodes = new Map();
  for (const key of ["#demoAccess", "#demoAccessError", "#demoSignOut", ".shell", "#signOutDialog", "#confirmSignOut", "#cancelSignOut", "#signOutError"]) {
    nodes.set(key, { open: false, textContent: "", hidden: false, events: {}, addEventListener(name, fn) { this.events[name] = fn; }, showModal() { this.open = true; }, close() { this.open = false; } });
  }
  const events = {};
  const location = { hash, pathname: "/", search: "" };
  const history = { replaceState(_state, _title, url) { assert.equal(url, "/"); location.hash = ""; } };
  const context = vm.createContext({ document: { querySelector: key => nodes.get(key) }, location, history, fetch, Date, setTimeout: () => 1, clearTimeout() {}, sessionStorage: { removeItem() {}, setItem() { throw Error("Tokens must not be stored"); } }, window: { addEventListener(name, fn) { events[name] = fn; } } });
  vm.runInContext(await fs.readFile(path.join(__dirname, "../public/access.js"), "utf8"), context);
  return { context, nodes, location, events };
}

test("one-click client removes the fragment before exchanging the token, without code input", async () => {
  let client;
  const calls = [];
  client = await clientFixture(`#demo=${token}`, async (url, options) => {
    assert.equal(client.location.hash, "");
    calls.push({ url, options });
    return { ok: true, json: async () => ({ authenticated: true, enabled: true, expiresAt: Date.now() + 1000 }) };
  });
  await vm.runInContext("JankBotAccess.ensure()", client.context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/demo/claim");
  assert.equal(JSON.parse(calls[0].options.body).token, token);
  assert.equal(client.nodes.get(".shell").inert, false);
  assert.equal(client.nodes.get("#demoAccess").open, false);
  assert.equal(client.nodes.get("#demoSignOut").hidden, false);
});

test("invalid link client fails closed and accepts a later valid same-page invitation", async () => {
  let calls = 0;
  const client = await clientFixture("#demo=invalid", async () => {
    calls++;
    return { ok: true, json: async () => ({ authenticated: true, enabled: true }) };
  });
  const pending = vm.runInContext("JankBotAccess.ensure()", client.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(client.location.hash, "");
  assert.equal(client.nodes.get(".shell").inert, true);
  assert.match(client.nodes.get("#demoAccessError").textContent, /incomplete or invalid/);
  client.location.hash = `#demo=${token}`;
  client.events.hashchange();
  await pending;
  assert.equal(calls, 1);
  assert.equal(client.nodes.get(".shell").inert, false);
});

test("canceling sign-out confirmation leaves the session and saved work untouched", async () => {
  const calls = [];
  const client = await clientFixture("", async url => {
    calls.push(url);
    return { ok: true, json: async () => ({ authenticated: true, enabled: true }) };
  });
  await vm.runInContext("JankBotAccess.ensure()", client.context);
  await client.nodes.get("#demoSignOut").events.click();
  assert.equal(client.nodes.get("#signOutDialog").open, true);
  assert.deepEqual(calls, ["/api/session"]);
  client.nodes.get("#cancelSignOut").events.click();
  assert.deepEqual(calls, ["/api/session"]);
  assert.equal(client.nodes.get("#signOutDialog").open, false);
  assert.equal(client.nodes.get(".shell").inert, false);
  assert.equal(client.nodes.get("#demoAccess").open, false);
  assert.notEqual(client.nodes.get("#demoSignOut").disabled, true);
});

test("confirming sign-out ends the session and requires the invitation again", async () => {
  const calls = [];
  const client = await clientFixture("", async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ authenticated: true, enabled: true }) };
  });
  await vm.runInContext("JankBotAccess.ensure()", client.context);
  await client.nodes.get("#demoSignOut").events.click();
  await client.nodes.get("#confirmSignOut").events.click();
  assert.equal(calls[1].url, "/api/demo/logout");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(client.nodes.get(".shell").inert, true);
  assert.equal(client.nodes.get("#demoAccess").open, true);
  assert.equal(client.nodes.get("#demoSignOut").hidden, true);
  assert.equal(client.nodes.get("#demoSignOut").disabled, false);
  assert.equal(client.nodes.get("#signOutDialog").open, false);
});
