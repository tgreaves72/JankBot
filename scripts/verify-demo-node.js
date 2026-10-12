const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
assert.ok(process.permission, "Node permission mode must be enabled.");
for (const name of ["OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "JANKBOT_PRIVATE_PROBE", "NODE_OPTIONS"]) {
  assert.equal(process.env[name], undefined, "Unrelated host environment must not reach the demo.");
}
assert.equal(process.permission.has("fs.write", process.env.DEMO_CONFIG), false);
assert.throws(() => fs.readFileSync("C:/Windows/win.ini"), { code: "ERR_ACCESS_DENIED" });
assert.throws(() => spawnSync(process.execPath, ["-v"]), { code: "ERR_ACCESS_DENIED" });
let ledger = "{}";
try { ledger = fs.readFileSync(process.env.DEMO_USAGE_PATH, "utf8"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
JSON.parse(ledger);
fs.writeFileSync(`${process.env.DEMO_USAGE_PATH}.tmp`, ledger);
fs.renameSync(`${process.env.DEMO_USAGE_PATH}.tmp`, process.env.DEMO_USAGE_PATH);
console.log("PASS: external file reads and subprocesses denied; config read-only; atomic quota ledger updates permitted.");
