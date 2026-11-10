import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, repoPath } from "../repo-root.js";
import { decisionDirectory, decisionFile, recordScreening } from "../standalone/decisions.js";
import { decisionsDir, monitorStateFile } from "../standalone/paths.js";
import { MonitorStore } from "../standalone/store.js";
import { OWNER_STRATEGY } from "../strategy/defaults.js";

function outsideRepo(file) {
  const resolved = path.resolve(file);
  const root = path.resolve(REPO_ROOT);
  return resolved !== root && !resolved.startsWith(root + path.sep);
}

test("screening logs and the default monitor file stay outside the repo during tests", () => {
  const repoState = path.resolve(repoPath("state"));
  const before = fs.existsSync(repoState) ? fs.readdirSync(repoState).sort() : null;
  const monitorBefore = fs.existsSync(repoPath("wallet-monitor-state.json"))
    ? fs.readFileSync(repoPath("wallet-monitor-state.json"))
    : null;

  assert.equal(outsideRepo(decisionsDir()), true);
  assert.equal(outsideRepo(decisionDirectory()), true);
  assert.equal(outsideRepo(monitorStateFile()), true);
  assert.notEqual(path.resolve(monitorStateFile()), path.resolve(repoPath("wallet-monitor-state.json")));

  const now = Date.parse("2026-11-10T06:00:00.000Z");
  const record = recordScreening({
    now,
    signal: { mint: "MintIso111111111111111111111111111111111", source: "wallets", events: [] },
    snapshot: null,
    book: [],
    rules: OWNER_STRATEGY,
    reason: "isolated",
  });
  const written = decisionFile(now);
  assert.equal(fs.existsSync(written), true);
  assert.equal(outsideRepo(written), true);
  assert.equal(record.mint, "MintIso111111111111111111111111111111111");

  const store = new MonitorStore();
  store.data.signals.MintIso = { done: false, createdAt: now, deadline: null };
  store.save();
  assert.equal(outsideRepo(store.file), true);
  assert.equal(fs.existsSync(store.file), true);

  const after = fs.existsSync(repoState) ? fs.readdirSync(repoState).sort() : null;
  assert.deepEqual(after, before);
  const monitorAfter = fs.existsSync(repoPath("wallet-monitor-state.json"))
    ? fs.readFileSync(repoPath("wallet-monitor-state.json"))
    : null;
  assert.deepEqual(monitorAfter, monitorBefore);
});
