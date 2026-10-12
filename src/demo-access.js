const { randomBytes, createHash, timingSafeEqual } = require("node:crypto");
const fs = require("node:fs/promises");
const { HttpError, RateLimiter } = require("./hosting");

const digest = value => createHash("sha256").update(value).digest("hex");
function equalHash(value, expected) {
  return /^[a-f0-9]{64}$/.test(expected || "")
    && timingSafeEqual(Buffer.from(digest(value)), Buffer.from(expected));
}

class DemoAccess {
  constructor({ config, usagePath, now = Date.now }) {
    if (config.version !== 1 || !Array.isArray(config.invites) || !config.invites.length
        || config.invites.length > 64 || !/^[a-f0-9]{64}$/.test(config.hostProbeHash)) {
      throw new Error("Invalid employer access configuration.");
    }
    const ids = new Set();
    for (const invite of config.invites) {
      if (!/^[a-f0-9]{24}$/.test(invite.id) || ids.has(invite.id)
          || !/^[a-f0-9]{64}$/.test(invite.codeHash) || !Number.isFinite(Date.parse(invite.expiresAt))
          || typeof invite.enabled !== "boolean"
          || (invite.kind !== undefined && !["code", "link"].includes(invite.kind))) throw new Error("Invalid employer invitation.");
      ids.add(invite.id);
    }
    this.config = config;
    this.usagePath = usagePath;
    this.now = now;
    this.sessions = new Map();
    this.loginLimits = new RateLimiter();
    this.usage = {};
    this.writes = Promise.resolve();
  }

  async initialize() {
    try { this.usage = JSON.parse(await fs.readFile(this.usagePath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!this.usage || typeof this.usage !== "object" || Array.isArray(this.usage)) throw new Error("Invalid demo usage ledger.");
    for (const [key, entry] of Object.entries(this.usage)) {
      if (key !== "global" && !this.config.invites.some(invite => invite.id === key)) throw new Error("Unknown usage ledger entry.");
      if (!entry || !Number.isSafeInteger(entry.total) || entry.total < 0) throw new Error("Invalid usage total.");
      for (const period of ["minute", "hour", "day"]) {
        if (!entry[period] || !Number.isSafeInteger(entry[period].count) || entry[period].count < 0
            || !Number.isSafeInteger(entry[period].reset)) throw new Error("Invalid usage window.");
      }
    }
  }

  invite(id) {
    return this.config.invites.find(invite => invite.id === id && invite.enabled && Date.parse(invite.expiresAt) > this.now());
  }

  isHost(req) {
    const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
    return token.length <= 128 && equalHash(token, this.config.hostProbeHash);
  }

  prune() {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= this.now() || !this.invite(session.inviteId)) this.sessions.delete(token);
    }
  }

  session(req) {
    this.prune();
    const cookie = String(req.headers.cookie || "").split(";").map(part => part.trim())
      .find(part => part.startsWith("jankbot_demo="));
    const token = cookie?.slice("jankbot_demo=".length) || "";
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    return this.sessions.get(digest(token)) || null;
  }

  require(req) {
    const session = this.session(req);
    if (!session) throw new HttpError(401, "Open JankBot using your demo invitation link.");
    return session;
  }

  login(req, res, code, { linkOnly = false } = {}) {
    // Funnel hides source addresses; a global limit cannot be evaded with forwarding headers.
    const validShape = typeof code === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(code);
    const invite = validShape ? this.config.invites.find(item => equalHash(code, item.codeHash)) : null;
    if (!invite || !this.invite(invite.id) || (linkOnly && invite.kind !== "link")) {
      this.loginLimits.check("invalid:minute", { limit: 12, now: this.now() });
      this.loginLimits.check("invalid:hour", { limit: 60, windowMs: 3600_000, now: this.now() });
      throw new HttpError(401, linkOnly ? "This demo link is invalid, revoked, or expired." : "Invalid or expired access code.");
    }
    const existing = this.session(req);
    if (existing?.inviteId === invite.id) return existing;
    // Invalid-code flooding must not consume a legitimate invitation's login allowance.
    const shared = invite.kind === "link";
    this.loginLimits.check(`${invite.id}:login`, { limit: shared ? 30 : 5, now: this.now() });
    this.prune();
    const maxSessions = shared ? 32 : 2;
    if (this.sessions.size >= 128 || Array.from(this.sessions.values()).filter(session => session.inviteId === invite.id).length >= maxSessions) {
      throw new HttpError(429, "The demo has reached its active visitor limit. Please try later.");
    }
    this.logout(req, res);
    const token = randomBytes(32).toString("hex");
    const expiresAt = Math.min(this.now() + 4 * 3600_000, Date.parse(invite.expiresAt));
    const session = { id: randomBytes(24).toString("hex"), inviteId: invite.id, expiresAt };
    this.sessions.set(digest(token), session);
    res.setHeader("Set-Cookie", `jankbot_demo=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor((expiresAt - this.now()) / 1000)}`);
    return session;
  }

  logout(req, res) {
    const cookie = String(req.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith("jankbot_demo="));
    if (cookie) this.sessions.delete(digest(cookie.slice("jankbot_demo=".length)));
    res.setHeader("Set-Cookie", "jankbot_demo=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
  }

  view(session) {
    return { enabled: true, authenticated: Boolean(session), expiresAt: session?.expiresAt,
      limits: { requestsPerHour: 6, requestsPerDay: 20, totalRequests: 60 } };
  }

  admit(inviteId) {
    const task = this.writes.then(async () => {
      if (!this.invite(inviteId)) throw new HttpError(401, "Invitation expired.");
      const next = structuredClone(this.usage);
      for (const [key, limits] of [["global", { minute: 2, hour: 12, day: 40, total: Infinity }],
        [inviteId, { minute: 2, hour: 6, day: 20, total: 60 }]]) {
        const entry = next[key] ||= { total: 0 };
        if (entry.total >= limits.total) throw new HttpError(429, "This invitation has reached its demo request allowance.");
        for (const [period, duration] of [["minute", 60_000], ["hour", 3600_000], ["day", 86400_000]]) {
          if (!entry[period] || entry[period].reset <= this.now()) entry[period] = { count: 0, reset: this.now() + duration };
          const caption = { minute: "per-minute", hour: "hourly", day: "daily" }[period];
          if (entry[period].count >= limits[period]) throw new HttpError(429, `Demo ${caption} request limit reached. Please try later.`);
          entry[period].count++;
        }
        entry.total++;
      }
      // Write before inference admission; disk failure must not remove the limits.
      await fs.writeFile(`${this.usagePath}.tmp`, JSON.stringify(next), { mode: 0o600 });
      await fs.rename(`${this.usagePath}.tmp`, this.usagePath);
      this.usage = next;
    });
    this.writes = task.catch(() => {});
    return task;
  }
}

module.exports = { DemoAccess, digest };
