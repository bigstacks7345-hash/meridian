import test from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  JITO_MIN_TIP_LAMPORTS,
  JITO_TIP_ACCOUNTS,
  buildSignedBundle,
  chunkItems,
  compileItem,
  fallbackItems,
  landTransactions,
  landingSettings,
  percentileOf,
  pickTipLamports,
} from "../tools/lander.js";
import { assembleSwapInstructions, estimateCloseSwapAmount, jupiterSwapApiBase } from "../tools/bundle-swap.js";
import { landingConfig, transactionsAreDryRun } from "../config.js";

const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
const OPTS = { blockhash: BLOCKHASH, lastValidBlockHeight: 100 };
const FLOOR = {
  landed_tips_25th_percentile: 0.0000035,
  landed_tips_50th_percentile: 0.00001,
  landed_tips_75th_percentile: 0.00009,
  landed_tips_95th_percentile: 0.0002,
  landed_tips_99th_percentile: 0.002,
  ema_landed_tips_50th_percentile: 0.000012,
};

function transferItem(wallet, lamports = 1, extra = []) {
  const tx = new Transaction();
  tx.add(...extra, SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports }));
  return { tx, signers: [wallet] };
}

function decodeLegacy(raw) {
  return Transaction.from(raw);
}

test("tip tiers follow the floor percentile and clamp to caps", () => {
  const s = landingSettings();
  assert.equal(pickTipLamports(FLOOR, "routine", s), 3500);
  assert.equal(pickTipLamports(FLOOR, "entry", s), 10_000);
  assert.equal(pickTipLamports(FLOOR, "exit", s), 90_000);
  // caps
  assert.equal(pickTipLamports({ ...FLOOR, landed_tips_50th_percentile: 5 }, "entry", s), s.maxEntryTipLamports);
  assert.equal(pickTipLamports({ ...FLOOR, landed_tips_75th_percentile: 5 }, "exit", s), s.maxExitTipLamports);
  // floor
  assert.equal(pickTipLamports({ ...FLOOR, landed_tips_25th_percentile: 1e-9 }, "routine", s), JITO_MIN_TIP_LAMPORTS);
  // missing floor -> fallback tip
  assert.equal(pickTipLamports(null, "entry", s), s.fallbackTipLamports);
  // ema50
  assert.equal(pickTipLamports(FLOOR, "entry", landingSettings({ entryTipPercentile: "ema50" })), 12_000);
  assert.throws(() => pickTipLamports(FLOOR, "yolo", s), /unknown landing tier/);
  assert.throws(() => pickTipLamports(FLOOR, "entry", landingSettings({ entryTipPercentile: 42 })), /unsupported tip percentile/);
});

test("chunking, percentiles and fallback item selection", () => {
  assert.deepEqual(chunkItems([1, 2, 3, 4, 5, 6, 7]), [[1, 2, 3, 4, 5], [6, 7]]);
  assert.deepEqual(chunkItems([]), []);
  assert.equal(percentileOf([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentileOf([5, 1, 3, 2, 4], 100), 5);
  assert.equal(percentileOf([], 75), null);
  const a = { tx: 1 }, b = { tx: 2 }, swap = { v0: {}, optional: true };
  assert.deepEqual(fallbackItems([a, b, swap]), { required: [a, b], dropped: true });
  assert.deepEqual(fallbackItems([a]), { required: [a], dropped: false });
});

test("compileItem replaces the compute-unit price and keeps the limit", () => {
  const wallet = Keypair.generate();
  const item = transferItem(wallet, 1, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 7 }),
  ]);
  const compiled = compileItem(item, { ...OPTS, cuPriceMicroLamports: 50_000 });
  const tx = decodeLegacy(compiled.raw);
  const budget = tx.instructions.filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId));
  assert.equal(budget.length, 2);
  assert.deepEqual(budget.map((ix) => ix.data[0]).sort(), [2, 3]);
  const price = budget.find((ix) => ix.data[0] === 3);
  assert.equal(Number(price.data.readBigUInt64LE(1)), 50_000);
  assert.ok(tx.verifySignatures());
  assert.equal(compiled.signature.length > 80, true);

  const noPrice = decodeLegacy(compileItem(item, OPTS).raw);
  assert.equal(noPrice.instructions.filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId)).length, 1);
});

test("bundle tip goes on the last transaction, or its own when the last is full", () => {
  const wallet = Keypair.generate();
  const tipAccount = new PublicKey(JITO_TIP_ACCOUNTS[0]);
  const signed = buildSignedBundle([transferItem(wallet), transferItem(wallet)], { ...OPTS, tipLamports: 12_345, tipAccount });
  assert.equal(signed.length, 2);
  const first = decodeLegacy(signed[0].raw);
  const last = decodeLegacy(signed[1].raw);
  const isTip = (ix) => ix.programId.equals(SystemProgram.programId) && ix.keys[1].pubkey.equals(tipAccount);
  assert.equal(first.instructions.some(isTip), false);
  assert.equal(last.instructions.filter(isTip).length, 1);
  assert.equal(Number(last.instructions.find(isTip).data.readBigUInt64LE(4)), 12_345);

  // A v0 swap item near the size limit: adding the tip overflows, so a separate tip tx is used.
  // Pad one instruction's data until the transaction is exactly at the size limit.
  const transfer = SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  const pad = (n) => ({ programId: SystemProgram.programId, keys: [], data: Buffer.alloc(n) });
  const fitsWith = (n) => {
    try {
      compileItem({ v0: { instructions: [transfer, pad(n)] }, signers: [wallet] }, OPTS);
      return true;
    } catch {
      return false;
    }
  };
  let n = 0;
  while (fitsWith(n + 1)) n += 1;
  const fits = [transfer, pad(n)];
  const swapItem = { v0: { instructions: fits }, signers: [wallet], optional: true };
  const withSeparateTip = buildSignedBundle([transferItem(wallet), swapItem], { ...OPTS, tipLamports: 5000, tipAccount });
  assert.equal(withSeparateTip.length, 3);
  const tipTx = decodeLegacy(withSeparateTip[2].raw);
  assert.equal(tipTx.instructions.filter(isTip).length, 1);
  const swapTx = VersionedTransaction.deserialize(withSeparateTip[1].raw);
  assert.ok(swapTx.message.staticAccountKeys.every((key) => !key.equals(tipAccount)));

  const five = Array.from({ length: 5 }, () => transferItem(wallet));
  assert.throws(() => buildSignedBundle([...five, transferItem(wallet)], { ...OPTS, tipLamports: 5000, tipAccount }), /Jito allows 5/);
});

test("shadow build: landTransactions returns dry_run without any network call", async () => {
  assert.equal(transactionsAreDryRun(), true);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("network not allowed"); };
  const connection = new Proxy({}, { get() { calls += 1; throw new Error("connection not allowed"); } });
  try {
    const wallet = Keypair.generate();
    const result = await landTransactions({ label: "close", tier: "exit", connection, items: [transferItem(wallet)] });
    assert.deepEqual(result, { dry_run: true, would_land: { label: "close", tier: "exit", transactions: 1 } });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("close swap amount is position X plus X fees, minus the buffer", () => {
  const positionData = { totalXAmountExcludeTransferFee: new BN("1000000"), feeXExcludeTransferFee: new BN("20000") };
  assert.equal(estimateCloseSwapAmount(positionData, 100), "1009800");
  assert.equal(estimateCloseSwapAmount({ totalXAmountExcludeTransferFee: new BN("1000000") }, 0), "1000000");
  assert.equal(estimateCloseSwapAmount({ totalXAmountExcludeTransferFee: new BN("0") }, 100), null);
  assert.equal(estimateCloseSwapAmount(null, 100), null);
});

test("Jupiter swap instructions are ordered behind our compute-unit limit", () => {
  const program = Keypair.generate().publicKey.toBase58();
  const account = Keypair.generate().publicKey.toBase58();
  const raw = (byte) => ({ programId: program, accounts: [{ pubkey: account, isSigner: false, isWritable: true }], data: Buffer.from([byte]).toString("base64") });
  const ixs = assembleSwapInstructions({
    computeBudgetInstructions: [raw(9)],
    setupInstructions: [raw(1)],
    swapInstruction: raw(2),
    cleanupInstruction: raw(3),
  }, 400_000);
  assert.equal(ixs.length, 4);
  assert.ok(ixs[0].programId.equals(ComputeBudgetProgram.programId));
  assert.deepEqual(ixs.slice(1).map((ix) => ix.data[0]), [1, 2, 3]);
  assert.throws(() => assembleSwapInstructions({ error: "no route" }, 1), /no route/);
  assert.equal(jupiterSwapApiBase(""), "https://lite-api.jup.ag/swap/v1");
  assert.equal(jupiterSwapApiBase("k"), "https://api.jup.ag/swap/v1");
});

test("landing config parsing keeps only valid values", () => {
  const saved = process.env.JITO_BLOCK_ENGINE_URL;
  delete process.env.JITO_BLOCK_ENGINE_URL;
  try {
    assert.deepEqual(landingConfig({
      mode: "jito",
      rpcFallback: false,
      swapInBundle: "yes",
      maxExitTipLamports: "500000",
      attempts: -1,
      exitTipPercentile: "ema50",
      blockEngineUrl: "http://insecure.example",
    }), { mode: "jito", rpcFallback: false, maxExitTipLamports: 500000, exitTipPercentile: "ema50" });
    assert.deepEqual(landingConfig({ mode: "bogus", blockEngineUrl: "https://ny.mainnet.block-engine.jito.wtf" }),
      { blockEngineUrl: "https://ny.mainnet.block-engine.jito.wtf" });
    process.env.JITO_BLOCK_ENGINE_URL = "https://tokyo.mainnet.block-engine.jito.wtf";
    assert.equal(landingConfig({}).blockEngineUrl, "https://tokyo.mainnet.block-engine.jito.wtf");
  } finally {
    if (saved === undefined) delete process.env.JITO_BLOCK_ENGINE_URL;
    else process.env.JITO_BLOCK_ENGINE_URL = saved;
  }
});
