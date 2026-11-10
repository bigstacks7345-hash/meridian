// Where runtime files go. Tests and the shadow replay must not touch the repo copies.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoPath } from "../repo-root.js";

let cachedTestDir = null;

export function runningAsTest() {
  return process.env.NODE_ENV === "test"
    || process.execArgv.includes("--test")
    || process.argv.includes("--test");
}

export function isolatedStateDir() {
  if (process.env.STATE_DIR) return path.resolve(process.env.STATE_DIR);
  if (!cachedTestDir) cachedTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-test-state-"));
  return cachedTestDir;
}

export function decisionsDir() {
  if (process.env.DECISIONS_DIR) return path.resolve(process.env.DECISIONS_DIR);
  if (process.env.STATE_DIR || runningAsTest()) return isolatedStateDir();
  return repoPath("state");
}

export function monitorStateFile() {
  if (process.env.STATE_DIR || runningAsTest()) return path.join(isolatedStateDir(), "wallet-monitor-state.json");
  return repoPath("wallet-monitor-state.json");
}
