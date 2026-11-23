import type { TradeLeg } from "../lib/trade-calculations.js";

export type PaperWsBacktestStatus = "closed" | "skipped" | "no_entry";

export type PaperWsBacktestTrade = {
  id: string;
  dateIST: string;
  status: PaperWsBacktestStatus;
  leg: TradeLeg | null;
  lots: number | null;
  quantity: number | null;
  open915: number | null;
  mark915: number | null;
  entrySpot: number | null;
  exitSpot: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  prevClose: number | null;
  prev329Open: number | null;
  prev329Close: number | null;
  gapFromPrevClose: number | null;
  move10sPts: number | null;
  skipOrExitReason: string | null;
  indexPnlPts: number | null;
  pnl: number | null;
  cashAfter: number | null;
  entryTimeIst: string | null;
  exitTimeIst: string | null;
  wsTickCount: number;
  tickSource?: "disk" | "firestore" | "storage" | "none";
  source: "ws-backtest" | "paper-trades-v2-ws" | "paper-trades-v3-ohlc";
};

export type PaperWsBacktestStats = {
  /** Days with a position opened and closed (same as closed row count). */
  tradesTaken: number;
  wins: number;
  losses: number;
  /** Closed with ₹0 option P&L after costs rounding. */
  breakeven: number;
  /** Paper v3 OHLC: closed days where index TP hit first. */
  winDaysByIndex?: number;
  /** Paper v3 OHLC: closed days where index SL or EOD exit. */
  lossDaysByIndex?: number;
};

export type PaperWsBacktestResult = {
  version?: number;
  /** When true, entry ignored the 15:29 ±1 pt gap (paper WS backtest toggle). */
  skipPrev329Gap?: boolean;
  /** Paper trades v2 — first 9:15 open vs prev close ≥10 pts gap. */
  variant?: "default" | "gap-open-v2" | "gap-open-v3-ohlc";
  stats?: PaperWsBacktestStats;
  trades: PaperWsBacktestTrade[];
  datesWithWs: string[];
  startingCash: number;
  endingCash: number;
  closedPnl: number;
  builtAt: string;
  note: string;
  /** Paper v3 OHLC: dates that ended as index TP wins. */
  winDates?: string[];
  /** Paper v3 OHLC: dates that ended as index SL or EOD. */
  lossDates?: string[];
};
