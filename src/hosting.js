const { randomUUID, randomBytes, createHmac, timingSafeEqual } = require("node:crypto");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://cards.scryfall.io; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function checkOrigin(req, publicOrigin) {
  if (req.headers["sec-fetch-site"] === "cross-site") {
    throw new HttpError(403, "Cross-site requests are not allowed.");
  }
  const origin = req.headers.origin;
  if (!origin) return;
  let parsed;
  try { parsed = new URL(origin); } catch { throw new HttpError(403, "Invalid request origin."); }
  const matches = publicOrigin ? parsed.origin === publicOrigin : parsed.host === req.headers.host;
  if (!matches) throw new HttpError(403, "Request origin does not match this site.");
}

class VisitorSessions {
  constructor({ secret = randomBytes(32).toString("hex"), secure = false } = {}) {
    this.secret = secret;
    this.secure = secure;
  }

  signature(value) {
    return createHmac("sha256", this.secret).update(value).digest("hex");
  }

  get(req, res) {
    const cookie = String(req.headers.cookie || "").split(";")
      .map(part => part.trim()).find(part => part.startsWith("jankbot_visitor="));
    const token = cookie?.slice("jankbot_visitor=".length) || "";
    const [id, expiry, signature] = token.split(".");
    const expected = this.signature(`${id}.${expiry}`);
    if (/^[a-f0-9-]{36}$/.test(id || "") && Number(expiry) > Date.now()
        && /^[a-f0-9]{64}$/.test(signature || "")
        && timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return id;
    const newId = randomUUID();
    const expires = Date.now() + 86400_000;
    const value = `${newId}.${expires}`;
    res.setHeader("Set-Cookie", `jankbot_visitor=${value}.${this.signature(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${this.secure ? "; Secure" : ""}`);
    return newId;
  }
}

class RateLimiter {
  constructor({ maxKeys = 5000 } = {}) {
    this.entries = new Map();
    this.maxKeys = maxKeys;
  }

  check(key, { limit = 120, windowMs = 60_000, now = Date.now() } = {}) {
    for (const [existing, entry] of this.entries) {
      if (entry.reset <= now) this.entries.delete(existing);
    }
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxKeys) throw new HttpError(503, "Site is busy. Try again shortly.");
      entry = { count: 0, reset: now + windowMs };
      this.entries.set(key, entry);
    }
    if (++entry.count > limit) throw new HttpError(429, "Too many requests. Try again in a minute.");
  }
}

class ChatJobs {
  constructor({ maxPending = 8, maxRetained = 32, ttlMs = 15 * 60_000 } = {}) {
    this.maxPending = maxPending;
    this.maxRetained = maxRetained;
    this.ttlMs = ttlMs;
    this.jobs = new Map();
    this.queue = [];
    this.running = false;
  }

  prune() {
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && Date.now() - job.finishedAt > this.ttlMs) this.jobs.delete(id);
    }
    for (const [id, job] of this.jobs) {
      if (this.jobs.size < this.maxRetained) break;
      if (job.finishedAt) this.jobs.delete(id);
    }
  }

  assertAvailable(owner) {
    this.prune();
    if (Array.from(this.jobs.values()).some(job => job.owner === owner && !job.finishedAt)) {
      throw new HttpError(409, "You already have a request in progress.");
    }
    const pending = Array.from(this.jobs.values()).filter(job => !job.finishedAt).length;
    if (pending >= this.maxPending) throw new HttpError(503, "The chat queue is full. Try again shortly.");
  }

  submit(owner, run) {
    this.assertAvailable(owner);
    const job = { id: randomUUID(), owner, status: "queued", stage: "Waiting for the model", createdAt: Date.now() };
    this.jobs.set(job.id, job);
    this.queue.push({ job, run });
    void this.drain();
    return job.id;
  }

  get(id, owner) {
    this.prune();
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) throw new HttpError(404, "Request not found or expired.");
    const { owner: ignored, ...view } = job;
    view.position = job.status === "queued" ? this.queue.findIndex(entry => entry.job.id === id) + 1 : 0;
    return view;
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const { job, run } = this.queue.shift();
        job.status = "running";
        try {
          job.result = await run(stage => { job.stage = stage; });
          job.status = "complete";
          job.stage = "Complete";
        } catch (error) {
          job.status = "failed";
          job.error = { status: error.status || 503, message: error.status ? error.message
            : error.name === "OllamaError" ? "The AI request could not be completed. No result was saved. Try again shortly."
            : "A required service failed. The host can inspect its logs for details." };
          console.error(JSON.stringify({ event: "chat_failed", jobId: job.id, error: error.message }));
        } finally {
          job.finishedAt = Date.now();
        }
      }
    } finally {
      this.running = false;
    }
  }
}

module.exports = { HttpError, securityHeaders, checkOrigin, VisitorSessions, RateLimiter, ChatJobs };
