const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { digest } = require("../src/demo-access");

function renderDemoLink(origin, token) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("A valid HTTPS origin and demo token are required.");
  const href = `${url.origin}/#demo=${token}`;
  return { href, html: `<a href="${href}" target="_blank" rel="noopener noreferrer">JankBot</a>`, markdown: `[JankBot](${href})` };
}

async function issueLink(config, privateDir, label, origin, rotate) {
  if (typeof label !== "string" || !/^[A-Za-z0-9 ._-]{1,60}$/.test(label)) throw new Error("Use a plain invitation label of 1 to 60 characters.");
  const tokensPath = path.join(privateDir, "demo-links.json");
  let tokens = {};
  try { tokens = JSON.parse(await fs.readFile(tokensPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) throw new Error("Invalid private link registry.");
  let invite = config.invites.find(item => item.label === label);
  if (invite && invite.kind !== "link") throw new Error("This label belongs to a code invitation. Choose another label.");
  if (invite && !rotate && (!invite.enabled || Date.parse(invite.expiresAt) <= Date.now())) throw new Error("This link is revoked or expired. Rotate it explicitly to issue a new link.");
  if (!invite || rotate) {
    if (!invite) {
      if (config.invites.length >= 64) throw new Error("Maximum invitation count reached.");
      invite = { id: randomBytes(12).toString("hex"), label, kind: "link" };
      config.invites.push(invite);
    }
    const token = randomBytes(32).toString("base64url");
    invite.codeHash = digest(token);
    invite.enabled = true;
    invite.expiresAt = new Date(Date.now() + 90 * 86400_000).toISOString();
    tokens[invite.id] = token;
  }
  const token = tokens[invite.id];
  if (typeof token !== "string" || digest(token) !== invite.codeHash) throw new Error("Private link credential is missing or mismatched. Rotate the link explicitly; quotas will remain intact.");
  const link = renderDemoLink(origin, token);
  await fs.mkdir(privateDir, { recursive: true });
  await fs.writeFile(`${tokensPath}.tmp`, JSON.stringify(tokens), { mode: 0o600 });
  await fs.rename(`${tokensPath}.tmp`, tokensPath);
  await fs.writeFile(path.join(privateDir, "jankbot-link.txt"), `JankBot one-click demo\n\nURL for your resume hyperlink:\n${link.href}\n\nWebsite HTML:\n${link.html}\n\nMarkdown:\n${link.markdown}\n\nInvitation: ${label}\nExpires: ${invite.expiresAt}\nAll visitors share this invitation's request allowance. Anyone who obtains this link can use the limited demo.\n`, { mode: 0o600 });
  await fs.writeFile(path.join(privateDir, "jankbot-link.html"), `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>JankBot demo link</title></head><body><h1>JankBot</h1><p>${link.html}</p><p>One-click employer demo. This link grants limited access to anyone who receives it.</p></body></html>\n`, { mode: 0o600 });
}

async function main() {
  const [operation, root, privateDir, label, origin] = process.argv.slice(2);
  if (!["create", "add", "revoke", "link", "rotate-link"].includes(operation) || !root || !privateDir) throw new Error("Use: manage-demo.js create|add|revoke|link|rotate-link deployment-directory private-directory [invitation-label] [HTTPS-origin]");
  const configPath = path.join(root, "config", "demo-access.json");
  let config;
  try { config = JSON.parse(await fs.readFile(configPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT" || operation !== "create") throw error; }
  if (config && operation === "create") return;
  if (["link", "rotate-link"].includes(operation)) {
    if (!config) throw new Error("Provision employer access before issuing a link.");
    await issueLink(config, privateDir, label, origin, operation === "rotate-link");
  } else if (operation === "revoke") {
    const invite = config.invites.find(item => item.label === label);
    if (!invite) throw new Error("Invitation not found.");
    invite.enabled = false;
  } else {
    let hostToken;
    if (!config) {
      hostToken = randomBytes(32).toString("hex");
      config = { version: 1, hostProbeHash: digest(hostToken), invites: [] };
    }
    const labels = operation === "create" ? ["Employer 1", "Employer 2", "Employer 3"] : [label];
    const issued = [];
    for (const name of labels) {
      if (typeof name !== "string" || !/^[A-Za-z0-9 ._-]{1,60}$/.test(name) || config.invites.some(item => item.label === name)) throw new Error("Use a unique invitation label of 1 to 60 plain characters.");
      if (config.invites.length >= 64) throw new Error("Maximum invitation count reached.");
      const code = randomBytes(32).toString("base64url");
      const invite = { id: randomBytes(12).toString("hex"), label: name, codeHash: digest(code), enabled: true, expiresAt: new Date(Date.now() + 90 * 86400_000).toISOString() };
      config.invites.push(invite);
      issued.push(`${name}\nAccess code: ${code}\nExpires: ${invite.expiresAt}\n`);
    }
    await fs.mkdir(privateDir, { recursive: true });
    if (hostToken) await fs.writeFile(path.join(privateDir, "host-control.json"), JSON.stringify({ token: hostToken }), { mode: 0o600, flag: "wx" });
    await fs.appendFile(path.join(privateDir, "employer-access.txt"), `${issued.join("\n")}\n`, { mode: 0o600 });
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(`${configPath}.tmp`, JSON.stringify(config, null, 2), { mode: 0o600 });
  await fs.rename(`${configPath}.tmp`, configPath);
  console.log("Employer access configuration updated. One-click links remain in the private jankbot-link.txt file; no credentials are printed.");
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { renderDemoLink };
