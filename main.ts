// SPDX-License-Identifier: MIT
// Hourly Sharpe rewards steady, low-variance equity growth rather than a few lottery wins.
// So this bot keeps exposure small and nearly constant (fixed size, hard position and exposure
// caps), banks gains early, cuts losers quickly, and diversifies across many independent mints
// with tiny probes. It also refuses orders that cannot clear fees, size caps or complete curves.

import { LAMPORTS_PER_SOL, runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, BuyInput, OrderInput, SellInput } from './vendor/makefun-bot.ts';

const SOL = Number(LAMPORTS_PER_SOL);
const ENTRY = 150_000_000n;
const PROBE = 10_000_000n;
const MAX_EXPOSURE = 900_000_000n;
const FEE_NUM = 9875n;
const MAX_MOMENTUM = 4;
const MAX_SLOTS = 5;
const TAPE_WINDOW = 35;
const ENTRY_WINDOW = 30;
const FAST_WINDOW = 15;

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

const tape = new Map<string, Tape>();
const peak = new Map<string, bigint>();
const entrySlot = new Map<string, number>();
const cooldownUntil = new Map<string, number>();
const entryCount = new Map<string, number>();
const probeMints = new Set<string>();
const sent = new Map<string, SentMeta>();
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
      const q = Number(e.virtual_quote_reserves);
      const v = Number(e.virtual_token_reserves);
      t.trades.push({
        slot: e.slot,
        buy: e.is_buy,
        sol: Number(e.sol_amount) / SOL,
        user: e.user,
        price: v > 0 ? q / v : 0,
      });
    }
  }
  for (const t of tape.values()) {
    let cut = 0;
    while (cut < t.trades.length && batch.slot - t.trades[cut].slot > TAPE_WINDOW) cut++;
    if (cut > 0) t.trades.splice(0, cut);
  }
}

function valueLamports(state: BotState, mint: string, tokens: bigint): bigint {
  const c = state.curves.get(mint);
  if (c === undefined) return 0n;
  const denom = c.virtual_token_reserves + tokens;
  if (denom <= 0n) return 0n;
  const gross = (tokens * c.virtual_quote_reserves) / denom;
  return (gross * FEE_NUM) / 10000n - state.txFeeLamports();
}

function processFills(state: BotState, batch: Batch): void {
  for (const f of batch.fills) {
    const own = !f.client_id.startsWith('_');
    if (own && f.status === 'filled') {
      ownFillCount += 1;
      ownMints.add(f.mint);
    }
    const meta = sent.get(f.client_id);
    if (meta !== undefined) {
      sent.delete(f.client_id);
      if (f.status !== 'filled') {
        if (meta.side === 'buy' && meta.kind === 'probe') probeMints.delete(f.mint);
        continue;
      }
      if (meta.side === 'buy') {
        entrySlot.set(f.mint, f.slot);
        entryCount.set(f.mint, (entryCount.get(f.mint) ?? 0) + 1);
        const h = state.positions.get(f.mint);
        if (h !== undefined) peak.set(f.mint, valueLamports(state, f.mint, h.token_amount));
      } else {
        cooldownUntil.set(f.mint, f.slot + 150);
        peak.delete(f.mint);
        entrySlot.delete(f.mint);
        if (meta.kind === 'probe') probeMints.delete(f.mint);
      }
    } else if (f.status === 'filled' && f.side === 'sell') {
      cooldownUntil.set(f.mint, f.slot + 150);
      peak.delete(f.mint);
      entrySlot.delete(f.mint);
      probeMints.delete(f.mint);
    }
  }
}

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

function entrySignal(state: BotState, mint: string, slot: number): boolean {
  const c = state.curves.get(mint);
  if (c === undefined || c.complete) return false;
  const real = Number(c.real_quote_reserves) / SOL;
  if (real < 2 || real > 60) return false;
  const t = tape.get(mint);
  if (t === undefined) return false;
  const created = t.created !== null ? t.created : c.created_slot;
  if (created === null || slot - created < 500) return false;
  const w = t.trades.filter((x) => slot - x.slot <= ENTRY_WINDOW);
  if (w.length < 3) return false;
  const buyers = new Map<string, number>();
  let buys = 0;
  let buySol = 0;
  let sellSol = 0;
  let first = 0;
  let last = 0;
  let high = 0;
  let newer = 0;
  let older = 0;
  for (let i = 0; i < w.length; i++) {
    const tr = w[i];
    if (tr.buy) {
      buys += 1;
      buySol += tr.sol;
      buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (i === 0) first = tr.price;
    last = tr.price;
    if (tr.price > high) high = tr.price;
    const flow = tr.buy ? tr.sol : -tr.sol;
    if (slot - tr.slot <= FAST_WINDOW) newer += flow;
    else older += flow;
  }
  if (buys < 3 || buyers.size < 5) return false;
  if (buySol - sellSol < 1) return false;
  if (first <= 0 || last <= 0) return false;
  const gain = last / first;
  if (gain < 1.05 || gain > 2.5) return false;
  if (last < 0.95 * high) return false;
  if (!(newer > 0 && newer >= older)) return false;
  let top = 0;
  for (const v of buyers.values()) if (v > top) top = v;
  if (top > 0.6 * buySol) return false;
  return true;
}

function currentPace(): number {
  if (firstBlockTime === null || lastBlockTime === null) return 0;
  const elapsed = lastBlockTime - firstBlockTime;
  if (elapsed <= 0) return 0;
  return Math.min(1, elapsed / 14400);
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
      sent.set(id, { mint, kind, side: 'buy' });
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
      sent.set(id, { mint, kind, side: 'sell' });
      orders.push(o);
      pendingMints.add(mint);
    }

    function momentumCount(): number {
      let n = 0;
      for (const m of reserved) if (!probeMints.has(m)) n += 1;
      return n;
    }

    for (const [mint, h] of state.positions) {
      if (orders.length >= cap) break;
      if (probeMints.has(mint) || pendingMints.has(mint)) continue;
      const c = state.curves.get(mint);
      if (c === undefined || c.complete) continue;
      const value = valueLamports(state, mint, h.token_amount);
      const prev = peak.get(mint);
      const high = prev === undefined || value > prev ? value : prev;
      peak.set(mint, high);
      const cost = h.cost_lamports;
      let exit = false;
      if (value >= (cost * 11n) / 10n) exit = true;
      if (value <= (cost * 9n) / 10n) exit = true;
      if (high >= (cost * 105n) / 100n && value <= (high * 92n) / 100n) exit = true;
      const t = tape.get(mint);
      if (t !== undefined) {
        let net = 0;
        let bigSell = 0;
        for (const tr of t.trades) {
          if (slot - tr.slot <= FAST_WINDOW) net += tr.buy ? tr.sol : -tr.sol;
          if (tr.slot === slot && !tr.buy) bigSell += tr.sol;
        }
        if (net < -1) exit = true;
        if (bigSell >= 3) exit = true;
      }
      const start = entrySlot.get(mint);
      if (start !== undefined && slot - start >= 1200) exit = true;
      if (exit) addSell(mint, h.token_amount, 'momentum');
    }

    for (const mint of probeMints) {
      if (orders.length >= cap) break;
      if (pendingMints.has(mint)) continue;
      const h = state.positions.get(mint);
      if (h === undefined) continue;
      const c = state.curves.get(mint);
      if (c !== undefined && c.complete) continue;
      addSell(mint, h.token_amount, 'probe');
    }

    for (const mint of tape.keys()) {
      if (orders.length >= cap) break;
      if (momentumCount() >= MAX_MOMENTUM) break;
      if (state.positions.has(mint) || pendingMints.has(mint) || probeMints.has(mint)) continue;
      const cd = cooldownUntil.get(mint);
      if (cd !== undefined && slot < cd) continue;
      if ((entryCount.get(mint) ?? 0) >= 2) continue;
      if (!entrySignal(state, mint, slot)) continue;
      if (state.maxBuyLamports(mint) < ENTRY) continue;
      if (exposure + ENTRY > MAX_EXPOSURE) continue;
      if (cash - tx < ENTRY) continue;
      addBuy(mint, ENTRY, 'momentum');
    }

    const pace = currentPace();
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
          if (reserved.size >= MAX_SLOTS) continue;
          if (state.maxBuyLamports(mint) < PROBE) continue;
          if (exposure + PROBE > MAX_EXPOSURE) continue;
          if (cash - tx < PROBE) continue;
          probeMints.add(mint);
          addBuy(mint, PROBE, 'probe');
          return true;
        }
        return false;
      };
      if (!tryProbe(true)) tryProbe(false);
    }

    return orders;
  },
});
