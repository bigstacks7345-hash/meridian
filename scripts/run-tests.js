// Run the suite with STATE_DIR and DECISIONS_DIR outside the repo, then fail if
// the repo's state/ directory or wallet-monitor-state.json changed.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT, repoPath } from "../repo-root.js";

const watched = [repoPath("state"), repoPath("wallet-monitor-state.json"), repoPath("wallet-monitor-state.json.tmp")];

function fingerprint(target) {
  if (!fs.existsSync(target)) return null;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    return fs.readdirSync(target).sort().map(name => `${name}:${fingerprint(path.join(target, name))}`).join("|");
  }
  return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

function snapshot() {
  return Object.fromEntries(watched.map(file => [path.relative(REPO_ROOT, file), fingerprint(file)]));
}

const before = snapshot();
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-npm-test-"));
const env = {
  ...process.env,
  NODE_ENV: "test",
  MERIDIAN_USER_CONFIG: "none",
  STATE_DIR: isolated,
  DECISIONS_DIR: isolated,
};
const steps = [
  [process.execPath, ["scripts/check-syntax.js"]],
  [process.execPath, ["test/test-standalone.js"]],
  [process.execPath, ["--test",
    "test/cleanup.test.js",
    "test/dry-run.test.js",
    "test/vpvr.test.js",
    "test/owner-strategy.test.js",
    "test/runtime-market.test.js",
    "test/runtime-signal.test.js",
    "test/fabriq.test.js",
    "test/decisions.test.js",
    "test/state-isolation.test.js",
    "test/entry-guards.test.js",
    "test/liquidity-sim.test.js",
    "test/volume-profile.test.js",
  ]],
];

let failed = false;
for (const [cmd, args] of steps) {
  const result = spawnSync(cmd, args, { cwd: REPO_ROOT, env, stdio: "inherit" });
  if (result.status !== 0) {
    failed = true;
    break;
  }
}

const after = snapshot();
const changed = watched
  .map(file => path.relative(REPO_ROOT, file))
  .filter(key => before[key] !== after[key]);
if (changed.length) {
  console.error(`npm test wrote repo state: ${changed.join(", ")}`);
  failed = true;
} else {
  console.log("repo state/ and wallet-monitor-state.json were not modified");
}
process.exit(failed ? 1 : 0);
