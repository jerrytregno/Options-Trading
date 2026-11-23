/**
 * Paper account for the 9:15 bot. Orders are filled locally at the last option price.
 * Nothing here is sent to Zerodha.
 */
import fs from "fs";
import path from "path";

export const PAPER_TRADING = true;
export const PAPER_STARTING_CASH = 1_000_000;

const FILE = path.join(process.cwd(), "data", "paper-account.json");
const MAX_FILLS_STORED = 2000;

export type PaperFillRecord = {
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  notional: number;
  at: string;
};

type Stored = {
  cash: number;
  fills?: PaperFillRecord[];
};

type PaperOrder = {
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
};

const orders = new Map<string, PaperOrder>();
const positions = new Map<string, number>();
let fillLedger: PaperFillRecord[] = [];
let cash = PAPER_STARTING_CASH;
let seq = 0;

function rebuildPositionsFromFills(fills: PaperFillRecord[]) {
  positions.clear();
  for (const fill of fills) {
    if (fill.side === "BUY") {
      positions.set(fill.symbol, (positions.get(fill.symbol) ?? 0) + fill.quantity);
    } else {
      const left = (positions.get(fill.symbol) ?? 0) - fill.quantity;
      if (left > 0) positions.set(fill.symbol, left);
      else positions.delete(fill.symbol);
    }
  }
}

function load() {
  try {
    if (!fs.existsSync(FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8")) as Stored;
    if (Number.isFinite(parsed.cash) && parsed.cash >= 0) cash = parsed.cash;
    fillLedger = Array.isArray(parsed.fills) ? parsed.fills : [];
    rebuildPositionsFromFills(fillLedger);
  } catch {
    cash = PAPER_STARTING_CASH;
    fillLedger = [];
    positions.clear();
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const payload: Stored = {
      cash,
      fills: fillLedger.slice(-MAX_FILLS_STORED),
    };
    fs.writeFileSync(FILE, JSON.stringify(payload, null, 2));
  } catch {
    /* a missed save only affects the next restart */
  }
}

load();

export function paperCash(): number {
  return cash;
}

export function paperStartingCash(): number {
  return PAPER_STARTING_CASH;
}

export function paperPositionQty(symbol: string): number {
  return positions.get(symbol) ?? 0;
}

export function paperListPositions(): { symbol: string; quantity: number }[] {
  return [...positions.entries()]
    .filter(([, qty]) => qty > 0)
    .map(([symbol, quantity]) => ({ symbol, quantity }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Newest first. */
export function paperListFills(limit = 500): PaperFillRecord[] {
  return [...fillLedger].reverse().slice(0, limit);
}

/** Re-attach a position the bot already restored from its own state. Cash is left as saved. */
export function paperRememberPosition(symbol: string, quantity: number) {
  if (!symbol || quantity <= 0) return;
  positions.set(symbol, quantity);
}

export function paperOrderFill(orderId: string): { average_price: number; filled_quantity: number } | null {
  const order = orders.get(orderId);
  if (!order) return null;
  return { average_price: order.price, filled_quantity: order.quantity };
}

export function isPaperOrderId(orderId: string): boolean {
  return orderId.startsWith("paper-");
}

/**
 * Fill a market order at `price`. A buy is refused when the premium is more than the cash left.
 */
export function paperFillMarket(input: {
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
}): string {
  const { symbol, side, quantity, price } = input;
  if (!(quantity > 0) || !(price > 0)) {
    throw new Error("Paper order needs a quantity and a live option price");
  }
  let fillQty = quantity;
  if (side === "BUY") {
    const notional = price * quantity;
    if (notional > cash + 1e-6) {
      throw new Error(`Paper funds short · required ₹${Math.ceil(notional)} · available ₹${Math.floor(cash)}`);
    }
    cash -= notional;
    positions.set(symbol, (positions.get(symbol) ?? 0) + quantity);
  } else {
    const held = positions.get(symbol) ?? 0;
    fillQty = Math.min(quantity, held);
    if (fillQty <= 0) throw new Error("Paper account has no position to sell");
    const notional = price * fillQty;
    cash += notional;
    const left = held - fillQty;
    if (left > 0) positions.set(symbol, left);
    else positions.delete(symbol);
  }
  seq += 1;
  const orderId = `paper-${Date.now()}-${seq}`;
  orders.set(orderId, { orderId, symbol, side, quantity: fillQty, price });
  const notional = price * fillQty;
  fillLedger.push({
    orderId,
    symbol,
    side,
    quantity: fillQty,
    price,
    notional,
    at: new Date().toISOString(),
  });
  save();
  return orderId;
}
