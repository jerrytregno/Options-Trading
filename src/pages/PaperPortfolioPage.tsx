import { useCallback, useEffect, useState } from "react";
import { Radio, RefreshCw } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { getIndianMarketContext } from "@/lib/market-time";
import { cn, formatCurrency, formatNumber, getChangeClass } from "@/lib/utils";

type PaperFill = {
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  notional: number;
  at: string;
};

type PaperPosition = {
  symbol: string;
  quantity: number;
  averagePrice: number | null;
  lastPrice: number | null;
  unrealisedPnl: number | null;
  deployed: number | null;
};

type PaperPortfolio = {
  paperTrading: boolean;
  startingCash: number;
  cash: number;
  positionsValue: number;
  unrealisedPnl: number;
  closedPnl: number;
  equity: number;
  returnPct: number;
  positions: PaperPosition[];
  fills: PaperFill[];
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

type Tab = "positions" | "orders";

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function PaperPortfolioPage() {
  const [data, setData] = useState<PaperPortfolio | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("positions");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/paper/portfolio", { credentials: "include" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load paper portfolio");
      setData(json.data as PaperPortfolio);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().finally(() => {
      if (!cancelled) setLoading(false);
    });
    const pollMs = getIndianMarketContext().isMarketOpen ? 4000 : 15000;
    const id = window.setInterval(() => void load(), pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [load]);

  return (
    <DashboardShell>
      <div className="flex-between flex-wrap gap-4 mb-8">
        <div className="page-header" style={{ marginBottom: 0 }}>
          <h1>Paper portfolio</h1>
          <p>Simulated ₹10L account · 9:15 bot only · no live Kite orders</p>
        </div>
        {data && (
          <div className="text-right">
            <div className="flex gap-2 items-center justify-end mb-1">
              <span className="badge badge-success">
                <Radio size={12} />
                Paper
              </span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
                <RefreshCw size={14} />
              </button>
              <span className="text-muted text-sm">Updated {formatTime(data.updatedAt)}</span>
            </div>
            <p className="text-muted text-sm">Total equity</p>
            <p className={cn("font-bold", getChangeClass(data.equity - data.startingCash))} style={{ fontSize: "1.5rem" }}>
              {formatCurrency(data.equity)}
            </p>
            <p className="text-muted text-sm mt-3">
              Cash {formatCurrency(data.cash)} · Open {formatCurrency(data.positionsValue)} · Closed P&L{" "}
              {formatCurrency(data.closedPnl)}
            </p>
            <p className={cn("text-sm mt-1", getChangeClass(data.returnPct))}>
              {data.returnPct >= 0 ? "+" : ""}
              {formatNumber(data.returnPct, 2)}% vs ₹10L start
            </p>
          </div>
        )}
      </div>

      {error && <p className="text-down mb-4">{error}</p>}

      {!data?.paperTrading && !loading && (
        <div className="card mb-6">
          <p className="text-muted">Paper trading is off on the server — live Kite portfolio is on the Portfolio page.</p>
        </div>
      )}

      <div className="flex gap-2 flex-wrap mb-6">
        <button
          type="button"
          className={`btn btn-sm ${tab === "positions" ? "btn-primary" : "btn-outline"}`}
          onClick={() => setTab("positions")}
        >
          Positions ({data?.positions.length ?? 0})
        </button>
        <button
          type="button"
          className={`btn btn-sm ${tab === "orders" ? "btn-primary" : "btn-outline"}`}
          onClick={() => setTab("orders")}
        >
          Fills ({data?.fills.length ?? 0})
        </button>
      </div>

      <div className="card card-flush">
        {loading ? (
          <div className="spinner-center">
            <div className="spinner" />
          </div>
        ) : tab === "positions" ? (
          data!.positions.length === 0 ? (
            <p className="text-muted p-6">No open paper positions.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Avg</th>
                    <th className="text-right">LTP</th>
                    <th className="text-right">Deployed</th>
                    <th className="text-right">Unrealised P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.positions.map((row) => (
                    <tr key={row.symbol}>
                      <td className="font-medium">{row.symbol}</td>
                      <td className="text-right">{row.quantity}</td>
                      <td className="text-right">
                        {row.averagePrice != null ? formatNumber(row.averagePrice, 2) : "—"}
                      </td>
                      <td className="text-right">
                        {row.lastPrice != null ? formatNumber(row.lastPrice, 2) : "—"}
                      </td>
                      <td className="text-right">
                        {row.deployed != null ? formatCurrency(row.deployed) : "—"}
                      </td>
                      <td className={cn("text-right font-semibold", row.unrealisedPnl != null && getChangeClass(row.unrealisedPnl))}>
                        {row.unrealisedPnl != null ? formatCurrency(row.unrealisedPnl) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : data!.fills.length === 0 ? (
          <p className="text-muted p-6">No simulated fills yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Side</th>
                  <th>Symbol</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Price</th>
                  <th className="text-right">Notional</th>
                  <th>Order</th>
                </tr>
              </thead>
              <tbody>
                {data!.fills.map((fill) => (
                  <tr key={fill.orderId}>
                    <td className="text-muted text-sm">{formatTime(fill.at)}</td>
                    <td>
                      <span className={cn("badge", fill.side === "BUY" ? "badge-success" : "badge-warning")}>
                        {fill.side}
                      </span>
                    </td>
                    <td className="font-medium">{fill.symbol}</td>
                    <td className="text-right">{fill.quantity}</td>
                    <td className="text-right">{formatNumber(fill.price, 2)}</td>
                    <td className="text-right">{formatCurrency(fill.notional)}</td>
                    <td className="text-muted text-sm">{fill.orderId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data?.openBotLeg && (
        <div className="card mt-6">
          <h2 className="font-semibold mb-2" style={{ fontSize: "1rem" }}>
            Live bot leg
          </h2>
          <p className="text-muted text-sm">
            {data.openBotLeg.phase} · {data.openBotLeg.tradingsymbol ?? "—"} · {data.openBotLeg.quantity ?? 0} qty ·
            entry ₹{data.openBotLeg.entryPrice != null ? formatNumber(data.openBotLeg.entryPrice, 2) : "—"} · mark ₹
            {data.openBotLeg.lastOptionPrice != null ? formatNumber(data.openBotLeg.lastOptionPrice, 2) : "—"} · P&L{" "}
            {data.openBotLeg.unrealisedPnl != null ? formatCurrency(data.openBotLeg.unrealisedPnl) : "—"}
          </p>
        </div>
      )}
    </DashboardShell>
  );
}
