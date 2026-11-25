<!-- SPDX-License-Identifier: MIT -->
# Pump.fun Sharpe Sprint — Cleanest Paper Bot

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/kizuna99/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/kizuna99/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the 6-hour pump.fun replay, built for **hourly Sharpe ratio**, not raw PnL: steady, low-variance gains beat one lucky moonshot.

## Strategy

- **Entry (mature momentum tape):** a curve must be at least 500 slots old, hold 2–60 SOL of real reserves, and over the last 30 slots show at least 3 buys from at least 5 distinct buyers, at least 1 SOL of net inflow, a price up 5–150% sitting at ≥95% of its window high, accelerating inflow (newer half ≥ older half), and no single buyer above 60% of buy volume.
- **Sharpe-first sizing:** fixed 0.15 SOL per position, **no pyramiding**, at most 4 momentum positions, and a hard 0.90 SOL cap on total open cost exposure against 10 SOL capital — drawdown stays structurally far below the 50% guardrail. No martingale, no all-in.
- **Fast, symmetric exits:** take-profit at +10%, stop-loss at −10%, a trailing stop (armed at +5%, 8% trail), flow-fade and big-sell exits, and a 1,200-slot time stop. Many small, similar-sized outcomes across many independent mints keep the hourly equity curve smooth.
- **Guardrail probes:** 0.01 SOL round trips on liquid curves, paced by elapsed block time, keep the run above 20 distinct traded mints (target 30) even when momentum signals are scarce.
- **Deterministic:** no clock, no randomness, no environment or network access; iteration only over insertion-ordered maps fed by the batch stream, so the two grader executions agree byte for byte.

## Layout

- `main.ts` — the strategy (Node 22, erasable-syntax TypeScript, run as `node main.ts`).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` SDK shim, vendored byte for byte.

## License

MIT — see `LICENSE`.
