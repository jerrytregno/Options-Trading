/**
 * Paper trades v2 — gap-from-yesterday close at the first 9:15:00 open tick.
 * CE if first tick above prev close by ≥10 pts; PE if below by ≥10 pts.
 * Exits: +100 Nifty pts take-profit, 50 Nifty pts stop-loss vs entry spot.
 */
import fs from "fs";
import path from "path";
import { isIn915OpenTickWindow, istSecondsOfDay, NINE_SIXTEEN_CLOSE_SEAL_SEC } from "./nine-sixteen-logic.js";
import { PAPER_STARTING_CASH } from "./paper-book.js";
import { computeAffordableLots } from "./nine-sixteen-sizing.js";
import type { PaperWsBacktestResult, PaperWsBacktestTrade } from "../src/types/paper-ws-backtest.js";
import type { TradeLeg } from "../src/lib/trade-calculations.js";
import {
  listPaperWsTickDates,
  loadPaperWsDayTicks,
  loadPaperWsMinuteSessions,
  markedPaperWsOptionPrice,
  paperWsTimeIst,
  paperWsPriceAt,
  PAPER_WS_ATM_DELTA,
  pickPaperWsOptionToken,
  prevPaperWsSession,
  type PaperWsLoadedDay,
} from "./nine-fifteen-ws-backtest.js";

const CACHE_DIR = path.join(process.cwd(), "data");
const CACHE_FILE = path.join(CACHE_DIR, "paper-ws-gap-v2-backtest.json");
const CACHE_MS = 30 * 60 * 1000;
const CACHE_VERSION = 5;
const LOT_SIZE = 65;
/** Minimum |first 9:15 open tick − previous session close| in Nifty points. */
export const PAPER_GAP_V2_MIN_GAP_PTS = 10;
/** Nifty points favourable from entry spot to take profit. */
export const PAPER_GAP_V2_TP_INDEX_PTS = 100;
/** Nifty points adverse from entry spot to stop loss. */
export const PAPER_GAP_V2_SL_INDEX_PTS = 50;

const MIN_GAP_FROM_PREV_CLOSE_PTS = PAPER_GAP_V2_MIN_GAP_PTS;
const V2_TP_INDEX_PTS = PAPER_GAP_V2_TP_INDEX_PTS;
const V2_SL_INDEX_PTS = PAPER_GAP_V2_SL_INDEX_PTS;

function shouldExitGapV2TakeProfit(leg: TradeLeg, entrySpot: number, spot: number): boolean {
  if (leg === "CE_BUY") return spot - entrySpot >= V2_TP_INDEX_PTS - 1e-9;
  return entrySpot - spot >= V2_TP_INDEX_PTS - 1e-9;
}

function shouldExitGapV2StopLoss(leg: TradeLeg, entrySpot: number, spot: number): boolean {
  if (leg === "CE_BUY") return spot - entrySpot <= -V2_SL_INDEX_PTS + 1e-9;
  return spot - entrySpot >= V2_SL_INDEX_PTS - 1e-9;
}

function blankV2(dateIst: string, ticks: number, tickSource: NonNullable<PaperWsBacktestTrade["tickSource"]>): PaperWsBacktestTrade {
  return {
    id: `${dateIst}-paper-trades-v2`,
    dateIST: dateIst,
    status: "no_entry",
    leg: null,
    lots: null,
    quantity: null,
    open915: null,
    mark915: null,
    entrySpot: null,
    exitSpot: null,
    entryPrice: null,
    exitPrice: null,
    prevClose: null,
    prev329Open: null,
    prev329Close: null,
    gapFromPrevClose: null,
    move10sPts: null,
    skipOrExitReason: null,
    indexPnlPts: null,
    pnl: null,
    cashAfter: null,
    entryTimeIst: null,
    exitTimeIst: null,
    wsTickCount: ticks,
    tickSource,
    source: "paper-trades-v2-ws",
  };
}

function replayGapV2Day(
  dateIst: string,
  day: PaperWsLoadedDay,
  cash: number,
  prevClose: number | null,
): { trade: PaperWsBacktestTrade; cash: number } {
  const trade = blankV2(dateIst, day.nifty.length, day.tickSource);
  trade.prevClose = prevClose;
  trade.cashAfter = cash;

  if (day.nifty.length === 0) {
    trade.status = "skipped";
    trade.skipOrExitReason = "No 9:15 Nifty ticks (disk or morningWsTicks archive)";
    return { trade, cash };
  }

  if (prevClose == null || !(prevClose > 0)) {
    trade.status = "skipped";
    trade.skipOrExitReason = "No previous session 15:30 close — gap rule needs Kite minute data";
    return { trade, cash };
  }

  let open915: number | null = null;
  let entryEpoch = 0;
  for (const tick of day.nifty) {
    if (isIn915OpenTickWindow(tick.epochMs)) {
      open915 = tick.price;
      entryEpoch = tick.epochMs;
      break;
    }
  }

  trade.open915 = open915;
  trade.mark915 = open915;
  if (open915 == null || !(open915 > 0) || entryEpoch <= 0) {
    trade.status = "skipped";
    trade.skipOrExitReason = "No Nifty tick in 9:15:00–9:15:15 open window";
    return { trade, cash };
  }

  const gap = open915 - prevClose;
  trade.gapFromPrevClose = gap;
  if (Math.abs(gap) + 1e-9 < MIN_GAP_FROM_PREV_CLOSE_PTS) {
    trade.status = "skipped";
    trade.skipOrExitReason = `Gap vs prev close ${gap >= 0 ? "+" : ""}${gap.toFixed(2)} pts is under ${MIN_GAP_FROM_PREV_CLOSE_PTS} — no trade`;
    return { trade, cash };
  }

  const leg: TradeLeg = gap > 0 ? "CE_BUY" : "PE_BUY";
  const entrySpot = open915;

  const windowEnd =
    day.nifty.find((t) => istSecondsOfDay(new Date(t.epochMs)) >= NINE_SIXTEEN_CLOSE_SEAL_SEC)?.epochMs ??
    entryEpoch + 60_000;
  const token = pickPaperWsOptionToken(day, leg, entryEpoch - 20_000, windowEnd);
  const optTicks = token != null ? day.byToken.get(token) ?? [] : [];
  const entryPrice = paperWsPriceAt(optTicks, entryEpoch);
  if (entryPrice == null || !(entryPrice > 0)) {
    trade.status = "skipped";
    trade.leg = leg;
    trade.entrySpot = entrySpot;
    trade.skipOrExitReason = "Gap signal but no option LTP at first open tick — cannot price fill";
    return { trade, cash };
  }

  const sized = computeAffordableLots({ availableBalance: cash, lotSize: LOT_SIZE, optionLtp: entryPrice });
  if (sized.lots < 1) {
    trade.status = "skipped";
    trade.leg = leg;
    trade.entrySpot = entrySpot;
    trade.entryPrice = entryPrice;
    trade.skipOrExitReason = `Paper cash ₹${Math.floor(cash)} cannot buy 1 lot at ₹${entryPrice.toFixed(2)}`;
    return { trade, cash };
  }

  const quantity = sized.lots * LOT_SIZE;
  let book = cash - entryPrice * quantity;
  let exitPrice = entryPrice;
  let exitSpot = entrySpot;
  let exitEpoch = entryEpoch;
  let reason = "Still open at 10:09 — marked to the last tick in the replay window";

  for (const tick of day.nifty) {
    if (tick.epochMs < entryEpoch) continue;
    const optPx = markedPaperWsOptionPrice(leg, optTicks, entryEpoch, entryPrice, entrySpot, tick.epochMs, tick.price);
    exitPrice = optPx;
    exitSpot = tick.price;
    exitEpoch = tick.epochMs;

    if (shouldExitGapV2StopLoss(leg, entrySpot, tick.price)) {
      reason = `Stop loss · Nifty moved ${V2_SL_INDEX_PTS} pts against entry ${entrySpot.toFixed(2)}`;
      break;
    }
    if (shouldExitGapV2TakeProfit(leg, entrySpot, tick.price)) {
      reason = `Take profit · Nifty moved ${V2_TP_INDEX_PTS} pts in favour from entry ${entrySpot.toFixed(2)}`;
      break;
    }
  }

  exitPrice = markedPaperWsOptionPrice(leg, optTicks, entryEpoch, entryPrice, entrySpot, exitEpoch, exitSpot);

  book += exitPrice * quantity;
  const pnl = Math.round((exitPrice - entryPrice) * quantity * 100) / 100;
  const indexPnl = leg === "PE_BUY" ? entrySpot - exitSpot : exitSpot - entrySpot;

  trade.status = "closed";
  trade.leg = leg;
  trade.lots = sized.lots;
  trade.quantity = quantity;
  trade.entrySpot = entrySpot;
  trade.exitSpot = exitSpot;
  trade.entryPrice = entryPrice;
  trade.exitPrice = exitPrice;
  trade.entryTimeIst = paperWsTimeIst(entryEpoch);
  trade.exitTimeIst = paperWsTimeIst(exitEpoch);
  trade.skipOrExitReason = reason;
  trade.indexPnlPts = Math.round(indexPnl * 100) / 100;
  trade.pnl = pnl;
  trade.cashAfter = Math.round(book * 100) / 100;
  return { trade, cash: trade.cashAfter };
}

async function buildFreshV2(accessToken: string | null): Promise<PaperWsBacktestResult> {
  const dates = await listPaperWsTickDates();
  const sessions = await loadPaperWsMinuteSessions(accessToken, dates).catch(() => new Map());
  const trades: PaperWsBacktestTrade[] = [];
  let cash = PAPER_STARTING_CASH;

  for (const dateIst of dates) {
    const day = await loadPaperWsDayTicks(dateIst);
    const prev = prevPaperWsSession(sessions, dateIst);
    const next = replayGapV2Day(dateIst, day, cash, prev.prevClose);
    cash = next.cash;
    trades.push(next.trade);
  }

  trades.sort((a, b) => b.dateIST.localeCompare(a.dateIST));
  const closedPnl = trades.reduce((sum, row) => sum + (row.status === "closed" ? row.pnl ?? 0 : 0), 0);
  const closedRows = trades.filter((t) => t.status === "closed");
  const wins = closedRows.filter((t) => (t.pnl ?? 0) > 1e-6).length;
  const losses = closedRows.filter((t) => (t.pnl ?? 0) < -1e-6).length;
  const breakeven = closedRows.length - wins - losses;

  return {
    version: CACHE_VERSION,
    variant: "gap-open-v2",
    stats: {
      tradesTaken: closedRows.length,
      wins,
      losses,
      breakeven,
    },
    trades,
    datesWithWs: dates,
    startingCash: PAPER_STARTING_CASH,
    endingCash: Math.round(cash * 100) / 100,
    closedPnl: Math.round(closedPnl * 100) / 100,
    builtAt: new Date().toISOString(),
    note: `Paper trades v2 · first Nifty tick in 9:15:00–9:15:15 vs prev session 15:30 close: CE if ≥+${MIN_GAP_FROM_PREV_CLOSE_PTS} pts gap, PE if ≤−${MIN_GAP_FROM_PREV_CLOSE_PTS} · entry at that tick · Nifty TP +${V2_TP_INDEX_PTS} pts · Nifty SL −${V2_SL_INDEX_PTS} pts vs entry spot · option exit from archived LTP or ~${PAPER_WS_ATM_DELTA}× spot move`,
  };
}

function readCacheV2(allowStale: boolean, datesWithWs: string[]): PaperWsBacktestResult | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as PaperWsBacktestResult;
    if (parsed.version !== CACHE_VERSION || parsed.variant !== "gap-open-v2") return null;
    if (!parsed.builtAt) return null;
    if (!allowStale && Date.now() - Date.parse(parsed.builtAt) > CACHE_MS) return null;
    if ((parsed.datesWithWs ?? []).join(",") !== datesWithWs.join(",")) return null;
    return parsed;
  } catch {
    return null;
  }
}

let inflightV2: Promise<PaperWsBacktestResult> | null = null;

export async function ensurePaperWsGapV2Backtest(accessToken: string | null): Promise<PaperWsBacktestResult> {
  const dates = await listPaperWsTickDates();
  const cached = readCacheV2(true, dates);
  const fresh =
    cached != null &&
    Date.now() - Date.parse(cached.builtAt) <= CACHE_MS &&
    (cached.datesWithWs ?? []).join(",") === dates.join(",");
  if (cached && fresh) return cached;
  if (cached) {
    if (!inflightV2) inflightV2 = rebuildV2(accessToken);
    return cached;
  }
  return rebuildV2(accessToken);
}

function rebuildV2(accessToken: string | null): Promise<PaperWsBacktestResult> {
  if (!inflightV2) {
    inflightV2 = buildFreshV2(accessToken)
      .then((fresh) => {
        try {
          fs.mkdirSync(CACHE_DIR, { recursive: true });
          fs.writeFileSync(CACHE_FILE, JSON.stringify(fresh));
        } catch {
          /* optional */
        }
        return fresh;
      })
      .finally(() => {
        inflightV2 = null;
      });
  }
  return inflightV2;
}
