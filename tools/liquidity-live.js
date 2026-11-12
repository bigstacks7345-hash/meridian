// Production wiring for a live compound or reshape. Loaded only after the gate opens.

import { PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";

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
    },
    send: (tx) => sendAndConfirmTransaction(connection, tx, [owner], {
      commitment: "confirmed",
      skipPreflight: false,
      maxRetries: 3,
    }),
  };
}
