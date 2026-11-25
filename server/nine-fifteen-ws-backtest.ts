/**
 * Paper replay of the live 9:15 rules on archived websocket files.
 * One ₹10L book, 9:15 only, days that actually have a 9:15 Nifty tick.
 */
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import {
  decideNineFifteenEntry,
  isIn915OpenTickWindow,
  isNineFifteenFlip916ExitWindow,
  istSecondsOfDay,
  NINE_FIFTEEN_ENTRY_SEC,
  NINE_FIFTEEN_INDEX_EXIT_PTS,
  NINE_FIFTEEN_LOSS_EXIT_PCT,
  NINE_FIFTEEN_PREV_CANDLE_MINUTE,
  NINE_FIFTEEN_SIGNAL_READ_SEC,
  NINE_SIXTEEN_CLOSE_SEAL_SEC,
  NINE_SIXTEEN_HARD_STOP_INDEX_POINTS,
  NINE_SIXTEEN_MIN_915_ABS_DIFF,
  pnlPctOfEntryCost,
  shouldExitNineFifteenBackThroughOpen,
  shouldExitNineFifteenIndexTarget,
  shouldExitNineFifteenLossPct,
  shouldHardStopNineSixteen,
  shouldNineFifteenFlip916Exit,
  type NineFifteenPrevCandle,
} from "./nine-sixteen-logic.js";
import { fetchHistoricalCandles } from "./kite-candles.js";
import { PAPER_STARTING_CASH } from "./paper-book.js";
import { chunk, groupSessionBars, isCompleteSession, type MinuteBar } from "./session-bars.js";
import { computeAffordableLots } from "./nine-sixteen-sizing.js";
import { listNineFifteenMinuteTickDates } from "./nine-fifteen-minute-ticks.js";
import {
  readArchivedMorningTickRows,
  readArchivedMorningTickRowsFromStorage,
} from "./morning-ws-tick-firebase-archive.js";
import type { RawTickRow } from "./nine-sixteen-bot.js";
import type {
  PaperWsBacktestResult,
  PaperWsBacktestTrade,
} from "../src/types/paper-ws-backtest.js";
import type { TradeLeg } from "../src/lib/trade-calculations.js";

const TICK_DIR = path.join(process.cwd(), "data", "ticks");
const CACHE_DIR = path.join(process.cwd(), "data");
const CACHE_FILE = path.join(CACHE_DIR, "paper-ws-backtest.json");
const CACHE_FILE_NO_329 = path.join(CACHE_DIR, "paper-ws-backtest-no-329.json");

function cacheFileFor(skipPrev329Gap: boolean): string {
  return skipPrev329Gap ? CACHE_FILE_NO_329 : CACHE_FILE;
}
const CACHE_MS = 30 * 60 * 1000;
const CACHE_VERSION = 9;
const MINUTE_SESSION_CACHE_FILE = path.join(CACHE_DIR, "paper-ws-minute-sessions.json");
const MINUTE_SESSION_CACHE_VERSION = 1;
/** When the archived option tape has no tick at exit, map Nifty spot move → premium (ATM rough). */
export const PAPER_WS_ATM_DELTA = 0.55;
const LOT_SIZE = 65;
const OPEN_SEC = 9 * 3600 + 15 * 60;

export type PaperWsTick = { epochMs: number; price: number; token?: number };

export type PaperWsDayTicks = {
  nifty: PaperWsTick[];
  byToken: Map<number, PaperWsTick[]>;
  tokenSide: Map<number, "CE" | "PE">;
};

export type PaperWsLoadedDay = PaperWsDayTicks & {
  tickSource: NonNullable<PaperWsBacktestTrade["tickSource"]>;
};

/** Disk + Firestore morningWsTicks + upload index (includes Oct 5+ days only in the DB). */
export async function listPaperWsTickDates(): Promise<string[]> {
  const dates = await listNineFifteenMinuteTickDates();
  // An empty archive doc can exist for a Saturday; the market was shut, so it is not a skipped day.
  return [...dates].filter((date) => !isWeekendIst(date)).sort();
}

function addCalendarDaysIst(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00+05:30`);
  d.setDate(d.getDate() + days);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${day}`;
}

export function paperWsTimeIst(epochMs: number): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(epochMs));
}

export function listWsTickDates(): string[] {
  try {
    if (!fs.existsSync(TICK_DIR)) return [];
    return fs
      .readdirSync(TICK_DIR)
      .map((name) => /^ws-ticks-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1] ?? "")
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

const TICK_WINDOW_GREP = '"timeIST":"09:(1[5-9]|[2-5][0-9])|"timeIST":"10:0';

/** 9:15:00–10:09 only. grep does the filter so the API process does not parse the whole day. */
function grepTickLines(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "grep",
      ["-E", TICK_WINDOW_GREP, file],
      { maxBuffer: 80 * 1024 * 1024 },
      (error, stdout) => {
        if (!error) return resolve(stdout);
        if ((error as NodeJS.ErrnoException).code === "1") return resolve("");
        reject(error);
      },
    );
  });
}

function rowsToDayTicks(rows: RawTickRow[]): PaperWsDayTicks {
  const nifty: PaperWsTick[] = [];
  const byToken = new Map<number, PaperWsTick[]>();
  const tokenSide = new Map<number, "CE" | "PE">();
  const sorted = [...rows].sort((a, b) => a.epochMs - b.epochMs || a.seq - b.seq);
  for (const row of sorted) {
    const epochMs = row.epochMs;
    const price = row.price;
    if (!(epochMs > 0) || !(price > 0)) continue;
    if (row.kind === "nifty") nifty.push({ epochMs, price });
    else if (row.kind === "option" && row.instrumentToken) {
      const list = byToken.get(row.instrumentToken) ?? [];
      list.push({ epochMs, price, token: row.instrumentToken });
      byToken.set(row.instrumentToken, list);
      if (row.optionSide === "CE" || row.optionSide === "PE") {
        tokenSide.set(row.instrumentToken, row.optionSide);
      }
    }
  }
  return { nifty, byToken, tokenSide };
}

function lastNiftySec(day: PaperWsDayTicks): number {
  const last = day.nifty[day.nifty.length - 1];
  return last ? istSecondsOfDay(new Date(last.epochMs)) : 0;
}

function preferDiskOverArchive(disk: PaperWsDayTicks, archive: PaperWsDayTicks | null): boolean {
  if (disk.nifty.length === 0) return false;
  if (!archive || archive.nifty.length === 0) return true;
  if (lastNiftySec(disk) > lastNiftySec(archive)) return true;
  return disk.nifty.length >= archive.nifty.length;
}

async function loadDayTicksFromDiskGrep(dateIst: string): Promise<PaperWsDayTicks> {
  const file = path.join(TICK_DIR, `ws-ticks-${dateIst}.jsonl`);
  const nifty: PaperWsTick[] = [];
  const byToken = new Map<number, PaperWsTick[]>();
  const tokenSide = new Map<number, "CE" | "PE">();
  if (!fs.existsSync(file)) return { nifty, byToken, tokenSide };

  const text = await grepTickLines(file);
  for (const line of text.split("\n")) {
    if (!line) continue;
    let row: RawTickRow;
    try {
      row = JSON.parse(line) as RawTickRow;
    } catch {
      continue;
    }
    const epochMs = row.epochMs;
    const price = row.price;
    if (epochMs == null || price == null || !(price > 0) || !(epochMs > 0)) continue;
    if (row.kind === "nifty") nifty.push({ epochMs, price });
    else if (row.kind === "option" && row.instrumentToken) {
      const list = byToken.get(row.instrumentToken) ?? [];
      list.push({ epochMs, price, token: row.instrumentToken });
      byToken.set(row.instrumentToken, list);
      if (row.optionSide === "CE" || row.optionSide === "PE") {
        tokenSide.set(row.instrumentToken, row.optionSide);
      }
    }
  }
  return { nifty, byToken, tokenSide };
}

export async function loadPaperWsDayTicks(dateIst: string): Promise<PaperWsLoadedDay> {
  const disk = await loadDayTicksFromDiskGrep(dateIst);
  const fsRows = await readArchivedMorningTickRows(dateIst);
  const fromFirestore = fsRows ? rowsToDayTicks(fsRows) : null;

  if (preferDiskOverArchive(disk, fromFirestore)) {
    return { ...disk, tickSource: "disk" };
  }
  if (fromFirestore && fromFirestore.nifty.length > 0) {
    return { ...fromFirestore, tickSource: "firestore" };
  }
  if (disk.nifty.length > 0) {
    return { ...disk, tickSource: "disk" };
  }

  const stRows = await readArchivedMorningTickRowsFromStorage(dateIst);
  if (stRows) {
    const fromStorage = rowsToDayTicks(stRows);
    if (fromStorage.nifty.length > 0) {
      return { ...fromStorage, tickSource: "storage" };
    }
  }

  return { nifty: [], byToken: new Map(), tokenSide: new Map(), tickSource: "none" };
}

export function paperWsPriceAt(ticks: PaperWsTick[], epochMs: number): number | null {
  let last: number | null = null;
  for (const tick of ticks) {
    if (tick.epochMs > epochMs) break;
    last = tick.price;
  }
  return last ?? ticks.find((t) => t.epochMs >= epochMs)?.price ?? null;
}

function roundOptionPx(px: number): number {
  return Math.round(px * 100) / 100;
}

/** PE gains when spot falls; CE gains when spot rises. */
function estimateOptionFromSpotMove(
  leg: TradeLeg,
  entryPrice: number,
  entrySpot: number,
  spot: number,
): number {
  const move = spot - entrySpot;
  const premMove = leg === "CE_BUY" ? move * PAPER_WS_ATM_DELTA : -move * PAPER_WS_ATM_DELTA;
  return roundOptionPx(Math.max(0.05, entryPrice + premMove));
}

/**
 * Mark at exit time: prefer websocket option LTP; if the tape is stale (still entry print),
 * use the last option tick after entry or a Nifty-delta estimate so wins/losses are not ₹0.
 */
export function markedPaperWsOptionPrice(
  leg: TradeLeg,
  optTicks: PaperWsTick[],
  entryEpoch: number,
  entryPrice: number,
  entrySpot: number,
  atEpoch: number,
  spot: number,
): number {
  const onTape = paperWsPriceAt(optTicks, atEpoch);
  if (onTape != null && onTape > 0 && Math.abs(onTape - entryPrice) >= 0.05) {
    return roundOptionPx(onTape);
  }
  for (let i = optTicks.length - 1; i >= 0; i -= 1) {
    const t = optTicks[i]!;
    if (t.epochMs <= entryEpoch) continue;
    if (t.epochMs > atEpoch) continue;
    if (Math.abs(t.price - entryPrice) >= 0.05) return roundOptionPx(t.price);
  }
  if (Math.abs(spot - entrySpot) >= 0.25) {
    return estimateOptionFromSpotMove(leg, entryPrice, entrySpot, spot);
  }
  return onTape != null && onTape > 0 ? roundOptionPx(onTape) : entryPrice;
}

function moveBetween(ticks: PaperWsTick[], fromMs: number, toMs: number): number | null {
  const a = paperWsPriceAt(ticks, fromMs);
  const b = paperWsPriceAt(ticks, toMs);
  if (a == null || b == null) return null;
  return b - a;
}

/** CE premium rises with Nifty; PE premium falls. Prefer token tagged CE/PE on the tick row. */
export function pickPaperWsOptionToken(day: PaperWsDayTicks, leg: TradeLeg, fromMs: number, toMs: number): number | null {
  const wantSide = leg === "CE_BUY" ? "CE" : "PE";
  const bySide = [...day.byToken.keys()].filter((t) => day.tokenSide.get(t) === wantSide);
  const pool =
    bySide.length > 0 ? bySide : [...day.byToken.keys()];

  const niftyMove = moveBetween(day.nifty, fromMs, toMs);
  if (niftyMove == null || Math.abs(niftyMove) < 1) {
    return pool[0] ?? null;
  }
  let best: { token: number; score: number } | null = null;
  for (const token of pool) {
    const ticks = day.byToken.get(token) ?? [];
    const optMove = moveBetween(ticks, fromMs, toMs);
    if (optMove == null) continue;
    const aligned = leg === "CE_BUY" ? optMove * niftyMove : -optMove * niftyMove;
    if (!best || aligned > best.score) best = { token, score: aligned };
  }
  return best && best.score > 0 ? best.token : (pool[0] ?? null);
}

function readMinuteSessionCache(): Map<string, MinuteBar[]> {
  try {
    if (!fs.existsSync(MINUTE_SESSION_CACHE_FILE)) return new Map();
    const parsed = JSON.parse(fs.readFileSync(MINUTE_SESSION_CACHE_FILE, "utf8")) as {
      version?: number;
      byDate?: Record<string, MinuteBar[]>;
    };
    if (parsed.version !== MINUTE_SESSION_CACHE_VERSION) return new Map();
    return new Map(Object.entries(parsed.byDate ?? {}));
  } catch {
    return new Map();
  }
}

function writeMinuteSessionCache(byDate: Map<string, MinuteBar[]>) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      MINUTE_SESSION_CACHE_FILE,
      JSON.stringify({ version: MINUTE_SESSION_CACHE_VERSION, byDate: Object.fromEntries(byDate) }),
    );
  } catch {
    /* optional */
  }
}

function minuteSessionsNeedKiteFetch(sessions: Map<string, MinuteBar[]>, tickDates: string[]): boolean {
  for (const dateIst of tickDates) {
    const prev = prevPaperWsSession(sessions, dateIst);
    if (prev.prevClose == null || !(prev.prevClose > 0)) return true;
  }
  return false;
}

function isWeekendIst(dateIst: string): boolean {
  const wd = new Date(`${dateIst}T12:00:00+05:30`).getUTCDay();
  return wd === 0 || wd === 6;
}

/**
 * Kite caps one `minute` request at 60 days, so a single call across the whole tick archive comes
 * back empty and every day then reports a missing 15:29 candle. Pull in trading-day chunks instead.
 */
const MINUTE_FETCH_CHUNK_DAYS = 40;

async function fetchSessionRange(
  accessToken: string,
  fromDate: string,
  toDate: string,
): Promise<Map<string, MinuteBar[]>> {
  const { candles } = await fetchHistoricalCandles(
    accessToken,
    "NSE:NIFTY 50",
    "minute",
    `${fromDate} 09:15:00`,
    `${toDate} 15:30:00`,
  );
  return groupSessionBars(candles as unknown[][]);
}

export async function loadPaperWsMinuteSessions(
  accessToken: string | null,
  dates: string[],
): Promise<Map<string, MinuteBar[]>> {
  const out = new Map<string, MinuteBar[]>();
  if (dates.length === 0) return out;

  const diskCache = readMinuteSessionCache();
  for (const [date, bars] of diskCache) {
    if (isCompleteSession(bars)) out.set(date, bars);
  }

  if (!accessToken) return out;
  if (!minuteSessionsNeedKiteFetch(out, dates)) return out;

  // Every weekday from ten days before the first tick day, so each day has a prior session to read.
  const wanted: string[] = [];
  for (
    let day = addCalendarDaysIst(dates[0]!, -10);
    day <= dates[dates.length - 1]!;
    day = addCalendarDaysIst(day, 1)
  ) {
    if (isWeekendIst(day)) continue;
    const have = out.get(day);
    if (have && isCompleteSession(have)) continue;
    wanted.push(day);
  }

  for (const group of chunk(wanted, MINUTE_FETCH_CHUNK_DAYS)) {
    if (group.length === 0) continue;
    try {
      const batch = await fetchSessionRange(accessToken, group[0]!, group[group.length - 1]!);
      for (const [date, bars] of batch) {
        if (!isCompleteSession(bars)) continue;
        diskCache.set(date, bars);
        out.set(date, bars);
      }
    } catch (err) {
      console.error("[paper-ws-backtest] minute chunk failed", group[0], group[group.length - 1], err);
    }
  }

  // A day the chunk missed (holiday boundary, partial response) is worth one single-day retry.
  for (const dateIst of dates) {
    if (prevPaperWsSession(out, dateIst).prevClose != null) continue;
    for (let back = 1; back <= 6; back += 1) {
      const prev = addCalendarDaysIst(dateIst, -back);
      if (isWeekendIst(prev) || out.has(prev)) continue;
      try {
        const bars = (await fetchSessionRange(accessToken, prev, prev)).get(prev);
        if (bars && isCompleteSession(bars)) {
          diskCache.set(prev, bars);
          out.set(prev, bars);
          break;
        }
      } catch (err) {
        console.error("[paper-ws-backtest] single session fetch failed", prev, err);
      }
    }
  }

  writeMinuteSessionCache(diskCache);
  return out;
}

export function prevPaperWsSession(
  sessions: Map<string, MinuteBar[]>,
  dateIst: string,
): { prevClose: number | null; prevCandle: NineFifteenPrevCandle | null } {
  for (let back = 1; back <= 8; back += 1) {
    const prev = addCalendarDaysIst(dateIst, -back);
    const bars = sessions.get(prev);
    if (!bars || bars.length === 0) continue;
    const close = bars[bars.length - 1]?.close ?? 0;
    // Prefer the 15:29 bar; on a short session the last bar of the day is that final full minute.
    const candle329 =
      bars.find((bar) => bar.mins === NINE_FIFTEEN_PREV_CANDLE_MINUTE) ??
      [...bars].reverse().find((bar) => bar.mins <= NINE_FIFTEEN_PREV_CANDLE_MINUTE);
    if (!(close > 0) || !candle329 || !(candle329.open > 0) || !(candle329.close > 0)) continue;
    return { prevClose: close, prevCandle: { open: candle329.open, close: candle329.close } };
  }
  return { prevClose: null, prevCandle: null };
}

function blank(
  dateIst: string,
  ticks: number,
  tickSource: NonNullable<PaperWsBacktestTrade["tickSource"]>,
): PaperWsBacktestTrade {
  return {
    id: `${dateIst}-ws-backtest`,
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
    source: "ws-backtest",
  };
}

function replayDay(
  dateIst: string,
  day: PaperWsLoadedDay,
  cash: number,
  prevClose: number | null,
  prevCandle: NineFifteenPrevCandle | null,
  skipPrev329Gap: boolean,
): { trade: PaperWsBacktestTrade; cash: number } {
  const trade = blank(dateIst, day.nifty.length, day.tickSource);
  trade.prevClose = prevClose;
  trade.prev329Open = prevCandle?.open ?? null;
  trade.prev329Close = prevCandle?.close ?? null;
  trade.cashAfter = cash;

  if (day.nifty.length === 0) {
    trade.status = "skipped";
    trade.skipOrExitReason = "No 9:15 Nifty ticks (disk or morningWsTicks archive)";
    return { trade, cash };
  }

  let open915: number | null = null;
  let mark915: number | null = null;
  let entrySpot: number | null = null;
  let entryEpoch = 0;
  for (const tick of day.nifty) {
    const sec = istSecondsOfDay(new Date(tick.epochMs));
    if (isIn915OpenTickWindow(tick.epochMs) && open915 == null) open915 = tick.price;
    if (sec >= OPEN_SEC && sec < NINE_FIFTEEN_SIGNAL_READ_SEC) mark915 = tick.price;
    if (sec >= NINE_FIFTEEN_ENTRY_SEC && entrySpot == null) {
      entrySpot = tick.price;
      entryEpoch = tick.epochMs;
    }
  }
  trade.open915 = open915;
  trade.mark915 = mark915;
  trade.gapFromPrevClose = open915 != null && prevClose != null ? open915 - prevClose : null;

  if (open915 == null || mark915 == null) {
    trade.status = "skipped";
    trade.skipOrExitReason = "9:15 open or 9:15:10 mark missing in the websocket file";
    return { trade, cash };
  }

  const decision = decideNineFifteenEntry(open915, mark915, prevClose, prevCandle, { skipPrev329Gap });
  trade.move10sPts = Math.abs(mark915 - open915);
  if (decision.action === "skip") {
    trade.status = "skipped";
    trade.skipOrExitReason = decision.reason;
    return { trade, cash };
  }
  if (entrySpot == null) {
    trade.status = "skipped";
    trade.leg = decision.leg;
    trade.skipOrExitReason = "Signal fired but no tick at 9:15:11";
    return { trade, cash };
  }

  const leg = decision.leg;
  const windowEnd = day.nifty.find((t) => istSecondsOfDay(new Date(t.epochMs)) >= NINE_SIXTEEN_CLOSE_SEAL_SEC)?.epochMs
    ?? entryEpoch + 60_000;
  const token = pickPaperWsOptionToken(day, leg, entryEpoch - 20_000, windowEnd);
  const optTicks = token != null ? day.byToken.get(token) ?? [] : [];
  const entryPrice = paperWsPriceAt(optTicks, entryEpoch);
  if (entryPrice == null || !(entryPrice > 0)) {
    trade.status = "skipped";
    trade.leg = leg;
    trade.entrySpot = entrySpot;
    trade.skipOrExitReason = "9:15 signal fired but no option tick to price the paper fill";
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
    const pnlNow = (optPx - entryPrice) * quantity;
    const pnlPct = pnlPctOfEntryCost(pnlNow, entryPrice, quantity);

    if (shouldExitNineFifteenIndexTarget(leg, entrySpot, tick.price)) {
      reason = `+${NINE_FIFTEEN_INDEX_EXIT_PTS} Nifty pts from the 9:15:11 fill`;
      break;
    }
    if (shouldExitNineFifteenBackThroughOpen(leg, open915, tick.price)) {
      reason = `9:15 open stop · Nifty crossed back through ${open915.toFixed(2)}`;
      break;
    }
    if (
      isNineFifteenFlip916ExitWindow(tick.epochMs) &&
      shouldNineFifteenFlip916Exit(leg, open915, tick.price, pnlNow)
    ) {
      reason = `9:15:57 flip · not in profit · ≥${NINE_SIXTEEN_MIN_915_ABS_DIFF} pts vs the 9:15 open`;
      break;
    }
    if (shouldExitNineFifteenLossPct(pnlPct)) {
      reason = `Option P&L touched −${NINE_FIFTEEN_LOSS_EXIT_PCT}%`;
      break;
    }
    if (shouldHardStopNineSixteen(tick.price, entrySpot, leg, NINE_SIXTEEN_HARD_STOP_INDEX_POINTS, tick.epochMs)) {
      reason = `10:00 hard stop · ${NINE_SIXTEEN_HARD_STOP_INDEX_POINTS} pts against the fill`;
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

async function buildFresh(
  accessToken: string | null,
  skipPrev329Gap: boolean,
): Promise<PaperWsBacktestResult> {
  const dates = await listPaperWsTickDates();
  let sessionsError: string | null = null;
  const sessions = await loadPaperWsMinuteSessions(accessToken, dates).catch((err: unknown) => {
    sessionsError = err instanceof Error ? err.message : "Kite minute history unavailable";
    console.error("[paper-ws-backtest] minute sessions failed", err);
    return new Map<string, MinuteBar[]>();
  });
  const trades: PaperWsBacktestTrade[] = [];
  let cash = PAPER_STARTING_CASH;

  for (const dateIst of dates) {
    const day = await loadPaperWsDayTicks(dateIst);
    const prev = prevPaperWsSession(sessions, dateIst);
    const next = replayDay(dateIst, day, cash, prev.prevClose, prev.prevCandle, skipPrev329Gap);
    cash = next.cash;
    trades.push(next.trade);
  }

  trades.sort((a, b) => b.dateIST.localeCompare(a.dateIST));
  const closedPnl = trades.reduce((sum, row) => sum + (row.status === "closed" ? row.pnl ?? 0 : 0), 0);

  const gapNote = skipPrev329Gap
    ? "15:29 ±1 pt gap filter is off (paper toggle). "
    : "Entry includes live 15:29 ±1 pt gap vs that candle close. ";
  const prevDayNote = sessionsError
    ? `Yesterday's 15:29 candle could not be loaded from Kite (${sessionsError}) — connect Kite and Refresh. `
    : !accessToken
      ? "Kite is not connected, so yesterday's 15:29 candle and 15:30 close are missing. "
      : "";

  return {
    version: CACHE_VERSION,
    skipPrev329Gap,
    trades,
    datesWithWs: dates,
    startingCash: PAPER_STARTING_CASH,
    endingCash: Math.round(cash * 100) / 100,
    closedPnl: Math.round(closedPnl * 100) / 100,
    builtAt: new Date().toISOString(),
    note: `${prevDayNote}${gapNote}₹10,00,000 paper book, 9:15 only, on days with 9:15 websocket ticks (disk or morningWsTicks). Option exit uses archived LTP when present; otherwise ~${PAPER_WS_ATM_DELTA}× Nifty move from entry so P&L is not stuck at ₹0. Archive-only days replay through ~09:20; full disk files through 10:09.`,
  };
}

function readCache(
  skipPrev329Gap: boolean,
  allowStale = false,
  datesWithWs?: string[],
): PaperWsBacktestResult | null {
  const file = cacheFileFor(skipPrev329Gap);
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PaperWsBacktestResult;
    if (parsed.version !== CACHE_VERSION) return null;
    if (!!parsed.skipPrev329Gap !== skipPrev329Gap) return null;
    if (!parsed.builtAt) return null;
    if (!allowStale && Date.now() - Date.parse(parsed.builtAt) > CACHE_MS) return null;
    if (datesWithWs && (parsed.datesWithWs ?? []).join(",") !== datesWithWs.join(",")) return null;
    return parsed;
  } catch {
    return null;
  }
}

const inflightByMode = new Map<string, Promise<PaperWsBacktestResult>>();

function inflightKey(skipPrev329Gap: boolean): string {
  return skipPrev329Gap ? "no329" : "default";
}

export type PaperWsBacktestOptions = {
  skipPrev329Gap?: boolean;
};

export async function ensurePaperWsBacktest(
  accessToken: string | null,
  options: PaperWsBacktestOptions = {},
): Promise<PaperWsBacktestResult> {
  const skipPrev329Gap = options.skipPrev329Gap === true;
  const dates = await listPaperWsTickDates();
  const cached = readCache(skipPrev329Gap, true, dates);
  const fresh =
    cached != null &&
    Date.now() - Date.parse(cached.builtAt) <= CACHE_MS &&
    (cached.datesWithWs ?? []).join(",") === dates.join(",");
  if (cached && fresh) return cached;
  if (cached) {
    const key = inflightKey(skipPrev329Gap);
    if (!inflightByMode.has(key)) inflightByMode.set(key, rebuild(accessToken, skipPrev329Gap));
    return cached;
  }
  return rebuild(accessToken, skipPrev329Gap);
}

function rebuild(accessToken: string | null, skipPrev329Gap: boolean): Promise<PaperWsBacktestResult> {
  const key = inflightKey(skipPrev329Gap);
  let inflight = inflightByMode.get(key);
  if (!inflight) {
    inflight = buildFresh(accessToken, skipPrev329Gap)
      .then((fresh) => {
        try {
          fs.mkdirSync(CACHE_DIR, { recursive: true });
          fs.writeFileSync(cacheFileFor(skipPrev329Gap), JSON.stringify(fresh));
        } catch {
          /* cache is optional */
        }
        return fresh;
      })
      .finally(() => {
        inflightByMode.delete(key);
      });
    inflightByMode.set(key, inflight);
  }
  return inflight;
}
