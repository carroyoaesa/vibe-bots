import { Pool } from 'pg';
import { SignalResult } from '../strategy/signals';

export async function setupTradingSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_signals (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      price NUMERIC NOT NULL,
      sma_fast NUMERIC,
      sma_slow NUMERIC,
      rsi NUMERIC,
      momentum NUMERIC,
      signal TEXT NOT NULL,
      reason TEXT
    )
  `);

  await pool.query(`ALTER TABLE trading_signals ADD COLUMN IF NOT EXISTS estimated_entry_price NUMERIC`);
  await pool.query(`ALTER TABLE trading_signals ADD COLUMN IF NOT EXISTS estimated_exit_price NUMERIC`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_orders (
      id SERIAL PRIMARY KEY,
      signal_id INTEGER REFERENCES trading_signals(id),
      symbol TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      side TEXT NOT NULL,
      qty NUMERIC NOT NULL,
      order_type TEXT NOT NULL,
      alpaca_order_id TEXT,
      take_profit_price NUMERIC,
      stop_loss_price NUMERIC,
      status TEXT NOT NULL,
      raw JSONB
    )
  `);
}

export async function saveSignal(pool: Pool, signal: SignalResult): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO trading_signals (symbol, price, sma_fast, sma_slow, rsi, momentum, estimated_entry_price, estimated_exit_price, signal, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      signal.symbol,
      signal.price,
      signal.smaFast,
      signal.smaSlow,
      signal.rsi,
      signal.momentum,
      signal.estimatedEntryPrice,
      signal.estimatedExitPrice,
      signal.signal,
      signal.reason,
    ]
  );

  return result.rows[0].id;
}

export interface TradingOrderRecord {
  signalId: number;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  orderType: string;
  alpacaOrderId?: string;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  status: string;
  raw?: unknown;
}

export async function saveOrder(pool: Pool, order: TradingOrderRecord): Promise<void> {
  await pool.query(
    `INSERT INTO trading_orders
       (signal_id, symbol, side, qty, order_type, alpaca_order_id, take_profit_price, stop_loss_price, status, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      order.signalId,
      order.symbol,
      order.side,
      order.qty,
      order.orderType,
      order.alpacaOrderId ?? null,
      order.takeProfitPrice ?? null,
      order.stopLossPrice ?? null,
      order.status,
      order.raw ? JSON.stringify(order.raw) : null,
    ]
  );
}

export interface LatestSignalRow {
  symbol: string;
  ts: string;
  price: number;
  smaFast: number | null;
  smaSlow: number | null;
  rsi: number | null;
  momentum: number | null;
  estimatedEntryPrice: number | null;
  estimatedExitPrice: number | null;
  signal: string;
  reason: string;
}

export async function getLatestSignals(pool: Pool): Promise<LatestSignalRow[]> {
  const result = await pool.query(`
    SELECT DISTINCT ON (symbol) symbol, ts, price, sma_fast, sma_slow, rsi, momentum, estimated_entry_price, estimated_exit_price, signal, reason
    FROM trading_signals
    ORDER BY symbol, ts DESC
  `);

  return result.rows.map((row) => ({
    symbol: row.symbol,
    ts: row.ts,
    price: Number(row.price),
    smaFast: row.sma_fast !== null ? Number(row.sma_fast) : null,
    smaSlow: row.sma_slow !== null ? Number(row.sma_slow) : null,
    rsi: row.rsi !== null ? Number(row.rsi) : null,
    momentum: row.momentum !== null ? Number(row.momentum) : null,
    estimatedEntryPrice: row.estimated_entry_price !== null ? Number(row.estimated_entry_price) : null,
    estimatedExitPrice: row.estimated_exit_price !== null ? Number(row.estimated_exit_price) : null,
    signal: row.signal,
    reason: row.reason,
  }));
}

export interface RecentOrderRow {
  id: number;
  symbol: string;
  ts: string;
  side: string;
  qty: number;
  orderType: string;
  alpacaOrderId: string | null;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  status: string;
}

export async function getRecentOrders(pool: Pool, limit: number): Promise<RecentOrderRow[]> {
  const result = await pool.query(
    `SELECT id, symbol, ts, side, qty, order_type, alpaca_order_id, take_profit_price, stop_loss_price, status
     FROM trading_orders
     ORDER BY ts DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    symbol: row.symbol,
    ts: row.ts,
    side: row.side,
    qty: Number(row.qty),
    orderType: row.order_type,
    alpacaOrderId: row.alpaca_order_id,
    takeProfitPrice: row.take_profit_price !== null ? Number(row.take_profit_price) : null,
    stopLossPrice: row.stop_loss_price !== null ? Number(row.stop_loss_price) : null,
    status: row.status,
  }));
}
