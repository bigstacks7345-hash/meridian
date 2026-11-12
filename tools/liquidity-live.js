// Production wiring for a live compound or reshape. Loaded only after the gate opens.

import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";

export async function createLiquidityIo(poolAddress) {
  const { assertBinArraysReady, liquidityClients, liquiditySdk, openDlmmPool } = await import("./dlmm.js");
  const { connection, owner } = liquidityClients();
  const { StrategyType } = await liquiditySdk();
  const pool = await openDlmmPool(poolAddress);
  const user = owner.publicKey;
  return {
    connection,
    owner: user,
    signers: [owner],
    strategyTypes: StrategyType,
    signatures: [],
    assertBinArrays: (minBinId, maxBinId) => assertBinArraysReady(pool, minBinId, maxBinId),
    pool: {
      getActiveBin: () => pool.getActiveBin(),
      getPosition: (position) => pool.getPosition(new PublicKey(position)),
      removeLiquidity: (args) => pool.removeLiquidity({
        ...args,
        user,
        position: new PublicKey(args.position),
        shouldClaimAndClose: false,
      }),
      claimSwapFee: (args) => pool.claimSwapFee({ owner: user, position: args.position }),
      claimFee: (args) => (pool.claimFee || pool.claimSwapFee).call(pool, { owner: user, position: args.position }),
      addLiquidityByStrategy: (args) => pool.addLiquidityByStrategy({ ...args, user }),
      addLiquidityByStrategyChunkable: pool.addLiquidityByStrategyChunkable
        ? (args) => pool.addLiquidityByStrategyChunkable({ ...args, user })
        : undefined,
      rebalanceLiquidity: (args) => removeOnlyRebalance(pool, user, args),
      addLiquidity2: (args) => addLiquidityByWeight(pool, user, args),
    },
    send: (tx) => sendAndConfirmTransaction(connection, tx, [owner], {
      commitment: "confirmed",
      skipPreflight: false,
      maxRetries: 3,
    }),
  };
}

async function removeOnlyRebalance(pool, user, args) {
  const position = new PublicKey(args.position);
  const loaded = await pool.getPosition(position);
  const methods = pool.program.methods;
  const original = methods.rebalanceLiquidity.bind(methods);
  methods.rebalanceLiquidity = (params, info) => original({ ...params, shrinkMode: 3, adds: [] }, info);
  try {
    const simulated = await pool.simulateRebalancePosition(
      position,
      loaded.positionData,
      false,
      false,
      [],
      [{ minBinId: new BN(args.fromBinId), maxBinId: new BN(args.toBinId), bps: new BN(args.bps ?? 10_000) }],
    );
    const built = await pool.rebalancePosition(simulated, new BN(32_767), user, 0);
    return { name: "rebalanceLiquidity", instructions: built.rebalancePositionInstruction, shrinkMode: 3 };
  } finally {
    methods.rebalanceLiquidity = original;
  }
}

async function addLiquidityByWeight(pool, user, args) {
  const binIds = (args.binLiquidityDist || []).map(row => row.binId);
  const minBinId = Math.min(...binIds);
  const maxBinId = Math.max(...binIds);
  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const { getBinArrayAccountMetasCoverage, deriveBinArrayBitmapExtension, isOverflowDefaultBinArrayBitmap, binIdToBinArrayIndex } = await import("@meteora-ag/dlmm");
  const userTokenX = getAssociatedTokenAddressSync(pool.tokenX.publicKey, user, false, pool.tokenX.owner);
  const userTokenY = getAssociatedTokenAddressSync(pool.tokenY.publicKey, user, false, pool.tokenY.owner);
  const minIndex = binIdToBinArrayIndex(new BN(minBinId));
  const maxIndex = binIdToBinArrayIndex(new BN(maxBinId));
  const useExtension = isOverflowDefaultBinArrayBitmap(minIndex) || isOverflowDefaultBinArrayBitmap(maxIndex);
  const bitmap = useExtension ? deriveBinArrayBitmapExtension(pool.pubkey, pool.program.programId)[0] : null;
  const metas = getBinArrayAccountMetasCoverage(new BN(minBinId), new BN(maxBinId), pool.pubkey, pool.program.programId);
  const instruction = await pool.program.methods.addLiquidity2(
    {
      amountX: args.amountX,
      amountY: args.amountY,
      binLiquidityDist: args.binLiquidityDist,
    },
    { slices: [] },
  ).accountsPartial({
    position: new PublicKey(args.position),
    lbPair: pool.pubkey,
    binArrayBitmapExtension: bitmap,
    userTokenX,
    userTokenY,
    reserveX: pool.lbPair.reserveX,
    reserveY: pool.lbPair.reserveY,
    tokenXMint: pool.tokenX.publicKey,
    tokenYMint: pool.tokenY.publicKey,
    sender: user,
    tokenXProgram: pool.tokenX.owner,
    tokenYProgram: pool.tokenY.owner,
  }).remainingAccounts(metas).instruction();
  const tx = new Transaction().add(instruction);
  tx.name = "addLiquidity2";
  return tx;
}
