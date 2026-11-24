// Breakout Rider — pump.fun replay paper bot (agent-fun/replay/v2).
//
// Strategy, in plain words: buy the exhaustion dip, not the chase. On a
// bonding curve most breakouts are exit liquidity, so this bot waits for
// the early-holder overhang to sell off (price >= 12% below its recent
// high), then enters only once price bounces off its low with fresh,
// dispersed buy flow. It gets out in stages with a tight stop. Many
// small trades, never one big bet, never hold through the whole window.
//
// Protocol: the harness sends newline-delimited JSON on stdin — a hello
// message, then one batch per slot window, then done. The bot answers
// every batch with exactly one reply line carrying its orders for that
// batch. No network, no randomness, no clock: every decision is a pure
// function of the events seen so far, so two runs agree byte for byte.
//
// Prices come from the bonding curve itself: price = virtual SOL reserves
// / virtual token reserves, read off each TradeEvent and each mark.
//
// Entry (all must hold) — exhaustion dip, not chase:
//   - at least 20 trades seen on the mint, price down >= 12% from its
//     20-trade high (the early-holder overhang has sold off) and then
//     bounced >= 4% off its 10-trade low (selling is exhausted, buyers
//     are stepping back in);
//   - buyers dominate the last 5 trades (>= 60% of their SOL volume is
//     buys) from >= 6 distinct buyers in the last 20 trades (not one
//     wallet pumping), with >= 0.2 SOL of flow in the window and no
//     single trade over 60% of the buy volume (no wash-trade fakeout);
//   - dispersed ownership from the event's shareholders list: the biggest
//     holder owns <= 20% and the top 3 together own <= 40% (skips
//     wallet-farm / overhang coins where that data is present);
//   - curve progress between 8% and 92% (late enough to have momentum,
//     early enough to still have room before completion);
//   - mint not completed, not traded by us before, and a free position
//     slot (max 5 open).
//   - buy size 0.25 SOL, capped at 0.9% of real SOL reserves (harness cap
//     is 1%) and floored at 0.01 SOL (the guardrail's round-trip minimum).
//
// Exits (staged, per position):
//   - stop loss: sell everything at -10% from entry;
//   - take profit 1: sell half at +25% on the recovery leg;
//   - take profit 2 / trailing stop: once the peak is +15% or more, sell
//     everything if price falls 10% off its peak;
//   - completion: sell everything the moment a CompleteEvent lands;
//   - stale: sell everything if 250 more trades pass with no gain.
// Fees are ~1.25% per side plus a flat tx fee, so the +25% first target
// clears fees several times over while the -12% stop bounds every loser.

const BUY_LAMPORTS = 250_000_000; // 0.25 SOL per entry
const MIN_BUY_LAMPORTS = 10_000_000; // 0.01 SOL guardrail floor
const MAX_OPEN_POSITIONS = 5;
const MAX_ORDER_FRACTION_OF_REAL = 0.009; // stay under the 1% cap
const MAX_SLIPPAGE_BPS = 500;
const MIN_TRADES_TO_ENTER = 20;
const LOOKBACK_TRADES = 10;
const DIP_FROM_PEAK = 0.88; // price must be >= 12% below its 20-trade high
const RECOVERY_GAIN = 1.06; // ...and >= 6% above its 10-trade low: a real bounce, not noise
const BREAKOUT_GAIN = 1.08; // kept for ranking entry candidates by momentum
const MIN_BUY_SHARE = 0.6; // buys must dominate recent SOL volume
const MIN_RECENT_VOLUME_LAMPORTS = 200_000_000; // >= 0.2 SOL of flow in the window
const MIN_DISTINCT_BUYERS = 6;
const MAX_SINGLE_BUY_SHARE = 0.6; // one trade may not be >60% of recent buy volume
const MAX_TOP_HOLDER_BPS = 2000; // biggest holder <= 20%
const MAX_TOP3_HOLDER_BPS = 4000; // top 3 holders together <= 40%
const MIN_CURVE_PROGRESS = 0.2;
const MAX_CURVE_PROGRESS = 0.92;
const STOP_LOSS = 0.9; // -10% from entry: cut losers fast
const TAKE_PROFIT_1 = 1.25; // sell half at +25%: let recovery legs run
const TRAIL_ARM = 1.15; // trailing stop arms once peak is +15%
const TRAIL_DROP = 0.9; // sell all on a 10% fall from the peak
const STALE_TRADES = 250; // exit a flat position after this many trades
const MAX_DRAWDOWN_TO_ENTER = 0.35; // stop opening new trades past this
const CASH_RESERVE_LAMPORTS = 2_000_000_000; // keep 2 SOL powder dry

interface CoinState {
  mint: string;
  prices: number[];
  buySol: number[];
  sellSol: number[];
  buyers: string[];
  trades: number;
  lastPrice: number;
  topHolderBps: number;
  top3HolderBps: number;
  hasHolderData: boolean;
  progress: number;
  completed: boolean;
  realSol: number;
}

interface PositionState {
  mint: string;
  entryPrice: number;
  peakPrice: number;
  stage: number; // 0 = full size, 1 = half sold at TP1
  tradesAtEntry: number;
  tokens: number;
}

const coins = new Map<string, CoinState>();
const positions = new Map<string, PositionState>();
const tradedMints = new Set<string>();
let orderCounter = 0;
let cashLamports = 10_000_000_000;
let peakEquityLamports = 10_000_000_000;
let batchCount = 0;

function coinFor(mint: string): CoinState {
  let coin = coins.get(mint);
  if (coin === undefined) {
    coin = {
      mint,
      prices: [],
      buySol: [],
      sellSol: [],
      buyers: [],
      trades: 0,
      lastPrice: 0,
      topHolderBps: 0,
      top3HolderBps: 0,
      hasHolderData: false,
      progress: 0,
      completed: false,
      realSol: 0,
    };
    coins.set(mint, coin);
  }
  return coin;
}

function curvePrice(virtualSol: string, virtualTokens: string): number {
  const sol = Number(virtualSol);
  const tok = Number(virtualTokens);
  if (tok <= 0) return 0;
  return sol / tok;
}

function curveProgress(virtualSolLamports: number): number {
  // Virtual SOL starts at 30 SOL and the curve completes near 115 SOL.
  const start = 30_000_000_000;
  const span = 85_000_000_000;
  const p = (virtualSolLamports - start) / span;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

function recordTrade(coin: CoinState, price: number, isBuy: boolean, solAmount: number, user: string): void {
  if (price > 0) {
    coin.prices.push(price);
    if (coin.prices.length > 40) coin.prices.shift();
    coin.lastPrice = price;
  }
  if (isBuy) {
    coin.buySol.push(solAmount);
    coin.sellSol.push(0);
    coin.buyers.push(user);
  } else {
    coin.buySol.push(0);
    coin.sellSol.push(solAmount);
    coin.buyers.push("");
  }
  if (coin.buySol.length > 40) {
    coin.buySol.shift();
    coin.sellSol.shift();
    coin.buyers.shift();
  }
  coin.trades += 1;
}

function recentBuyShare(coin: CoinState): number {
  const n = Math.min(LOOKBACK_TRADES, coin.buySol.length);
  let buy = 0;
  let total = 0;
  for (let i = coin.buySol.length - n; i < coin.buySol.length; i++) {
    buy += coin.buySol[i];
    total += coin.buySol[i] + coin.sellSol[i];
  }
  if (total <= 0) return 0;
  return buy / total;
}

function recentDistinctBuyers(coin: CoinState): number {
  const n = Math.min(20, coin.buyers.length);
  const seen = new Set<string>();
  for (let i = coin.buyers.length - n; i < coin.buyers.length; i++) {
    const user = coin.buyers[i];
    if (user !== "") seen.add(user);
  }
  return seen.size;
}

function recentVolumeLamports(coin: CoinState): number {
  const n = Math.min(LOOKBACK_TRADES, coin.buySol.length);
  let total = 0;
  for (let i = coin.buySol.length - n; i < coin.buySol.length; i++) {
    total += coin.buySol[i] + coin.sellSol[i];
  }
  return total;
}

function largestSingleBuyShare(coin: CoinState): number {
  const n = Math.min(LOOKBACK_TRADES, coin.buySol.length);
  let biggest = 0;
  let total = 0;
  for (let i = coin.buySol.length - n; i < coin.buySol.length; i++) {
    if (coin.buySol[i] > biggest) biggest = coin.buySol[i];
    total += coin.buySol[i];
  }
  if (total <= 0) return 1;
  return biggest / total;
}

function peakPriceOver(coin: CoinState, n: number): number {
  const count = Math.min(n, coin.prices.length);
  let peak = 0;
  for (let i = coin.prices.length - count; i < coin.prices.length; i++) {
    if (coin.prices[i] > peak) peak = coin.prices[i];
  }
  return peak;
}

function lowPriceOver(coin: CoinState, n: number): number {
  const count = Math.min(n, coin.prices.length);
  let low = Number.POSITIVE_INFINITY;
  for (let i = coin.prices.length - count; i < coin.prices.length; i++) {
    if (coin.prices[i] < low) low = coin.prices[i];
  }
  return low === Number.POSITIVE_INFINITY ? 0 : low;
}

function recentBuyShareWindow(coin: CoinState, n: number): number {
  const count = Math.min(n, coin.buySol.length);
  let buy = 0;
  let total = 0;
  for (let i = coin.buySol.length - count; i < coin.buySol.length; i++) {
    buy += coin.buySol[i];
    total += coin.buySol[i] + coin.sellSol[i];
  }
  if (total <= 0) return 0;
  return buy / total;
}

function recoveryGain(coin: CoinState): number {
  const low10 = lowPriceOver(coin, 10);
  if (low10 <= 0 || coin.lastPrice <= 0) return 0;
  return coin.lastPrice / low10;
}

function breakoutGain(coin: CoinState): number {
  const n = Math.min(LOOKBACK_TRADES, coin.prices.length);
  if (n < LOOKBACK_TRADES) return 0;
  const oldPrice = coin.prices[coin.prices.length - n];
  const now = coin.prices[coin.prices.length - 1];
  if (oldPrice <= 0) return 0;
  return now / oldPrice;
}

function holderFilterPasses(coin: CoinState): boolean {
  if (!coin.hasHolderData) return true;
  if (coin.topHolderBps > MAX_TOP_HOLDER_BPS) return false;
  if (coin.top3HolderBps > MAX_TOP3_HOLDER_BPS) return false;
  return true;
}

function shouldEnter(coin: CoinState): boolean {
  if (coin.completed) return false;
  if (coin.trades < MIN_TRADES_TO_ENTER) return false;
  if (coin.lastPrice <= 0) return false;
  if (coin.progress < MIN_CURVE_PROGRESS) return false;
  if (coin.progress > MAX_CURVE_PROGRESS) return false;
  // Overhang exhaustion: deep dip from the recent high, then a bounce
  // off the low with fresh buy flow — the sellers are spent.
  const peak20 = peakPriceOver(coin, 20);
  const low10 = lowPriceOver(coin, 10);
  if (peak20 <= 0 || low10 <= 0) return false;
  if (coin.lastPrice > peak20 * DIP_FROM_PEAK) return false;
  if (coin.lastPrice < low10 * RECOVERY_GAIN) return false;
  if (recentBuyShareWindow(coin, 5) < MIN_BUY_SHARE) return false;
  if (recentVolumeLamports(coin) < MIN_RECENT_VOLUME_LAMPORTS) return false;
  if (largestSingleBuyShare(coin) > MAX_SINGLE_BUY_SHARE) return false;
  if (recentDistinctBuyers(coin) < MIN_DISTINCT_BUYERS) return false;
  if (!holderFilterPasses(coin)) return false;
  if (tradedMints.has(coin.mint)) return false;
  if (positions.has(coin.mint)) return false;
  return true;
}

function buySizeLamports(coin: CoinState): number {
  let size = BUY_LAMPORTS;
  if (coin.realSol > 0) {
    const cap = Math.floor(coin.realSol * MAX_ORDER_FRACTION_OF_REAL);
    if (cap < size) size = cap;
  }
  if (size < MIN_BUY_LAMPORTS) return 0;
  if (size > cashLamports - CASH_RESERVE_LAMPORTS) {
    size = cashLamports - CASH_RESERVE_LAMPORTS;
  }
  if (size < MIN_BUY_LAMPORTS) return 0;
  return size;
}

function handleBatch(batch: any): any[] {
  batchCount += 1;
  const orders: any[] = [];

  // 1. Absorb the events of this batch into per-coin state.
  const events: any[] = Array.isArray(batch.events) ? batch.events : [];
  for (const event of events) {
    if (event.event === "TradeEvent") {
      const coin = coinFor(event.mint);
      const price = curvePrice(event.virtual_sol_reserves, event.virtual_token_reserves);
      recordTrade(coin, price, event.is_buy === true, Number(event.sol_amount) || 0, String(event.user || ""));
      coin.progress = curveProgress(Number(event.virtual_sol_reserves) || 0);
      coin.realSol = Number(event.real_sol_reserves) || 0;
      const holders: any[] = Array.isArray(event.shareholders) ? event.shareholders : [];
      if (holders.length > 0) {
        const shares = holders.map((h: any) => Number(h.share_bps) || 0).sort((a: number, b: number) => b - a);
        coin.topHolderBps = shares[0] || 0;
        coin.top3HolderBps = shares.slice(0, 3).reduce((a: number, b: number) => a + b, 0);
        coin.hasHolderData = true;
      }
    } else if (event.event === "CreateEvent") {
      const coin = coinFor(event.mint);
      const price = curvePrice(event.virtual_sol_reserves, event.virtual_token_reserves);
      if (price > 0) coin.lastPrice = price;
      coin.progress = curveProgress(Number(event.virtual_sol_reserves) || 0);
    } else if (event.event === "CompleteEvent") {
      const coin = coinFor(event.mint);
      coin.completed = true;
    }
  }

  // 2. Refresh prices from the marks (the harness's own latest curve state).
  const marks: any[] = Array.isArray(batch.marks) ? batch.marks : [];
  for (const mark of marks) {
    const coin = coins.get(mark.mint);
    if (coin === undefined) continue;
    const price = curvePrice(mark.virtual_quote_reserves, mark.virtual_token_reserves);
    if (price > 0) coin.lastPrice = price;
  }

  // 3. Sync our books with the harness account: cash and open positions.
  const account = batch.account || {};
  cashLamports = Number(account.cash_lamports) || cashLamports;
  const accountPositions: any[] = Array.isArray(account.positions) ? account.positions : [];
  const liveMints = new Set<string>();
  for (const pos of accountPositions) {
    const mint = String(pos.mint);
    liveMints.add(mint);
    const tokens = Number(pos.token_amount) || 0;
    const cost = Number(pos.cost_lamports) || 0;
    const entryPrice = tokens > 0 ? cost / tokens : 0;
    const existing = positions.get(mint);
    if (existing === undefined) {
      const coin = coins.get(mint);
      positions.set(mint, {
        mint,
        entryPrice,
        peakPrice: entryPrice,
        stage: 0,
        tradesAtEntry: coin ? coin.trades : 0,
        tokens,
      });
    } else {
      existing.tokens = tokens;
      if (entryPrice > 0 && existing.entryPrice <= 0) existing.entryPrice = entryPrice;
    }
  }
  for (const mint of Array.from(positions.keys())) {
    if (!liveMints.has(mint)) positions.delete(mint);
  }

  // 4. Apply our own fills: a filled buy sets the true entry price and
  //    marks the mint traded; a filled sell updates the token balance.
  const fills: any[] = Array.isArray(batch.fills) ? batch.fills : [];
  for (const fill of fills) {
    if (fill.status !== "filled") continue;
    const mint = String(fill.mint);
    const quote = Number(fill.quote_lamports) || 0;
    const tokens = Number(fill.token_amount) || 0;
    if (fill.side === "buy" && tokens > 0 && quote > 0) {
      tradedMints.add(mint);
      const pos = positions.get(mint);
      if (pos !== undefined) {
        pos.entryPrice = quote / tokens;
        pos.peakPrice = pos.entryPrice;
        pos.tokens = tokens;
      }
    }
  }

  // 5. Equity guard: stop opening new trades deep in drawdown, keep exits.
  let equity = cashLamports;
  for (const pos of positions.values()) {
    const coin = coins.get(pos.mint);
    const price = coin && coin.lastPrice > 0 ? coin.lastPrice : pos.entryPrice;
    equity += pos.tokens * price;
  }
  if (equity > peakEquityLamports) peakEquityLamports = equity;
  const drawdown = peakEquityLamports > 0 ? 1 - equity / peakEquityLamports : 0;
  const mayEnter = drawdown < MAX_DRAWDOWN_TO_ENTER;

  // 6. Exits first: stops, staged profits, trailing stop, completion, stale.
  for (const pos of Array.from(positions.values())) {
    const coin = coins.get(pos.mint);
    if (coin === undefined || coin.lastPrice <= 0 || pos.entryPrice <= 0) continue;
    if (pos.tokens <= 0) continue;
    const price = coin.lastPrice;
    if (price > pos.peakPrice) pos.peakPrice = price;
    const gain = price / pos.entryPrice;
    const peakGain = pos.peakPrice / pos.entryPrice;
    let sellTokens = 0;
    if (coin.completed) {
      sellTokens = pos.tokens;
    } else if (gain <= STOP_LOSS) {
      sellTokens = pos.tokens;
    } else if (pos.stage === 0 && gain >= TAKE_PROFIT_1) {
      sellTokens = Math.floor(pos.tokens / 2);
      pos.stage = 1;
    } else if (peakGain >= TRAIL_ARM && gain <= (pos.peakPrice * TRAIL_DROP) / pos.entryPrice) {
      sellTokens = pos.tokens;
    } else if (coin.trades - pos.tradesAtEntry > STALE_TRADES && gain < 1.05) {
      sellTokens = pos.tokens;
    }
    if (sellTokens > 0) {
      orderCounter += 1;
      orders.push({
        side: "sell",
        client_id: "s" + String(orderCounter),
        mint: pos.mint,
        token_amount: String(sellTokens),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      if (sellTokens >= pos.tokens) {
        pos.tokens = 0;
      } else {
        pos.tokens -= sellTokens;
      }
    }
  }

  // 7. Entries: scan the coins touched by this batch, strongest first.
  if (mayEnter && orders.length < 16) {
    const openSlots = MAX_OPEN_POSITIONS - positions.size;
    if (openSlots > 0) {
      const candidates: CoinState[] = [];
      for (const event of events) {
        if (event.event !== "TradeEvent") continue;
        const coin = coins.get(event.mint);
        if (coin !== undefined && shouldEnter(coin) && candidates.indexOf(coin) === -1) {
          candidates.push(coin);
        }
      }
      candidates.sort((a: CoinState, b: CoinState) => recoveryGain(b) - recoveryGain(a));
      for (const coin of candidates) {
        if (orders.length >= 16) break;
        if (positions.size >= MAX_OPEN_POSITIONS) break;
        if (positions.has(coin.mint)) continue;
        const size = buySizeLamports(coin);
        if (size <= 0) continue;
        orderCounter += 1;
        orders.push({
          side: "buy",
          client_id: "b" + String(orderCounter),
          mint: coin.mint,
          quote_lamports: String(size),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        // Reserve the slot immediately so one batch cannot overfill.
        positions.set(coin.mint, {
          mint: coin.mint,
          entryPrice: coin.lastPrice,
          peakPrice: coin.lastPrice,
          stage: 0,
          tradesAtEntry: coin.trades,
          tokens: 0,
        });
        tradedMints.add(coin.mint);
        cashLamports -= size;
      }
    }
  }

  return orders.slice(0, 16);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) handleLine(line);
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  const line = buffer.trim();
  if (line.length > 0) handleLine(line);
});

function handleLine(line: string): void {
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "hello") {
    if (message.capital && message.capital.lamports) {
      cashLamports = Number(message.capital.lamports) || cashLamports;
      peakEquityLamports = cashLamports;
    }
    return;
  }
  if (message.type === "batch") {
    const orders = handleBatch(message);
    const reply = { type: "reply", seq: message.seq, orders };
    process.stdout.write(JSON.stringify(reply) + "\n");
    return;
  }
  if (message.type === "done") {
    process.exit(0);
  }
}
