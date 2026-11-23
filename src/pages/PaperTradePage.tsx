import { useCallback, useEffect, useMemo, useState } from "react";
import { History, RefreshCw } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { TradeLogsTable } from "@/pages/TradePage";
import { getIndianMarketContext } from "@/lib/market-time";
import { legLabel } from "@/lib/trade-calculations";
import type { BotTradeLog } from "@/types/trade-log";
import type { PaperWsBacktestResult, PaperWsBacktestTrade } from "@/types/paper-ws-backtest";
import { cn, formatCurrency, formatNumber, getChangeClass } from "@/lib/utils";
import "@/styles/trade-page.css";

type DateFilter = "today" | "all";
type Tab = "ws-backtest" | "ws-backtest-v2" | "live-paper";

const SKIP_329_STORAGE_KEY = "paper-ws-skip-329-gap";

function readSkip329FromStorage(): boolean {
  try {
    return localStorage.getItem(SKIP_329_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function formatClosedAt(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function WsBacktestTable({
  rows,
  showNiftyColumns,
}: {
  rows: PaperWsBacktestTrade[];
  showNiftyColumns?: boolean;
}) {
  return (
    <div className="table-wrap">
      <table className="trade-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Ticks</th>
            <th>Status</th>
            <th>Leg</th>
            {showNiftyColumns && (
              <>
                <th className="text-right">Nifty entry</th>
                <th className="text-right">Nifty exit</th>
              </>
            )}
            <th className="text-right">Lots</th>
            <th className="text-right">Entry ₹</th>
            <th className="text-right">Exit ₹</th>
            <th className="text-right">P&L</th>
            <th className="text-right">Cash after</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.dateIST}</td>
              <td className="text-sm text-muted" title={row.tickSource ?? undefined}>
                {row.tickSource ?? "—"}
                {row.wsTickCount > 0 ? ` (${row.wsTickCount})` : ""}
              </td>
              <td>
                <span
                  className={cn(
                    "trade-status",
                    row.status === "closed" && "trade-status--closed",
                    row.status === "skipped" && "trade-status--skipped",
                  )}
                >
                  {row.status}
                </span>
              </td>
              <td>{row.leg ? legLabel(row.leg) : "—"}</td>
              {showNiftyColumns && (
                <>
                  <td className="text-right">
                    {row.entrySpot != null ? formatNumber(row.entrySpot, 2) : "—"}
                  </td>
                  <td className="text-right">
                    {row.exitSpot != null ? formatNumber(row.exitSpot, 2) : "—"}
                  </td>
                </>
              )}
              <td className="text-right">{row.lots ?? "—"}</td>
              <td className="text-right">{row.entryPrice != null ? formatNumber(row.entryPrice, 2) : "—"}</td>
              <td className="text-right">{row.exitPrice != null ? formatNumber(row.exitPrice, 2) : "—"}</td>
              <td className={cn("text-right font-semibold", row.pnl != null && getChangeClass(row.pnl))}>
                {row.pnl != null ? formatCurrency(row.pnl) : "—"}
              </td>
              <td className="text-right">{row.cashAfter != null ? formatCurrency(row.cashAfter) : "—"}</td>
              <td className="text-sm text-muted" style={{ maxWidth: "22rem" }}>
                {row.skipOrExitReason ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PaperTradePage() {
  const [tab, setTab] = useState<Tab>("ws-backtest");
  const [trades, setTrades] = useState<BotTradeLog[]>([]);
  const [backtest, setBacktest] = useState<PaperWsBacktestResult | null>(null);
  const [backtestV2, setBacktestV2] = useState<PaperWsBacktestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [skipPrev329Gap, setSkipPrev329Gap] = useState(readSkip329FromStorage);

  const load = useCallback(async () => {
    const backtestUrl = skipPrev329Gap
      ? "/api/paper/ws-backtest?skip329Gap=1"
      : "/api/paper/ws-backtest";
    const [liveRes, btRes, btV2Res] = await Promise.allSettled([
      fetch("/api/paper/trades?wsReplay=1", { credentials: "include" }),
      fetch(backtestUrl, { credentials: "include" }),
      fetch("/api/paper/ws-backtest-v2", { credentials: "include" }),
    ]);
    const problems: string[] = [];

    if (liveRes.status === "fulfilled" && liveRes.value.ok) {
      const liveJson = await liveRes.value.json();
      setTrades(Array.isArray(liveJson.data) ? liveJson.data : []);
    } else if (liveRes.status === "rejected") {
      problems.push(liveRes.reason instanceof Error ? liveRes.reason.message : "Paper log request failed");
    } else {
      const liveJson = await liveRes.value.json().catch(() => ({}));
      problems.push(liveJson.error ?? "Paper log request failed");
    }

    if (btRes.status === "fulfilled" && btRes.value.ok) {
      const btJson = await btRes.value.json();
      setBacktest(btJson.data as PaperWsBacktestResult);
    } else if (btRes.status === "rejected") {
      problems.push(
        btRes.reason instanceof Error ? btRes.reason.message : "Backtest request failed — try Refresh",
      );
    } else {
      const btJson = await btRes.value.json().catch(() => ({}));
      problems.push(btJson.error ?? "Backtest request failed");
    }

    if (btV2Res.status === "fulfilled" && btV2Res.value.ok) {
      const v2Json = await btV2Res.value.json();
      setBacktestV2(v2Json.data as PaperWsBacktestResult);
    } else if (btV2Res.status === "rejected") {
      problems.push(
        btV2Res.reason instanceof Error ? btV2Res.reason.message : "Paper trades v2 backtest failed",
      );
    } else {
      const v2Json = await btV2Res.value.json().catch(() => ({}));
      problems.push(v2Json.error ?? "Paper trades v2 backtest failed");
    }

    setError(problems.length ? problems.join(" · ") : null);
  }, [skipPrev329Gap]);

  function toggleSkipPrev329Gap() {
    setLoading(true);
    setSkipPrev329Gap((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SKIP_329_STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    void load().finally(() => {
      if (!cancelled) setLoading(false);
    });
    const id = window.setInterval(() => void load(), 60000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [load]);

  const todayIST = getIndianMarketContext().dateIST;

  const filteredLive = useMemo(() => {
    return trades.filter((t) => dateFilter !== "today" || t.dateIST === todayIST);
  }, [trades, dateFilter, todayIST]);

  const activeBacktest = tab === "ws-backtest-v2" ? backtestV2 : backtest;

  const filteredBacktest = useMemo(() => {
    const rows = activeBacktest?.trades ?? [];
    return rows.filter((t) => dateFilter !== "today" || t.dateIST === todayIST);
  }, [activeBacktest, dateFilter, todayIST]);

  const wsClosedPnl = useMemo(() => {
    let sum = 0;
    let count = 0;
    for (const row of filteredBacktest) {
      if (row.status !== "closed" || row.pnl == null) continue;
      count += 1;
      sum += row.pnl;
    }
    return { sum, count };
  }, [filteredBacktest]);

  /** Win/loss from closed rows in the current date filter (Paper trades v2). */
  const v2FilteredStats = useMemo(() => {
    const closed = filteredBacktest.filter((t) => t.status === "closed");
    let wins = 0;
    let losses = 0;
    let breakeven = 0;
    for (const t of closed) {
      const p = t.pnl ?? 0;
      if (p > 1e-6) wins += 1;
      else if (p < -1e-6) losses += 1;
      else breakeven += 1;
    }
    return { tradesTaken: closed.length, wins, losses, breakeven };
  }, [filteredBacktest]);

  const liveClosedPnl = useMemo(() => {
    let sum = 0;
    let count = 0;
    for (const row of filteredLive) {
      if (row.status !== "closed" || row.pnl == null) continue;
      count += 1;
      sum += row.pnl;
    }
    return { sum, count };
  }, [filteredLive]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  return (
    <DashboardShell>
      <div className="trade-page">
        <header className="trade-page-head">
          <div>
            <h1 className="page-title">Paper trades</h1>
            <p className="page-subtitle text-muted">
              Original 9:15 bot backtest · Paper trades v2 (gap at open) · live paper log
            </p>
          </div>
          <div className="trade-page-actions">
            <span className="badge badge-success">Paper</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCw size={14} className={refreshing ? "spin" : undefined} />
              Refresh
            </button>
          </div>
        </header>

        {error && <p className="trade-page-error text-down">{error}</p>}

        <div className="trade-filter-row">
          <button
            type="button"
            className={cn("trade-filter-chip", tab === "ws-backtest" && "is-active")}
            onClick={() => setTab("ws-backtest")}
          >
            WS backtest
            <span className="trade-filter-count">{backtest?.datesWithWs.length ?? 0} days</span>
          </button>
          <button
            type="button"
            className={cn("trade-filter-chip", tab === "ws-backtest-v2" && "is-active")}
            onClick={() => setTab("ws-backtest-v2")}
            title="First 9:15 open tick vs prev close ±10 pts — CE above, PE below"
          >
            Paper trades v2
            <span className="trade-filter-count">{backtestV2?.datesWithWs.length ?? 0} days</span>
          </button>
          <button
            type="button"
            className={cn("trade-filter-chip", tab === "live-paper" && "is-active")}
            onClick={() => setTab("live-paper")}
          >
            Live paper log
            <span className="trade-filter-count">{trades.length}</span>
          </button>

          <span className="trade-filter-divider" aria-hidden="true" />

          {tab === "ws-backtest" && (
            <button
              type="button"
              className={cn("trade-filter-chip", skipPrev329Gap && "is-active")}
              title="When on, backtest ignores the green/red 15:29 ±1 pt open gap (live bot still uses it)."
              onClick={toggleSkipPrev329Gap}
            >
              Ignore 15:29 gap
            </button>
          )}

          <button
            type="button"
            className={cn("trade-filter-chip", dateFilter === "all" && "is-active")}
            onClick={() => setDateFilter("all")}
          >
            All dates
          </button>
          <button
            type="button"
            className={cn("trade-filter-chip", dateFilter === "today" && "is-active")}
            onClick={() => setDateFilter("today")}
          >
            Today
          </button>
        </div>

        {tab === "ws-backtest" && backtest?.note && (
          <p className="text-muted text-sm mb-4">{backtest.note}</p>
        )}
        {tab === "ws-backtest-v2" && backtestV2?.note && (
          <p className="text-muted text-sm mb-4">{backtestV2.note}</p>
        )}

        <div className="trade-summary-row">
          <div className="card trade-summary-card">
            <span className="trade-summary-label">
              {tab === "live-paper" ? "Live session logs" : "Backtest days"}
            </span>
            <span className="trade-summary-value">
              {tab === "live-paper" ? filteredLive.length : filteredBacktest.length}
            </span>
          </div>
          {tab === "ws-backtest-v2" && (
            <>
              <div className="card trade-summary-card">
                <span className="trade-summary-label">Trades taken</span>
                <span className="trade-summary-value">{v2FilteredStats.tradesTaken}</span>
                <span className="trade-summary-sub">closed positions</span>
              </div>
              <div className="card trade-summary-card">
                <span className="trade-summary-label">Wins</span>
                <span className="trade-summary-value text-up">{v2FilteredStats.wins}</span>
              </div>
              <div className="card trade-summary-card">
                <span className="trade-summary-label">Losses</span>
                <span className="trade-summary-value text-down">{v2FilteredStats.losses}</span>
                {v2FilteredStats.breakeven > 0 && (
                  <span className="trade-summary-sub">{v2FilteredStats.breakeven} flat</span>
                )}
              </div>
            </>
          )}
          <div className="card trade-summary-card">
            <span className="trade-summary-label">Closed P&L</span>
            <span
              className={cn(
                "trade-summary-value",
                getChangeClass(
                  tab === "live-paper" ? liveClosedPnl.sum : (activeBacktest?.closedPnl ?? wsClosedPnl.sum),
                ),
              )}
            >
              {formatCurrency(
                tab === "live-paper" ? liveClosedPnl.sum : (activeBacktest?.closedPnl ?? wsClosedPnl.sum),
              )}
            </span>
            <span className="trade-summary-sub">
              {tab === "live-paper" ? liveClosedPnl.count : wsClosedPnl.count} closed
            </span>
          </div>
          {tab !== "live-paper" && activeBacktest && (
            <div className="card trade-summary-card">
              <span className="trade-summary-label">Paper cash</span>
              <span className="trade-summary-value">{formatCurrency(activeBacktest.endingCash)}</span>
              <span className="trade-summary-sub">started {formatCurrency(activeBacktest.startingCash)}</span>
            </div>
          )}
        </div>

        <div className="card card-flush">
          {loading ? (
            <div className="spinner-center">
              <div className="spinner" />
            </div>
          ) : tab === "ws-backtest" || tab === "ws-backtest-v2" ? (
            filteredBacktest.length === 0 ? (
              <div className="trade-empty">
                <History size={28} />
                <p>No 9:15 websocket days yet.</p>
                <p className="text-muted text-sm">
                  Ticks come from local <code>data/ticks/ws-ticks-*.jsonl</code> and from Firestore{" "}
                  <code>morningWsTicks</code> (uploaded after each session).
                </p>
              </div>
            ) : (
              <WsBacktestTable rows={filteredBacktest} showNiftyColumns={tab === "ws-backtest-v2"} />
            )
          ) : filteredLive.length === 0 ? (
            <div className="trade-empty">
              <History size={28} />
              <p>No live paper bot logs yet.</p>
              <p className="text-muted text-sm">Today&apos;s 9:15 paper entries appear here after the bot runs.</p>
            </div>
          ) : (
            <>
              <p className="text-muted text-sm mb-3">
                Live bot rows plus <strong>[WS replay]</strong> days from saved ticks when the bot did not log a
                session. Connect Kite and Refresh so prev-day 15:30 data loads.
              </p>
              <TradeLogsTable
                rows={filteredLive}
                expandedId={expandedId}
                onToggle={(id) => setExpandedId((prev) => (prev === id ? null : id))}
                afterCharges={false}
                paperMode
              />
            </>
          )}
        </div>

        {(tab === "ws-backtest" || tab === "ws-backtest-v2") && activeBacktest?.builtAt && (
          <p className="text-muted text-sm mt-3">
            Backtest built {formatClosedAt(activeBacktest.builtAt)}
            {activeBacktest.datesWithWs.length > 0 && (
              <>
                {" "}
                · {activeBacktest.datesWithWs.length} days ({activeBacktest.datesWithWs[0]} →{" "}
                {activeBacktest.datesWithWs[activeBacktest.datesWithWs.length - 1]})
              </>
            )}
          </p>
        )}
      </div>
    </DashboardShell>
  );
}
