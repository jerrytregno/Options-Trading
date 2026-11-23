/**
 * Paper trades v3 — same gap entry and Nifty TP/SL as v2, replayed on Nifty 50 **1-minute OHLC**
 * (no websocket). ~1 year of weekday sessions. Requires Kite access token.
 */
import fs from "fs";
import path from "path";
import { fetchHistoricalCandles } from "./kite-candles.js";
import { NIFTY_INDEX_PROFILE } from "./nine-fifteen-candles.js";
import { PAPER_STARTING_CASH } from "./paper-book.js";
import { computeAffordableLots } from "./nine-sixteen-sizing.js";
import { chunk, groupSessionBars, isCompleteSession, type MinuteBar } from "./session-bars.js";
import type { PaperWsBacktestResult, PaperWsBacktestStats, PaperWsBacktestTrade } from "../src/types/paper-ws-backtest.js";
import type { TradeLeg } from "../src/lib/trade-calculations.js";
import {
  PAPER_GAP_V2_MIN_GAP_PTS,
  PAPER_GAP_V2_SL_INDEX_PTS,
  PAPER_GAP_V2_TP_INDEX_PTS,
} from "./paper-ws-gap-v2-backtest.js";
import { PAPER_WS_ATM_DELTA } from "./nine-fifteen-ws-backtest.js";

const CACHE_DIR = path.join(process.cwd(), "data");
const CACHE_FILE = path.join(CACHE_DIR, "paper-gap-ohlc-v3-backtest.json");
const CACHE_MS = 12 * 60 * 60 * 1000;
const CACHE_VERSION = 1;
const CALENDAR_DAYS_LOOKBACK = 365;
const CHUNK_TRADING_DAYS = 40;
const LOT_SIZE = 65;

const OPEN_915_MINS = 9 * 60 + 15;

/** Synthetic ATM option premium at entry when we only have index OHLC (scale ~₹/point). */
function syntheticOptionEntryPremium(entrySpot: number): number {
  return Math.round(Math.max(35, entrySpot * 0.0015) * 100) / 100;
}

function syntheticOptionExitPx(leg: TradeLeg, entryPrem: number, entrySpot: number, exitSpot: number): number {
  const move = exitSpot - entrySpot;
  const premMove = leg === "CE_BUY" ? move * PAPER_WS_ATM_DELTA : -move * PAPER_WS_ATM_DELTA;
  return Math.round(Math.max(0.05, entryPrem + premMove) * 100) / 100;
}

function blankV3(dateIst: string, barCount: number): PaperWsBacktestTrade {
  return {
    id: `${dateIst}-paper-trades-v3`,
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
    entryTimeIst: "09:15",
    exitTimeIst: null,
    wsTickCount: barCount,
    tickSource: "none",
    source: "paper-trades-v3-ohlc",
  };
}

function listWeekdayDatesGoingBack(calendarDays: number): string[] {
  const IST = "Asia/Kolkata";
  const dates: string[] = [];
  for (let offset = calendarDays; offset >= 0; offset -= 1) {
    const d = new Date(Date.now() - offset * 86_400_000);
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: IST, weekday: "short" }).format(d);
    if (wd === "Sat" || wd === "Sun") continue;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: IST,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const y = parts.find((p) => p.type === "year")?.value ?? "1970";
    const m = parts.find((p) => p.type === "month")?.value ?? "01";
    const day = parts.find((p) => p.type === "day")?.value ?? "01";
    dates.push(`${y}-${m}-${day}`);
  }
  return dates;
}

type ExitScan = { exitSpot: number; exitMins: number; reason: string; indexOutcome: "tp" | "sl" | "eod" };

function scanExitFromBars(leg: TradeLeg, entrySpot: number, bars: MinuteBar[]): ExitScan {
  const tp = PAPER_GAP_V2_TP_INDEX_PTS;
  const sl = PAPER_GAP_V2_SL_INDEX_PTS;
  for (const bar of bars) {
    if (bar.mins <= OPEN_915_MINS) continue;

    if (leg === "CE_BUY") {
      const slPx = entrySpot - sl;
      const tpPx = entrySpot + tp;
      if (bar.low <= slPx + 1e-9) {
        return { exitSpot: slPx, exitMins: bar.mins, reason: `SL · Nifty −${sl} pts vs entry (1m low)`, indexOutcome: "sl" };
      }
      if (bar.high + 1e-9 >= tpPx) {
        return { exitSpot: tpPx, exitMins: bar.mins, reason: `TP · Nifty +${tp} pts vs entry (1m high)`, indexOutcome: "tp" };
      }
    } else {
      const slPx = entrySpot + sl;
      const tpPx = entrySpot - tp;
      if (bar.high + 1e-9 >= slPx) {
        return { exitSpot: slPx, exitMins: bar.mins, reason: `SL · Nifty +${sl} pts vs entry (1m high)`, indexOutcome: "sl" };
      }
      if (bar.low <= tpPx + 1e-9) {
        return { exitSpot: tpPx, exitMins: bar.mins, reason: `TP · Nifty −${tp} pts vs entry (1m low)`, indexOutcome: "tp" };
      }
    }
  }

  const last = bars[bars.length - 1];
  const close = last?.close ?? entrySpot;
  return {
    exitSpot: close,
    exitMins: last?.mins ?? OPEN_915_MINS,
    reason: "EOD · neither TP nor SL hit — exit at 15:30 close",
    indexOutcome: "eod",
  };
}

function formatMins(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function replayDayV3(
  dateIst: string,
  bars: MinuteBar[],
  prevClose: number | null,
  cash: number,
): { trade: PaperWsBacktestTrade; cash: number } {
  const trade = blankV3(dateIst, bars.length);
  trade.prevClose = prevClose;
  trade.cashAfter = cash;

  if (!isCompleteSession(bars)) {
    trade.status = "skipped";
    trade.skipOrExitReason = "Partial session in minute data";
    return { trade, cash };
  }

  const bar915 = bars.find((b) => b.mins === OPEN_915_MINS);
  const open915 = bar915?.open ?? null;
  trade.open915 = open915;
  trade.mark915 = open915;

  if (open915 == null || !(open915 > 0)) {
    trade.status = "skipped";
    trade.skipOrExitReason = "No 9:15 open bar";
    return { trade, cash };
  }

  if (prevClose == null || !(prevClose > 0)) {
    trade.status = "skipped";
    trade.skipOrExitReason = "No previous session close";
    return { trade, cash };
  }

  const gap = open915 - prevClose;
  trade.gapFromPrevClose = gap;
  if (Math.abs(gap) + 1e-9 < PAPER_GAP_V2_MIN_GAP_PTS) {
    trade.status = "skipped";
    trade.skipOrExitReason = `Gap vs prev close ${gap >= 0 ? "+" : ""}${gap.toFixed(2)} pts < ${PAPER_GAP_V2_MIN_GAP_PTS}`;
    return { trade, cash };
  }

  const leg: TradeLeg = gap > 0 ? "CE_BUY" : "PE_BUY";
  const entrySpot = open915;
  const entryPrice = syntheticOptionEntryPremium(entrySpot);

  const sized = computeAffordableLots({ availableBalance: cash, lotSize: LOT_SIZE, optionLtp: entryPrice });
  if (sized.lots < 1) {
    trade.status = "skipped";
    trade.leg = leg;
    trade.entrySpot = entrySpot;
    trade.entryPrice = entryPrice;
    trade.skipOrExitReason = `Cannot size 1 lot at synthetic ₹${entryPrice.toFixed(2)}`;
    return { trade, cash };
  }

  const quantity = sized.lots * LOT_SIZE;
  const { exitSpot, exitMins, reason, indexOutcome } = scanExitFromBars(leg, entrySpot, bars);
  const exitPrice = syntheticOptionExitPx(leg, entryPrice, entrySpot, exitSpot);

  let book = cash - entryPrice * quantity + exitPrice * quantity;
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
  trade.exitTimeIst = formatMins(exitMins);
  trade.skipOrExitReason = `${reason}${indexOutcome === "eod" ? "" : ""}`;
  trade.indexPnlPts = Math.round(indexPnl * 100) / 100;
  trade.pnl = pnl;
  trade.cashAfter = Math.round(book * 100) / 100;

  return { trade, cash: trade.cashAfter };
}

async function loadAllSessions(accessToken: string): Promise<Map<string, MinuteBar[]>> {
  const weekdays = listWeekdayDatesGoingBack(CALENDAR_DAYS_LOOKBACK);
  const merged = new Map<string, MinuteBar[]>();

  for (const group of chunk(weekdays, CHUNK_TRADING_DAYS)) {
    if (group.length === 0) continue;
    const from = `${group[0]} 09:15:00`;
    const to = `${group[group.length - 1]} 15:30:00`;
    const { candles } = await fetchHistoricalCandles(
      accessToken,
      NIFTY_INDEX_PROFILE.spotKey,
      "minute",
      from,
      to,
    );
    const batch = groupSessionBars(candles as unknown[][]);
    for (const [d, bars] of batch) merged.set(d, bars);
  }

  return merged;
}

async function buildFreshV3(accessToken: string, preloaded?: Map<string, MinuteBar[]>): Promise<PaperWsBacktestResult> {
  const sessions = preloaded ?? (await loadAllSessions(accessToken));
  const sortedDates = [...sessions.keys()].filter((d) => isCompleteSession(sessions.get(d) ?? [])).sort();

  const trades: PaperWsBacktestTrade[] = [];
  let cash = PAPER_STARTING_CASH;

  for (let i = 0; i < sortedDates.length; i += 1) {
    const dateIst = sortedDates[i]!;
    const bars = sessions.get(dateIst)!;
    let prevClose: number | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      const pb = sessions.get(sortedDates[j]!);
      if (!pb || !isCompleteSession(pb)) continue;
      const c = pb[pb.length - 1]?.close;
      if (c != null && c > 0) {
        prevClose = c;
        break;
      }
    }

    const next = replayDayV3(dateIst, bars, prevClose, cash);
    cash = next.cash;
    trades.push(next.trade);
  }

  trades.sort((a, b) => b.dateIST.localeCompare(a.dateIST));

  const closed = trades.filter((t) => t.status === "closed");
  const winByIndex = closed.filter((t) => {
    const r = t.skipOrExitReason ?? "";
    return r.startsWith("TP ·");
  });
  const lossByIndex = closed.filter((t) => {
    const r = t.skipOrExitReason ?? "";
    return r.startsWith("SL ·") || r.startsWith("EOD ·");
  });
  const winDates = winByIndex.map((t) => t.dateIST).sort((a, b) => b.localeCompare(a));
  const lossDates = lossByIndex.map((t) => t.dateIST).sort((a, b) => b.localeCompare(a));

  const winsOpt = closed.filter((t) => (t.pnl ?? 0) > 1e-6).length;
  const lossesOpt = closed.filter((t) => (t.pnl ?? 0) < -1e-6).length;
  const stats: PaperWsBacktestStats = {
    tradesTaken: closed.length,
    wins: winsOpt,
    losses: lossesOpt,
    breakeven: closed.length - winsOpt - lossesOpt,
    winDaysByIndex: winByIndex.length,
    lossDaysByIndex: lossByIndex.length,
  };

  const closedPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);

  return {
    version: CACHE_VERSION,
    variant: "gap-open-v3-ohlc",
    stats,
    trades,
    datesWithWs: sortedDates,
    startingCash: PAPER_STARTING_CASH,
    endingCash: Math.round(cash * 100) / 100,
    closedPnl: Math.round(closedPnl * 100) / 100,
    builtAt: new Date().toISOString(),
    note: `Paper trades v3 · Nifty 50 **1m OHLC** (no WS) · last ~${CALENDAR_DAYS_LOOKBACK} calendar days · entry = 9:15 **open** vs **prior session 15:30 close** (≥${PAPER_GAP_V2_MIN_GAP_PTS} pts gap) · CE above / PE below · TP **+${PAPER_GAP_V2_TP_INDEX_PTS}** / SL **${PAPER_GAP_V2_SL_INDEX_PTS}** Nifty pts vs entry · intrabar **low first** for CE TP/SL scan · synthetic option ~${PAPER_WS_ATM_DELTA}× spot · **Win days** / **loss days** = TP vs SL/EOD on index.`,
    winDates,
    lossDates,
  };
}

function cacheKey(dates: string[]): string {
  return dates.join(",");
}

function readCacheV3(allowStale: boolean, dates: string[]): PaperWsBacktestResult | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as PaperWsBacktestResult;
    if (parsed.version !== CACHE_VERSION || parsed.variant !== "gap-open-v3-ohlc") return null;
    if (!parsed.builtAt) return null;
    if (!allowStale && Date.now() - Date.parse(parsed.builtAt) > CACHE_MS) return null;
    if (cacheKey(parsed.datesWithWs ?? []) !== cacheKey(dates)) return null;
    return parsed;
  } catch {
    return null;
  }
}

let inflightV3: Promise<PaperWsBacktestResult> | null = null;

export async function ensurePaperGapOhlcV3Backtest(accessToken: string | null): Promise<PaperWsBacktestResult> {
  if (!accessToken) {
    return {
      version: CACHE_VERSION,
      variant: "gap-open-v3-ohlc",
      trades: [],
      datesWithWs: [],
      startingCash: PAPER_STARTING_CASH,
      endingCash: PAPER_STARTING_CASH,
      closedPnl: 0,
      builtAt: new Date().toISOString(),
      note: "Paper trades v3 needs a logged-in Kite session (Settings) to pull Nifty minute OHLC.",
      winDates: [],
      lossDates: [],
    };
  }

  const sessions = await loadAllSessions(accessToken);
  const sortedDates = [...sessions.keys()].filter((d) => isCompleteSession(sessions.get(d) ?? [])).sort();

  const cached = readCacheV3(true, sortedDates);
  const fresh =
    cached != null &&
    Date.now() - Date.parse(cached.builtAt) <= CACHE_MS &&
    cacheKey(cached.datesWithWs ?? []) === cacheKey(sortedDates);

  if (cached && fresh) return cached;
  if (cached) {
    if (!inflightV3) inflightV3 = rebuildV3(accessToken, sessions);
    return cached;
  }
  return rebuildV3(accessToken, sessions);
}

function rebuildV3(accessToken: string, sessions: Map<string, MinuteBar[]>): Promise<PaperWsBacktestResult> {
  if (!inflightV3) {
    inflightV3 = buildFreshV3(accessToken, sessions)
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
        inflightV3 = null;
      });
  }
  return inflightV3;
}
