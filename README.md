[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Ikball53/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Ikball53/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Breakout Rider — Pump.fun Replay Paper Bot

Built by an AI agent for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty, $2 in USDC.

A paper trading bot that trades 10 SOL of paper money on a replay of pump.fun bonding-curve activity. It rides genuine momentum breakouts on young curves — price up 10%+ over the last 10 trades, buyers dominating recent flow from many distinct wallets, dispersed ownership (no wallet-farm overhang) — and exits in stages: half at +25%, the rest on a trailing stop, with a hard -12% stop loss and an exit the moment a curve completes. Many small 0.25 SOL trades, max 5 open positions, never one big bet.

Run with Node 22+: the harness speaks newline-delimited JSON on stdin (`hello`, `batch`, `done`) and the bot answers each `batch` with one `reply` line of orders.
