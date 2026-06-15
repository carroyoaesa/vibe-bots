import { Pool } from 'pg';

/**
 * Fase 6 (multi-condicional por símbolo) + Fase 7 (condición de compra y de venta
 * separadas, `bots/backtests/src/runComboMatrix.ts`): qué par (condición de compra,
 * condición de venta) de `strategy/conditions.ts` (`CONDITIONS`) usa cada símbolo del
 * watchlist, según el resultado de su propio backtest (`npm run backtest` ->
 * `runBacktestForWatchlist`). Se lee sin caché en cada ciclo de trading/
 * `/api/trading/status`, igual que `bot_settings` (Fase 5).
 */
export async function setupConditionSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS symbol_conditions (
      symbol TEXT PRIMARY KEY,
      buy_condition_id TEXT NOT NULL DEFAULT 'sma_cross_10_30',
      buy_condition_label TEXT NOT NULL DEFAULT 'Cruce SMA10/SMA30 + RSI<70 + Momentum>0',
      sell_condition_id TEXT NOT NULL DEFAULT 'sma_cross_10_30',
      sell_condition_label TEXT NOT NULL DEFAULT 'Cruce SMA10/SMA30 + RSI<70 + Momentum>0',
      trades INTEGER NOT NULL,
      win_rate_pct NUMERIC,
      total_return_pct NUMERIC,
      avg_return_pct NUMERIC,
      max_drawdown_pct NUMERIC,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Fase 7: migra symbol_conditions de "una condición por símbolo" a "compra/venta
  // separadas" - las filas existentes quedan con sma_cross_10_30 (= condición previa
  // para compra y venta) hasta el próximo `npm run backtest`.
  await pool.query(`ALTER TABLE symbol_conditions ADD COLUMN IF NOT EXISTS buy_condition_id TEXT NOT NULL DEFAULT 'sma_cross_10_30'`);
  await pool.query(`ALTER TABLE symbol_conditions ADD COLUMN IF NOT EXISTS buy_condition_label TEXT NOT NULL DEFAULT 'Cruce SMA10/SMA30 + RSI<70 + Momentum>0'`);
  await pool.query(`ALTER TABLE symbol_conditions ADD COLUMN IF NOT EXISTS sell_condition_id TEXT NOT NULL DEFAULT 'sma_cross_10_30'`);
  await pool.query(`ALTER TABLE symbol_conditions ADD COLUMN IF NOT EXISTS sell_condition_label TEXT NOT NULL DEFAULT 'Cruce SMA10/SMA30 + RSI<70 + Momentum>0'`);
  await pool.query(`ALTER TABLE symbol_conditions DROP COLUMN IF EXISTS condition_id`);
  await pool.query(`ALTER TABLE symbol_conditions DROP COLUMN IF EXISTS condition_label`);
}

export interface SymbolConditionPick {
  symbol: string;
  buyConditionId: string;
  buyConditionLabel: string;
  sellConditionId: string;
  sellConditionLabel: string;
  trades: number;
  winRatePct: number | null;
  totalReturnPct: number;
  avgReturnPct: number | null;
  maxDrawdownPct: number;
}

export interface SymbolConditionRow extends SymbolConditionPick {
  updatedAt: string;
}

/** Upsert del par (condición de compra, condición de venta) ganador por símbolo (llamado al final de `runBacktestForWatchlist`). */
export async function saveSymbolConditions(pool: Pool, picks: SymbolConditionPick[]): Promise<void> {
  for (const pick of picks) {
    await pool.query(
      `INSERT INTO symbol_conditions (symbol, buy_condition_id, buy_condition_label, sell_condition_id, sell_condition_label, trades, win_rate_pct, total_return_pct, avg_return_pct, max_drawdown_pct, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (symbol) DO UPDATE SET
         buy_condition_id = EXCLUDED.buy_condition_id,
         buy_condition_label = EXCLUDED.buy_condition_label,
         sell_condition_id = EXCLUDED.sell_condition_id,
         sell_condition_label = EXCLUDED.sell_condition_label,
         trades = EXCLUDED.trades,
         win_rate_pct = EXCLUDED.win_rate_pct,
         total_return_pct = EXCLUDED.total_return_pct,
         avg_return_pct = EXCLUDED.avg_return_pct,
         max_drawdown_pct = EXCLUDED.max_drawdown_pct,
         updated_at = NOW()`,
      [
        pick.symbol,
        pick.buyConditionId,
        pick.buyConditionLabel,
        pick.sellConditionId,
        pick.sellConditionLabel,
        pick.trades,
        pick.winRatePct,
        pick.totalReturnPct,
        pick.avgReturnPct,
        pick.maxDrawdownPct,
      ]
    );
  }
}

/** Par (condición de compra, condición de venta) activo por símbolo. Si un símbolo no tiene fila (antes del primer `npm run backtest`), usar `DEFAULT_CONDITION_ID` para ambas. */
export async function getSymbolConditions(pool: Pool): Promise<Map<string, SymbolConditionRow>> {
  const result = await pool.query(
    `SELECT symbol, buy_condition_id, buy_condition_label, sell_condition_id, sell_condition_label, trades, win_rate_pct, total_return_pct, avg_return_pct, max_drawdown_pct, updated_at
     FROM symbol_conditions`
  );

  const map = new Map<string, SymbolConditionRow>();
  for (const row of result.rows) {
    map.set(row.symbol, {
      symbol: row.symbol,
      buyConditionId: row.buy_condition_id,
      buyConditionLabel: row.buy_condition_label,
      sellConditionId: row.sell_condition_id,
      sellConditionLabel: row.sell_condition_label,
      trades: Number(row.trades),
      winRatePct: row.win_rate_pct !== null ? Number(row.win_rate_pct) : null,
      totalReturnPct: Number(row.total_return_pct),
      avgReturnPct: row.avg_return_pct !== null ? Number(row.avg_return_pct) : null,
      maxDrawdownPct: Number(row.max_drawdown_pct),
      updatedAt: new Date(row.updated_at).toISOString(),
    });
  }
  return map;
}
