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
  await pool.query(`ALTER TABLE trading_signals ADD COLUMN IF NOT EXISTS condition_id TEXT`);
  await pool.query(`ALTER TABLE trading_signals ADD COLUMN IF NOT EXISTS condition_label TEXT`);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_assessments (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      score NUMERIC,
      recommendation TEXT NOT NULL,
      confidence NUMERIC,
      rationale TEXT,
      model TEXT NOT NULL
    )
  `);

  await pool.query(`ALTER TABLE ai_assessments ADD COLUMN IF NOT EXISTS adjusted_entry_price NUMERIC`);
  await pool.query(`ALTER TABLE ai_assessments ADD COLUMN IF NOT EXISTS adjusted_exit_price NUMERIC`);
}

export async function saveSignal(pool: Pool, signal: SignalResult): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO trading_signals (symbol, price, sma_fast, sma_slow, rsi, momentum, estimated_entry_price, estimated_exit_price, signal, reason, condition_id, condition_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
      signal.conditionId,
      signal.conditionLabel,
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
  conditionId: string | null;
  conditionLabel: string | null;
}

export async function getLatestSignals(pool: Pool): Promise<LatestSignalRow[]> {
  const result = await pool.query(`
    SELECT DISTINCT ON (symbol) symbol, ts, price, sma_fast, sma_slow, rsi, momentum, estimated_entry_price, estimated_exit_price, signal, reason, condition_id, condition_label
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
    conditionId: row.condition_id,
    conditionLabel: row.condition_label,
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

export interface AiAssessmentRecord {
  symbol: string;
  score: number | null;
  recommendation: 'buy' | 'hold' | 'avoid';
  confidence: number | null;
  rationale: string;
  model: string;
  adjustedEntryPrice: number | null;
  adjustedExitPrice: number | null;
}

export async function saveAssessment(pool: Pool, assessment: AiAssessmentRecord): Promise<void> {
  await pool.query(
    `INSERT INTO ai_assessments (symbol, score, recommendation, confidence, rationale, model, adjusted_entry_price, adjusted_exit_price)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      assessment.symbol,
      assessment.score,
      assessment.recommendation,
      assessment.confidence,
      assessment.rationale,
      assessment.model,
      assessment.adjustedEntryPrice,
      assessment.adjustedExitPrice,
    ]
  );
}

export interface LatestAssessmentRow {
  symbol: string;
  ts: string;
  score: number | null;
  recommendation: string;
  confidence: number | null;
  rationale: string | null;
  model: string;
  adjustedEntryPrice: number | null;
  adjustedExitPrice: number | null;
}

export async function getLatestAssessments(pool: Pool): Promise<LatestAssessmentRow[]> {
  const result = await pool.query(`
    SELECT DISTINCT ON (symbol) symbol, ts, score, recommendation, confidence, rationale, model, adjusted_entry_price, adjusted_exit_price
    FROM ai_assessments
    ORDER BY symbol, ts DESC
  `);

  return result.rows.map((row) => ({
    symbol: row.symbol,
    ts: row.ts,
    score: row.score !== null ? Number(row.score) : null,
    recommendation: row.recommendation,
    confidence: row.confidence !== null ? Number(row.confidence) : null,
    rationale: row.rationale,
    model: row.model,
    adjustedEntryPrice: row.adjusted_entry_price !== null ? Number(row.adjusted_entry_price) : null,
    adjustedExitPrice: row.adjusted_exit_price !== null ? Number(row.adjusted_exit_price) : null,
  }));
}
