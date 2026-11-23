import { loadBotTradeLogs } from "./bot-trade-log.js";
import { ensurePaperWsBacktest } from "./nine-fifteen-ws-backtest.js";
import { getNineSixteenBotStatusLive } from "./nine-sixteen-bot.js";
import type { PaperWsBacktestTrade } from "../src/types/paper-ws-backtest.js";
import {
  PAPER_STARTING_CASH,
  PAPER_TRADING,
  paperCash,
  paperListFills,
  paperListPositions,
  type PaperFillRecord,
} from "./paper-book.js";
import type { BotTradeLog } from "../src/types/trade-log.js";

export type PaperPositionRow = {
  symbol: string;
  quantity: number;
  averagePrice: number | null;
  lastPrice: number | null;
  unrealisedPnl: number | null;
  deployed: number | null;
};

export type PaperPortfolioSnapshot = {
  paperTrading: boolean;
  startingCash: number;
  cash: number;
  positionsValue: number;
  unrealisedPnl: number;
  closedPnl: number;
  equity: number;
  returnPct: number;
  positions: PaperPositionRow[];
  fills: PaperFillRecord[];
  openBotLeg: {
    phase: string;
    tradingsymbol: string | null;
    quantity: number | null;
    entryPrice: number | null;
    lastOptionPrice: number | null;
    unrealisedPnl: number | null;
  } | null;
  updatedAt: string;
};

function isPaperTradeLog(row: BotTradeLog): boolean {
  if (row.isPaper === true) return true;
  if (row.message?.includes("[9:15]")) return true;
  return false;
}

export async function listPaperTradeLogs(): Promise<{ trades: BotTradeLog[]; updatedAt: string | null }> {
  const store = await loadBotTradeLogs();
  const trades = store.trades.filter(isPaperTradeLog);
  return { trades, updatedAt: store.updatedAt };
}

function wsReplayRowAsTradeLog(row: PaperWsBacktestTrade): BotTradeLog {
  const status: BotTradeLog["status"] =
    row.status === "closed" ? "closed" : row.status === "skipped" ? "skipped" : "no_entry";
  return {
    id: `${row.dateIST}-paper-ws-replay`,
    source: "nine-sixteen",
    dateIST: row.dateIST,
    status,
    leg: row.leg,
    tradingsymbol: null,
    quantity: row.quantity,
    open915: row.open915,
    close915: null,
    change915: null,
    entrySpot: row.entrySpot,
    targetSpot: null,
    entryPrice: row.entryPrice,
    exitPrice: row.exitPrice,
    exitSpot: row.exitSpot,
    pnl: row.pnl,
    exitReason: row.skipOrExitReason,
    message: `[WS replay] ${row.skipOrExitReason ?? row.status}`,
    logs: [],
    createdAt: `${row.dateIST}T03:45:00.000Z`,
    closedAt: row.exitTimeIst ? `${row.dateIST}T09:30:00+05:30` : null,
    entryTimeIst: row.entryTimeIst,
    exitTimeIst: row.exitTimeIst,
    isPaper: true,
  };
}

/** Live bot log plus tick replay for days the bot never logged (e.g. after an outage). */
export async function listPaperTradeLogsForDisplay(
  accessToken: string | null,
  options: { wsReplay?: boolean } = {},
): Promise<{ trades: BotTradeLog[]; updatedAt: string | null }> {
  const base = await listPaperTradeLogs();
  if (!options.wsReplay) return base;

  const bt = await ensurePaperWsBacktest(accessToken);
  const loggedDates = new Set(base.trades.map((t) => t.dateIST));
  const extra = bt.trades
    .filter(
      (row) =>
        (row.status === "closed" || row.status === "skipped" || row.status === "no_entry") &&
        !loggedDates.has(row.dateIST),
    )
    .map(wsReplayRowAsTradeLog);

  const merged = [...base.trades, ...extra].sort((a, b) => {
    const byDate = b.dateIST.localeCompare(a.dateIST);
    if (byDate !== 0) return byDate;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  return { trades: merged, updatedAt: base.updatedAt ?? bt.builtAt };
}

function avgBuyPriceForSymbol(fills: PaperFillRecord[], symbol: string): number | null {
  let qty = 0;
  let cost = 0;
  for (const fill of fills) {
    if (fill.symbol !== symbol || fill.side !== "BUY") continue;
    qty += fill.quantity;
    cost += fill.notional;
  }
  if (qty <= 0) return null;
  return cost / qty;
}

export async function buildPaperPortfolioSnapshot(): Promise<PaperPortfolioSnapshot> {
  const [status, { trades }] = await Promise.all([getNineSixteenBotStatusLive(), listPaperTradeLogs()]);

  const closedPnl = trades
    .filter((t) => t.status === "closed" && t.pnl != null)
    .reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  const fillsAsc = [...paperListFills(2000)].reverse();
  const bookPositions = paperListPositions();

  const positions: PaperPositionRow[] = bookPositions.map(({ symbol, quantity }) => {
    const avg = avgBuyPriceForSymbol(fillsAsc, symbol);
    const isBotOpen =
      status.tradingsymbol === symbol &&
      status.quantity != null &&
      status.quantity > 0 &&
      (status.phase === "in_position" || status.phase === "exiting");
    const last =
      isBotOpen && status.lastOptionPrice != null && status.lastOptionPrice > 0
        ? status.lastOptionPrice
        : avg;
    const deployed = avg != null ? avg * quantity : null;
    const unrealised =
      avg != null && last != null ? (last - avg) * quantity : isBotOpen ? status.unrealisedPnl : null;
    return {
      symbol,
      quantity,
      averagePrice: isBotOpen && status.entryPrice != null ? status.entryPrice : avg,
      lastPrice: last,
      unrealisedPnl: unrealised,
      deployed,
    };
  });

  let positionsValue = 0;
  let unrealisedPnl = 0;
  for (const row of positions) {
    if (row.lastPrice != null) positionsValue += row.lastPrice * row.quantity;
    if (row.unrealisedPnl != null) unrealisedPnl += row.unrealisedPnl;
  }

  const cash = paperCash();
  const equity = cash + positionsValue;
  const starting = PAPER_STARTING_CASH;
  const returnPct = starting > 0 ? ((equity - starting) / starting) * 100 : 0;

  const openBotLeg =
    status.phase === "in_position" || status.phase === "exiting"
      ? {
          phase: status.phase,
          tradingsymbol: status.tradingsymbol,
          quantity: status.quantity,
          entryPrice: status.entryPrice,
          lastOptionPrice: status.lastOptionPrice,
          unrealisedPnl: status.unrealisedPnl,
        }
      : null;

  return {
    paperTrading: PAPER_TRADING,
    startingCash: starting,
    cash,
    positionsValue,
    unrealisedPnl,
    closedPnl,
    equity,
    returnPct,
    positions,
    fills: paperListFills(200),
    openBotLeg,
    updatedAt: new Date().toISOString(),
  };
}
