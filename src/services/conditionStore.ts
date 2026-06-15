import { Pool } from 'pg';

/**
 * Fase 6 (multi-condicional por símbolo): qué condición de `strategy/conditions.ts`
 * (`CONDITIONS`) usa cada símbolo del watchlist, según el resultado de su propio
 * backtest (`npm run backtest` -> `runBacktestForWatchlist`). Se lee sin caché en
 * cada ciclo de trading/`/api/trading/status`, igual que `bot_settings` (Fase 5).
 */
export async function setupConditionSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS symbol_conditions (
      symbol TEXT PRIMARY KEY,
      condition_id TEXT NOT NULL,
      condition_label TEXT NOT NULL,
      trades INTEGER NOT NULL,
      win_rate_pct NUMERIC,
      total_return_pct NUMERIC,
      avg_return_pct NUMERIC,
      max_drawdown_pct NUMERIC,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export interface SymbolConditionPick {
  symbol: string;
  conditionId: string;
  conditionLabel: string;
  trades: number;
  winRatePct: number | null;
  totalReturnPct: number;
  avgReturnPct: number | null;
  maxDrawdownPct: number;
}

export interface SymbolConditionRow extends SymbolConditionPick {
  updatedAt: string;
}

/** Upsert de la condición ganadora por símbolo (llamado al final de `runBacktestForWatchlist`). */
export async function saveSymbolConditions(pool: Pool, picks: SymbolConditionPick[]): Promise<void> {
  for (const pick of picks) {
    await pool.query(
      `INSERT INTO symbol_conditions (symbol, condition_id, condition_label, trades, win_rate_pct, total_return_pct, avg_return_pct, max_drawdown_pct, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (symbol) DO UPDATE SET
         condition_id = EXCLUDED.condition_id,
         condition_label = EXCLUDED.condition_label,
         trades = EXCLUDED.trades,
         win_rate_pct = EXCLUDED.win_rate_pct,
         total_return_pct = EXCLUDED.total_return_pct,
         avg_return_pct = EXCLUDED.avg_return_pct,
         max_drawdown_pct = EXCLUDED.max_drawdown_pct,
         updated_at = NOW()`,
      [pick.symbol, pick.conditionId, pick.conditionLabel, pick.trades, pick.winRatePct, pick.totalReturnPct, pick.avgReturnPct, pick.maxDrawdownPct]
    );
  }
}

/** Condición activa por símbolo. Si un símbolo no tiene fila (antes del primer `npm run backtest`), usar `DEFAULT_CONDITION_ID`. */
export async function getSymbolConditions(pool: Pool): Promise<Map<string, SymbolConditionRow>> {
  const result = await pool.query(
    `SELECT symbol, condition_id, condition_label, trades, win_rate_pct, total_return_pct, avg_return_pct, max_drawdown_pct, updated_at
     FROM symbol_conditions`
  );

  const map = new Map<string, SymbolConditionRow>();
  for (const row of result.rows) {
    map.set(row.symbol, {
      symbol: row.symbol,
      conditionId: row.condition_id,
      conditionLabel: row.condition_label,
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
