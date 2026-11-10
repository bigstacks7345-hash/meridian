import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../repo-root.js';

function run(args, { env = {}, timeout = 20_000 } = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.WALLET_PRIVATE_KEY;
  delete childEnv.JUPITER_API_KEY;
  delete childEnv.TELEGRAM_BOT_TOKEN;
  delete childEnv.TELEGRAM_CHAT_ID;
  delete childEnv.TELEGRAM_ALLOWED_USER_IDS;
  delete childEnv.RPC_URL;
  Object.assign(childEnv, env);
  const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, env: childEnv, encoding: 'utf8', timeout });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

test('this build cannot be armed and does not load a config private key', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'config.js'), 'utf8');
  assert.doesNotMatch(source, /WALLET_PRIVATE_KEY\s*\|\|=/);
  const isolated = path.join(os.tmpdir(), `meridian-user-config-${process.pid}.json`);
  fs.writeFileSync(isolated, JSON.stringify({ shadowMode: false, walletKey: "local-file-secret", dryRun: false }));
  try {
    const result = run(['--input-type=module', '-e', `
      delete process.env.DRY_RUN;
      delete process.env.WALLET_PRIVATE_KEY;
      const { config, transactionsAreDryRun } = await import('./config.js');
      if (config.standalone.shadow !== true) throw new Error('build must stay in shadow');
      if (process.env.DRY_RUN !== 'true') throw new Error('DRY_RUN was not forced');
      if (process.env.WALLET_PRIVATE_KEY) throw new Error('local walletKey was loaded');
      config.standalone.shadow = false;
      for (const value of ['false', '1', 'TRUE', 'yes', '', 'true']) {
        process.env.DRY_RUN = value;
        if (!transactionsAreDryRun()) throw new Error('submit gate opened for ' + JSON.stringify(value));
      }
      console.log('arming-ok');
    `], { env: { MERIDIAN_USER_CONFIG: isolated, DRY_RUN: 'false' } });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /arming-ok/);
  } finally {
    fs.rmSync(isolated, { force: true });
  }
});

test('dry-run close, claim, and swap do not sign, broadcast, or notify', () => {
  const result = run(['--input-type=module', '-e', `
    process.env.DRY_RUN = 'true';
    process.env.TELEGRAM_BOT_TOKEN = 'dummy-token';
    process.env.TELEGRAM_CHAT_ID = '1';
    const calls = [];
    globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('network blocked'); };
    const { executeTool } = await import('./tools/executor.js');
    const position = '11111111111111111111111111111111';
    const close = await executeTool('close_position', { position_address: position, reason: 'dry-run test' });
    const claim = await executeTool('claim_fees', { position_address: position });
    const swap = await executeTool('swap_token', { input_mint: 'SOL', output_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: 1 });
    for (const [name, value] of [['close', close], ['claim', claim], ['swap', swap]]) {
      if (!value?.dry_run) throw new Error(name + ' did not dry-run: ' + JSON.stringify(value));
    }
    if (calls.length) throw new Error('unexpected network: ' + calls.join(','));
    console.log('writes-blocked');
  `], { env: { TELEGRAM_BOT_TOKEN: 'dummy-token', TELEGRAM_CHAT_ID: '1', DRY_RUN: 'true' } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /writes-blocked/);
});

test('deploy cannot skip the convergence gate or reach a broadcast when screening is offline', () => {
  const result = run(['--input-type=module', '-e', `
    process.env.DRY_RUN = 'true';
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new Error('network blocked'); };
    const { executeTool } = await import('./tools/executor.js');
    const afterImport = calls;
    const noSignal = await executeTool('deploy_position', { pool_address: 'Pool111111111111111111111111111111111111111', amount_y: 0.5, bins_below: 69 });
    if (!noSignal?.blocked || !/wallet-convergence/.test(noSignal.reason || '')) throw new Error('gate failed: ' + JSON.stringify(noSignal));
    if (calls !== afterImport) throw new Error('deploy reached the network without a signal');
    const offline = await executeTool('deploy_position', {
      pool_address: 'Pool111111111111111111111111111111111111111',
      amount_y: 0.5,
      bins_below: 69,
      before_submit: async () => { throw new Error('before_submit must not run before screening'); },
    });
    if (!offline?.blocked || !/verify pool/.test(offline.reason || '')) throw new Error('offline screening failed open: ' + JSON.stringify(offline));
    if (calls < 1) throw new Error('expected the screening read to be attempted');
    console.log('deploy-blocked');
  `]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /deploy-blocked/);
});

test('CLI dry-run close and safety report stay local', () => {
  const close = run(['cli.js', 'close', '--position', '11111111111111111111111111111111', '--dry-run']);
  assert.equal(close.status, 0, close.stderr + close.stdout);
  assert.match(close.stdout, /"dry_run": true/);
  assert.doesNotMatch(close.stdout, /sendAndConfirm|signedTransaction/);

  const safety = run(['scripts/safety-status.js']);
  assert.equal(safety.status, 0, safety.stderr + safety.stdout);
  const report = JSON.parse(safety.stdout);
  assert.equal(report.shadowMode, true);
  assert.equal(report.dryRunBlocksSubmit, true);
  assert.equal(report.willSubmit, false);
  assert.equal(report.privateKeySet, false);
  assert.equal(report.telegramAdminArmed, false);
});

test('source has no baked-in Jupiter API key', () => {
  const wallet = fs.readFileSync(path.join(REPO_ROOT, 'tools/wallet.js'), 'utf8');
  assert.doesNotMatch(wallet, /DEFAULT_JUPITER_API_KEY/);
  assert.doesNotMatch(wallet, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});
