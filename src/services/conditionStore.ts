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

  // Fase híbrido: un símbolo puede tener hasta 2 filas - su pick 1D ('1Day', sin
  // cambios) y, para los símbolos de `strategy/hybridConfig.ts#HYBRID_CONFIG`, su
  // combo 1H ('1Hour'). Para tier 1 (SPY/XLU) la fila '1Hour' reemplaza a la '1Day'
  // (ver `deleteSymbolConditionsForTimeframe` en `backtestRunner.ts`).
  await pool.query(`ALTER TABLE symbol_conditions ADD COLUMN IF NOT EXISTS timeframe TEXT NOT NULL DEFAULT '1Day'`);
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'symbol_conditions_pkey'
          AND conrelid = 'symbol_conditions'::regclass
          AND array_length(conkey, 1) = 1
      ) THEN
        ALTER TABLE symbol_conditions DROP CONSTRAINT symbol_conditions_pkey;
        ALTER TABLE symbol_conditions ADD PRIMARY KEY (symbol, timeframe);
      END IF;
    END $$;
  `);
}

export type ConditionTimeframe = '1Day' | '1Hour';

export interface SymbolConditionPick {
  symbol: string;
  timeframe: ConditionTimeframe;
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

/** Upsert del par (condición de compra, condición de venta) ganador por (símbolo, timeframe) (llamado al final de `runBacktestForWatchlist`). */
export async function saveSymbolConditions(pool: Pool, picks: SymbolConditionPick[]): Promise<void> {
  for (const pick of picks) {
    await pool.query(
      `INSERT INTO symbol_conditions (symbol, timeframe, buy_condition_id, buy_condition_label, sell_condition_id, sell_condition_label, trades, win_rate_pct, total_return_pct, avg_return_pct, max_drawdown_pct, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       ON CONFLICT (symbol, timeframe) DO UPDATE SET
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
        pick.timeframe,
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

/** Borra las filas `(symbol, timeframe)` indicadas - usado por `backtestRunner.ts` para limpiar la fila '1Day' obsoleta de los símbolos tier 1 (`HYBRID_CONFIG`), cuyo único pick pasa a ser '1Hour'. */
export async function deleteSymbolConditionsForTimeframe(pool: Pool, symbols: string[], timeframe: ConditionTimeframe): Promise<void> {
  if (symbols.length === 0) return;
  await pool.query(`DELETE FROM symbol_conditions WHERE timeframe = $1 AND symbol = ANY($2)`, [timeframe, symbols]);
}

function mapConditionRow(row: Record<string, unknown>): SymbolConditionRow {
  return {
    symbol: row.symbol as string,
    timeframe: row.timeframe as ConditionTimeframe,
    buyConditionId: row.buy_condition_id as string,
    buyConditionLabel: row.buy_condition_label as string,
    sellConditionId: row.sell_condition_id as string,
    sellConditionLabel: row.sell_condition_label as string,
    trades: Number(row.trades),
    winRatePct: row.win_rate_pct !== null ? Number(row.win_rate_pct) : null,
    totalReturnPct: Number(row.total_return_pct),
    avgReturnPct: row.avg_return_pct !== null ? Number(row.avg_return_pct) : null,
    maxDrawdownPct: Number(row.max_drawdown_pct),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

/**
 * Todas las filas `symbol_conditions` por símbolo (1 para los 13 símbolos sin
 * entrada en `HYBRID_CONFIG`, hasta 2 para los símbolos híbridos - '1Day' + '1Hour').
 * Usado por `/api/conditions`.
 */
export async function getSymbolConditions(pool: Pool): Promise<Map<string, SymbolConditionRow[]>> {
  const result = await pool.query(
    `SELECT symbol, timeframe, buy_condition_id, buy_condition_label, sell_condition_id, sell_condition_label, trades, win_rate_pct, total_return_pct, avg_return_pct, max_drawdown_pct, updated_at
     FROM symbol_conditions`
  );

  const map = new Map<string, SymbolConditionRow[]>();
  for (const row of result.rows) {
    const list = map.get(row.symbol) ?? [];
    list.push(mapConditionRow(row));
    map.set(row.symbol, list);
  }
  return map;
}

/**
 * Pick '1Day' (par condición de compra/venta + métricas) activo por símbolo - el
 * pick "main" para los 13 símbolos sin entrada en `HYBRID_CONFIG` y para tier
 * 2/'shadow' (MS, QQQM, SCHD). Si un símbolo no tiene fila '1Day' (tier 1, o antes
 * del primer `npm run backtest`), usar `DEFAULT_CONDITION_ID` para ambas - tier 1
 * no consulta esto, calcula su señal "main" directamente desde `HYBRID_CONFIG`.
 */
export async function getMainSymbolConditions(pool: Pool): Promise<Map<string, SymbolConditionRow>> {
  const result = await pool.query(
    `SELECT symbol, timeframe, buy_condition_id, buy_condition_label, sell_condition_id, sell_condition_label, trades, win_rate_pct, total_return_pct, avg_return_pct, max_drawdown_pct, updated_at
     FROM symbol_conditions
     WHERE timeframe = '1Day'`
  );

  const map = new Map<string, SymbolConditionRow>();
  for (const row of result.rows) {
    map.set(row.symbol, mapConditionRow(row));
  }
  return map;
}
