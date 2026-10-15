const fs = require("node:fs");
const path = require("node:path");

function validateProfile(profile) {
  if (!profile || Object.keys(profile).sort().join(",") !== "digest,model,think"
      || typeof profile.model !== "string" || !/^[a-z0-9][a-z0-9.-]*:[a-zA-Z0-9_.-]+$/.test(profile.model)
      || typeof profile.digest !== "string" || !/^[a-f0-9]{64}$/.test(profile.digest)
      || (profile.think !== null && profile.think !== false)) {
    throw new Error("Invalid pinned model profile. No alternate model is configured.");
  }
  return Object.freeze({ model: profile.model, expectedDigest: profile.digest,
    ...(profile.think === null ? {} : { think: profile.think }) });
}

function loadProfile() {
  const profile = validateProfile(JSON.parse(fs.readFileSync(path.join(__dirname, "../model-profile.json"), "utf8")));
  if (process.env.OLLAMA_MODEL && process.env.OLLAMA_MODEL !== profile.model) {
    throw new Error("OLLAMA_MODEL disagrees with the pinned model profile.");
  }
  return profile;
}

module.exports = { validateProfile, loadProfile };
