# Meridian engineering guide

The app is the standalone wallet-triggered bot. There is no legacy mode or LLM decision path. The previous implementation is preserved on the local `legacy` branch at `fd835b7` (and earlier commits).

## Entry points and modules

- `index.js`: daemon startup; exports a deterministic management pass.
- `cli.js`: explicit read commands and manual close/claim/swap; `start` launches the daemon. `screen --mint` is read-only.
- `setup.js`: standalone configuration wizard; enables shadow mode.
- `standalone/runtime.js`: signal pursuit, screening deadlines, entry execution, deterministic management, fast exit polling, heartbeat, process lock.
- `standalone/fabriq.js`: public Fabriq HOT preview. A fresh alert is its own signal and uses the same entry filters. It is not a watched wallet.
- `standalone/gmgn-trending.js`: GMGN trending watch (`/v1/market/rank`), ported from the PC `lp_alert.ps1`. A hit opens its own signal like Fabriq and uses the same entry filters.
- `standalone/monitor.js`: subscriptions, transaction queue, baseline, signature backfill.
- `standalone/events.js`: DLMM event-CPI decoding and position/exposure checks. SDK is loaded lazily.
- `standalone/store.js`: persisted deduplication, convergence windows, cooldowns, and recovery attempts.
- `standalone/screening.js`: focused mint/pool screening using Solana, Meteora, and Jupiter.
- `standalone/balances.js`, `standalone/rpc.js`: standard RPC balances, cached prices, read fallback.
- `standalone/transactions.js`: in-process priority queue for wallet writes; exits precede queued entries.
- `tools/executor.js`: deploy/close/claim/swap dispatch, transaction preflight checks, notifications, post-close swaps.
- `tools/dlmm.js`: local Meteora SDK transactions and Meteora position/PnL reads. Preserve lazy SDK loading, position cache invalidation, and pool-rent checks.
- `tools/lander.js`: lands wallet writes as Jito bundles (tip from the live tip floor, per-tier caps) with RPC priority-fee fallback. No network at import.
- `tools/bundle-swap.js`: builds the zap-out Jupiter Swap v1 instructions that ride in the close bundle.
- `tools/pnl.js`: optional on-chain PnL engine and Meteora cost-basis reads.
- `tools/wallet.js`: balances and direct Jupiter swaps.
- `exit-rules.js`, `state.js`: deterministic rules and position tracking.
- `performance.js`: local performance accounting and pool cooldown updates. Uses the existing `lessons.json` schema, preserving historical data.
- `pool-memory.js`, `token-blacklist.js`, `dev-blocklist.js`: local history and safety filters.
- `smart-wallets.js`: local LP watchlist CRUD.
- `telegram.js`: outbound notifications only. `startAdmin` does not poll or register commands, so it cannot arm trading, import a key, or display a key.

## Invariants

- A GMGN trending hit (5m volume >= $150k, market cap >= $750k, bundled < 50%, polled every 60s, needs `GMGN_API_KEY`) opens its own signal on the same path as Fabriq: no deadline, every entry filter, shared external pursuit cap, ends after `staleAfterSec` off the list. A 429 pauses it and the kline client through the shared GMGN gate.
- Wallet entries require fresh convergence of the watched wallets. Do not reintroduce broad scans or expose a bypass through the CLI.
- A Fabriq HOT alert opens its own signal with no screening deadline. It still has to pass every entry filter. Wallet pursuits take priority when `maxActiveSignals` is full. A Fabriq pursuit ends when no newer alert arrives within `staleAfterSec` (default 1800). The first poll after startup is separate: it ignores posts older than `pollSec * 3` (60 seconds at the default), not `staleAfterSec`.
- `crashGuard` rejects a quote price more than 60% below the highest 1m high of the last 30 minutes. `poolDepth` rejects when that pool's own 5m volume divided by its liquidity is above 15, and it fails closed when the pool volume is missing. Both apply to wallet and Fabriq entries. The previous-5m volume floor is $30k. Holders are optional unless `holdersRequired` is true. Indicator history accepts 30 one-minute bars, then 5m candles, and fails closed only when there are no candles. A young coin still needs its launch minute for the full-life POC. GMGN token info is cached for 30 minutes and klines for 60 seconds. A Fabriq mint is not rescreened for 10 minutes. A GMGN 429 or credit-window miss is queued until reset.
- `autoCompound` and `reshapeLiquidity` only simulate on open shadow positions. `execute` stays false and neither path builds or submits a transaction. Compound bands follow the percent the quote price sits below the upper edge, and `requireFeesExceedCostX` defaults to 0. A curve compound can profit-take the new SOL bins after 4 bins up, once, without repeating a regular reshape. The default reshape moves one side: token bins on a dump after 5 bins, and the SOL bins just traversed on a pump after 20 bins.
- This build forces shadow mode and `DRY_RUN=true`. `transactionsAreDryRun()` stays true. Do not load `walletKey` into `WALLET_PRIVATE_KEY`.
- All wallet writes in `tools/dlmm.js` go through `tools/lander.js`. The dry-run returns come first, so shadow never reaches it; `landTransactions` also returns `dry_run` itself. A close lands claim + remove + close and (when `landing.swapInBundle`) the token-to-SOL swap as one bundle; the swap is optional and is dropped on RPC fallback, where the executor's post-close swap sells the token instead.
- Missing data must not be interpreted as empty positions or spendable funds.
- Keep entry screening independent of exit polling. Serialize wallet mutations through the existing queue.
- Preserve `before_submit` and `on_prepared` hooks and persisted attempt recovery.
- Read fresh positions and funds before deployment. Preserve position limits, duplicate guards, range floors, and bin-array initialization checks.
- The `minBinsBelow` floor is 35. Only token-X / SOL-token-Y pools are supported for execution.
- Never import the old agent, prompt, HiveMind, or server adapters into the active graph.
- Do not edit user secrets, runtime state, or the local archive branch as part of routine refactors.

## Configuration and state

`config.js` loads `user-config.json` once. The example file documents supported settings. Restart after changes. Secrets belong in environment variables or `.env`; never commit them. Keep existing ignored JSON state and logs intact.

Each screening attempt appends one JSON object to `state/decisions-YYYY-MM-DD.jsonl` (`proposal` when a shadow position is recorded, `pass` when the entry filters passed but the position was not opened, `skip` otherwise). Exits append a second object linked by `decisionId`. Files rotate by UTC day and records older than 90 days are removed. The directory is gitignored and must not contain secrets.

## Checks

Run `npm test` after changes. It sets `NODE_ENV=test` and points `STATE_DIR` and `DECISIONS_DIR` at a temporary directory, then fails if `state/` or `wallet-monitor-state.json` in the repo changed. `scripts/shadow-replay.js` also refuses the repo `state/` directory. `test/test-standalone.js` covers convergence, event parsing, screening, balances, priority ordering, and exits. `test/cleanup.test.js` checks module resolution, no-network imports, CLI surface, and mocked Meteora position mapping. Do not start the live daemon or send transactions to validate a refactor.
