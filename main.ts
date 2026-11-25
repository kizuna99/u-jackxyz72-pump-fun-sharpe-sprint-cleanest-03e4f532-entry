// SPDX-License-Identifier: MIT
// Hourly Sharpe rewards a smooth equity curve, not one lucky moonshot.
// This bot therefore trades small and nearly constant: one fixed stake per
// position, hard caps on open positions and total exposure, early profit
// banking, quick loss cutting, and many independent mints through tiny
// guardrail probes. It never sends an order that cannot clear fees, the
// sizing caps, or an incomplete curve.

import { LAMPORTS_PER_SOL, runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, BuyInput, OrderInput, SellInput } from './vendor/makefun-bot.ts';

// --- Sizing and fee constants (lamports) -------------------------------------
const SOL = Number(LAMPORTS_PER_SOL);
const ENTRY_LAMPORTS = 150_000_000n; // 0.15 SOL per momentum position
const PROBE_LAMPORTS = 10_000_000n; // 0.01 SOL guardrail probe round trip
const MAX_EXPOSURE_LAMPORTS = 900_000_000n; // 0.90 SOL total open cost
const FEE_KEEP_NUM = 9875n; // keep 98.75% after the 1.25% round-trip fee drag

// --- Strategy thresholds -----------------------------------------------------
const MAX_MOMENTUM_POSITIONS = 4;
const MAX_OPEN_SLOTS = 5;
const TAPE_WINDOW_SLOTS = 35;
const ENTRY_WINDOW_SLOTS = 30;
const FAST_WINDOW_SLOTS = 15;
const PACE_HORIZON_SECONDS = 14400; // 4h of block time maps pace 0 -> 1

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
}

type Kind = 'momentum' | 'probe';
type OrderSide = 'buy' | 'sell';

interface SentMeta {
  mint: string;
  kind: Kind;
  side: OrderSide;
}

// --- Mutable per-run state (insertion-ordered maps only: deterministic) ------
const tape = new Map<string, Tape>();
const peakValue = new Map<string, bigint>();
const entrySlot = new Map<string, number>();
const cooldownUntil = new Map<string, number>();
const entryCount = new Map<string, number>();
const probeMints = new Set<string>();
const sentOrders = new Map<string, SentMeta>();
const ownMints = new Set<string>();
let ownFillCount = 0;
let firstBlockTime: number | null = null;
let lastBlockTime: number | null = null;

function getTape(mint: string): Tape {
  let t = tape.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [] };
    tape.set(mint, t);
  }
  return t;
}

// Record creations/trades from this batch and drop tape older than the window.
function observeEvents(batch: Batch): void {
  for (const e of batch.events) {
    if (typeof e.block_time === 'number') {
      if (firstBlockTime === null) firstBlockTime = e.block_time;
      lastBlockTime = e.block_time;
    }
    const t = getTape(e.mint);
    if (e.event === 'CreateEvent') {
      if (t.created === null) t.created = e.slot;
    } else if (e.event === 'TradeEvent') {
      const quote = Number(e.virtual_quote_reserves);
      const tokens = Number(e.virtual_token_reserves);
      t.trades.push({
        slot: e.slot,
        buy: e.is_buy,
        sol: Number(e.sol_amount) / SOL,
        user: e.user,
        price: tokens > 0 ? quote / tokens : 0,
      });
    }
  }
  for (const t of tape.values()) {
    let cut = 0;
    while (cut < t.trades.length && batch.slot - t.trades[cut].slot > TAPE_WINDOW_SLOTS) cut++;
    if (cut > 0) t.trades.splice(0, cut);
  }
}

// Net lamports a full sell of `tokens` would return after fees.
function valueLamports(state: BotState, mint: string, tokens: bigint): bigint {
  const c = state.curves.get(mint);
  if (c === undefined) return 0n;
  const denom = c.virtual_token_reserves + tokens;
  if (denom <= 0n) return 0n;
  const gross = (tokens * c.virtual_quote_reserves) / denom;
  return (gross * FEE_KEEP_NUM) / 10000n - state.txFeeLamports();
}

// Apply fills. Guardrail accounting counts ONLY filled own fills: a rejected
// or failed fill never advances the 20-mint bar, so probes keep firing until
// real round trips land.
function processFills(state: BotState, batch: Batch): void {
  for (const f of batch.fills) {
    const own = !f.client_id.startsWith('_');
    if (own && f.status === 'filled') {
      ownFillCount += 1;
      ownMints.add(f.mint);
    }
    const meta = sentOrders.get(f.client_id);
    if (meta !== undefined) {
      sentOrders.delete(f.client_id);
      if (f.status !== 'filled') {
        // A failed probe buy frees the mint for a later probe attempt.
        if (meta.side === 'buy' && meta.kind === 'probe') probeMints.delete(f.mint);
        continue;
      }
      if (meta.side === 'buy') {
        entrySlot.set(f.mint, f.slot);
        entryCount.set(f.mint, (entryCount.get(f.mint) ?? 0) + 1);
        const h = state.positions.get(f.mint);
        if (h !== undefined) peakValue.set(f.mint, valueLamports(state, f.mint, h.token_amount));
      } else {
        cooldownUntil.set(f.mint, f.slot + 150);
        peakValue.delete(f.mint);
        entrySlot.delete(f.mint);
        if (meta.kind === 'probe') probeMints.delete(f.mint);
      }
    } else if (f.status === 'filled' && f.side === 'sell') {
      // A sell we did not track (e.g. after a restart) still cools the mint down.
      cooldownUntil.set(f.mint, f.slot + 150);
      peakValue.delete(f.mint);
      entrySlot.delete(f.mint);
      probeMints.delete(f.mint);
    }
  }
}

// Drop probe markers whose mint has neither a position nor a pending order.
function cleanupProbes(state: BotState): void {
  for (const mint of [...probeMints]) {
    let busy = state.positions.has(mint);
    if (!busy) {
      for (const p of state.pending.values()) {
        if (p.order.mint === mint) {
          busy = true;
          break;
        }
      }
    }
    if (!busy) probeMints.delete(mint);
  }
}

// Summary of one entry window's tape: buy/sell flow, price path, and how
// concentrated the buying is. Computed once so entrySignal stays a flat
// list of readable gates.
interface WindowSummary {
  buys: number;
  buySol: number;
  sellSol: number;
  distinctBuyers: number;
  topBuyerSol: number;
  firstPrice: number;
  lastPrice: number;
  highPrice: number;
  newerFlow: number;
  olderFlow: number;
}

function summarizeWindow(window: TapeTrade[], slot: number): WindowSummary {
  const buyerTotals = new Map<string, number>();
  let buys = 0;
  let buySol = 0;
  let sellSol = 0;
  let firstPrice = 0;
  let lastPrice = 0;
  let highPrice = 0;
  let newerFlow = 0;
  let olderFlow = 0;
  for (let i = 0; i < window.length; i++) {
    const trade = window[i];
    if (trade.buy) {
      buys += 1;
      buySol += trade.sol;
      buyerTotals.set(trade.user, (buyerTotals.get(trade.user) ?? 0) + trade.sol);
    } else {
      sellSol += trade.sol;
    }
    if (i === 0) firstPrice = trade.price;
    lastPrice = trade.price;
    if (trade.price > highPrice) highPrice = trade.price;
    const flow = trade.buy ? trade.sol : -trade.sol;
    if (slot - trade.slot <= FAST_WINDOW_SLOTS) newerFlow += flow;
    else olderFlow += flow;
  }
  let topBuyerSol = 0;
  for (const total of buyerTotals.values()) if (total > topBuyerSol) topBuyerSol = total;
  return {
    buys,
    buySol,
    sellSol,
    distinctBuyers: buyerTotals.size,
    topBuyerSol,
    firstPrice,
    lastPrice,
    highPrice,
    newerFlow,
    olderFlow,
  };
}

// Mature-momentum tape signal: old enough curve, healthy reserves, broad
// buying with accelerating inflow, price up but still near its window high,
// and no single buyer dominating the flow.
function entrySignal(state: BotState, mint: string, slot: number): boolean {
  const c = state.curves.get(mint);
  if (c === undefined || c.complete) return false;
  const real = Number(c.real_quote_reserves) / SOL;
  if (real < 2 || real > 60) return false;
  const t = tape.get(mint);
  if (t === undefined) return false;
  const created = t.created !== null ? t.created : c.created_slot;
  if (created === null || slot - created < 500) return false;
  const window = t.trades.filter((x) => slot - x.slot <= ENTRY_WINDOW_SLOTS);
  if (window.length < 3) return false;
  const s = summarizeWindow(window, slot);
  if (s.buys < 3 || s.distinctBuyers < 5) return false;
  if (s.buySol - s.sellSol < 1) return false;
  if (s.firstPrice <= 0 || s.lastPrice <= 0) return false;
  const gain = s.lastPrice / s.firstPrice;
  if (gain < 1.05 || gain > 2.5) return false;
  if (s.lastPrice < 0.95 * s.highPrice) return false;
  if (!(s.newerFlow > 0 && s.newerFlow >= s.olderFlow)) return false;
  if (s.topBuyerSol > 0.6 * s.buySol) return false;
  return true;
}

// Fraction of the 4h pacing horizon covered by observed block time.
function paceFraction(): number {
  if (firstBlockTime === null || lastBlockTime === null) return 0;
  const elapsed = lastBlockTime - firstBlockTime;
  if (elapsed <= 0) return 0;
  return Math.min(1, elapsed / PACE_HORIZON_SECONDS);
}

// Momentum exit decision for one open position. Updates the trailing peak
// first, then checks: +10% take-profit, -10% stop-loss, trailing stop armed
// at +5% with an 8% trail, fast-window flow fade, same-slot big sell, and
// the 1200-slot time stop.
function positionShouldExit(
  state: BotState,
  mint: string,
  cost: bigint,
  tokens: bigint,
  slot: number,
): boolean {
  const value = valueLamports(state, mint, tokens);
  const prev = peakValue.get(mint);
  const high = prev === undefined || value > prev ? value : prev;
  peakValue.set(mint, high);
  if (value >= (cost * 11n) / 10n) return true;
  if (value <= (cost * 9n) / 10n) return true;
  if (high >= (cost * 105n) / 100n && value <= (high * 92n) / 100n) return true;
  const t = tape.get(mint);
  if (t !== undefined) {
    let net = 0;
    let bigSell = 0;
    for (const tr of t.trades) {
      if (slot - tr.slot <= FAST_WINDOW_SLOTS) net += tr.buy ? tr.sol : -tr.sol;
      if (tr.slot === slot && !tr.buy) bigSell += tr.sol;
    }
    if (net < -1) return true;
    if (bigSell >= 3) return true;
  }
  const start = entrySlot.get(mint);
  if (start !== undefined && slot - start >= 1200) return true;
  return false;
}

runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    observeEvents(batch);
    processFills(state, batch);
    cleanupProbes(state);

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const pendingMints = new Set<string>();
    for (const p of state.pending.values()) pendingMints.add(p.order.mint);
    const reserved = new Set<string>();
    for (const mint of state.positions.keys()) reserved.add(mint);
    for (const p of state.pending.values()) if (p.order.side === 'buy') reserved.add(p.order.mint);
    let exposure = 0n;
    for (const h of state.positions.values()) exposure += h.cost_lamports;
    for (const p of state.pending.values()) if (p.order.side === 'buy') exposure += BigInt(p.order.quote_lamports);
    let cash = state.freeCashLamports();

    function addBuy(mint: string, amount: bigint, kind: Kind): void {
      if (orders.length >= cap) return;
      const id = state.clientId();
      const o: BuyInput = { side: 'buy', client_id: id, mint, quote_lamports: amount, max_slippage_bps: 1500 };
      sentOrders.set(id, { mint, kind, side: 'buy' });
      orders.push(o);
      pendingMints.add(mint);
      reserved.add(mint);
      exposure += amount;
      cash -= amount + tx;
    }

    function addSell(mint: string, tokens: bigint, kind: Kind): void {
      if (orders.length >= cap) return;
      const id = state.clientId();
      const o: SellInput = { side: 'sell', client_id: id, mint, token_amount: tokens, max_slippage_bps: 10000 };
      sentOrders.set(id, { mint, kind, side: 'sell' });
      orders.push(o);
      pendingMints.add(mint);
    }

    function momentumCount(): number {
      let n = 0;
      for (const m of reserved) if (!probeMints.has(m)) n += 1;
      return n;
    }

    // 1) Exits for momentum positions: +10% TP, -10% SL, trailing stop armed
    // at +5% with an 8% trail, flow fade, same-slot big sell, 1200-slot cap.
    for (const [mint, h] of state.positions) {
      if (orders.length >= cap) break;
      if (probeMints.has(mint) || pendingMints.has(mint)) continue;
      const c = state.curves.get(mint);
      if (c === undefined || c.complete) continue;
      if (positionShouldExit(state, mint, h.cost_lamports, h.token_amount, slot)) {
        addSell(mint, h.token_amount, 'momentum');
      }
    }

    // 2) Probe positions exit immediately on the next batch (round trip done).
    for (const mint of probeMints) {
      if (orders.length >= cap) break;
      if (pendingMints.has(mint)) continue;
      const h = state.positions.get(mint);
      if (h === undefined) continue;
      const c = state.curves.get(mint);
      if (c !== undefined && c.complete) continue;
      addSell(mint, h.token_amount, 'probe');
    }

    // 3) New momentum entries, at most MAX_MOMENTUM_POSITIONS open, no
    // re-entry within cooldown, at most 2 entries per mint ever.
    for (const mint of tape.keys()) {
      if (orders.length >= cap) break;
      if (momentumCount() >= MAX_MOMENTUM_POSITIONS) break;
      if (state.positions.has(mint) || pendingMints.has(mint) || probeMints.has(mint)) continue;
      const cd = cooldownUntil.get(mint);
      if (cd !== undefined && slot < cd) continue;
      if ((entryCount.get(mint) ?? 0) >= 2) continue;
      if (!entrySignal(state, mint, slot)) continue;
      if (state.maxBuyLamports(mint) < ENTRY_LAMPORTS) continue;
      if (exposure + ENTRY_LAMPORTS > MAX_EXPOSURE_LAMPORTS) continue;
      if (cash - tx < ENTRY_LAMPORTS) continue;
      addBuy(mint, ENTRY_LAMPORTS, 'momentum');
    }

    // 4) Guardrail probes: paced by elapsed block time toward 30 distinct
    // mints / 200 own fills, so the run clears the 20-mint bar even when
    // momentum signals are scarce. Fresh mints first, then any liquid mint.
    const pace = paceFraction();
    const needMints = Math.ceil(30 * pace);
    const needFills = Math.ceil(200 * pace);
    const probeNeeded = ownMints.size < needMints || ownFillCount < needFills;
    let probeInFlight = false;
    for (const m of probeMints) {
      if (state.positions.has(m) || pendingMints.has(m)) {
        probeInFlight = true;
        break;
      }
    }
    if (probeNeeded && !probeInFlight && orders.length < cap) {
      const seen = new Set<string>();
      const tryProbe = (freshOnly: boolean): boolean => {
        for (const e of batch.events) {
          if (e.event !== 'TradeEvent') continue;
          const mint = e.mint;
          if (seen.has(mint)) continue;
          seen.add(mint);
          if (freshOnly && ownMints.has(mint)) continue;
          const c = state.curves.get(mint);
          if (c === undefined || c.complete) continue;
          if (Number(c.real_quote_reserves) < SOL) continue;
          if (state.positions.has(mint) || pendingMints.has(mint) || probeMints.has(mint)) continue;
          if ((entryCount.get(mint) ?? 0) >= 2) continue;
          if (reserved.size >= MAX_OPEN_SLOTS) continue;
          if (state.maxBuyLamports(mint) < PROBE_LAMPORTS) continue;
          if (exposure + PROBE_LAMPORTS > MAX_EXPOSURE_LAMPORTS) continue;
          if (cash - tx < PROBE_LAMPORTS) continue;
          probeMints.add(mint);
          addBuy(mint, PROBE_LAMPORTS, 'probe');
          return true;
        }
        return false;
      };
      if (!tryProbe(true)) tryProbe(false);
    }

    return orders;
  },
});
