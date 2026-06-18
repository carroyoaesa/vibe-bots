import { Pool } from 'pg';

export async function setupBacktestSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id SERIAL PRIMARY KEY,
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      symbols TEXT[] NOT NULL,
      start_date DATE,
      end_date DATE,
      params JSONB,
      summary JSONB
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS backtest_trades (
      id SERIAL PRIMARY KEY,
      run_id INTEGER REFERENCES backtest_runs(id),
      symbol TEXT NOT NULL,
      entry_date DATE NOT NULL,
      entry_price NUMERIC NOT NULL,
      exit_date DATE,
      exit_price NUMERIC,
      exit_reason TEXT,
      pnl_pct NUMERIC
    )
  `);

  // Backtest segmentado por clasificación (`symbol_classifications`): NULL = corrida
  // legacy sobre todo el watchlist (`runBacktestForWatchlist`, sin cambios); 'aptos' |
  // 'observados' | 'bloqueados' = corrida acotada a ese grupo (`runBacktestForGroup`).
  await pool.query(`ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS classification_group TEXT`);
}

export interface BacktestTradeInput {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string | null;
  exitPrice: number | null;
  exitReason: string | null;
  pnlPct: number | null;
}

export interface BacktestRunInput {
  symbols: string[];
  startDate: string | null;
  endDate: string | null;
  params: unknown;
  summary: unknown;
  trades: BacktestTradeInput[];
  /** 'aptos' | 'observados' | 'bloqueados' para una corrida segmentada, `null`/omitido para la corrida legacy sobre todo el watchlist. */
  classificationGroup?: string | null;
}

export async function saveBacktestRun(pool: Pool, run: BacktestRunInput): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO backtest_runs (symbols, start_date, end_date, params, summary, classification_group)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [run.symbols, run.startDate, run.endDate, JSON.stringify(run.params), JSON.stringify(run.summary), run.classificationGroup ?? null]
  );

  const runId = result.rows[0].id;

  for (const trade of run.trades) {
    await pool.query(
      `INSERT INTO backtest_trades (run_id, symbol, entry_date, entry_price, exit_date, exit_price, exit_reason, pnl_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [runId, trade.symbol, trade.entryDate, trade.entryPrice, trade.exitDate, trade.exitPrice, trade.exitReason, trade.pnlPct]
    );
  }

  return runId;
}

export interface BacktestRunRow {
  id: number;
  runAt: string;
  symbols: string[];
  startDate: string | null;
  endDate: string | null;
  params: unknown;
  summary: unknown;
  classificationGroup: string | null;
}

export interface BacktestTradeRow {
  id: number;
  symbol: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string | null;
  exitPrice: number | null;
  exitReason: string | null;
  pnlPct: number | null;
}

export interface BacktestRunWithTrades {
  run: BacktestRunRow;
  trades: BacktestTradeRow[];
}

/**
 * Última corrida de backtest. Sin `group`, devuelve la más reciente sin importar el
 * grupo (comportamiento histórico, usado por `/api/backtesting/results`). Con `group`
 * (`'aptos'|'observados'|'bloqueados'`), filtra por `classification_group` (usado por
 * `GET /api/backtest/results?group=...`).
 */
export async function getLatestBacktestRun(pool: Pool, group?: string | null): Promise<BacktestRunWithTrades | null> {
  const runResult = group
    ? await pool.query(
        `SELECT id, run_at, symbols, start_date, end_date, params, summary, classification_group
         FROM backtest_runs
         WHERE classification_group = $1
         ORDER BY run_at DESC
         LIMIT 1`,
        [group]
      )
    : await pool.query(
        `SELECT id, run_at, symbols, start_date, end_date, params, summary, classification_group
         FROM backtest_runs
         ORDER BY run_at DESC
         LIMIT 1`
      );

  if (runResult.rows.length === 0) {
    return null;
  }

  const row = runResult.rows[0];
  const run: BacktestRunRow = {
    id: row.id,
    runAt: row.run_at,
    symbols: row.symbols,
    startDate: row.start_date,
    endDate: row.end_date,
    params: row.params,
    summary: row.summary,
    classificationGroup: row.classification_group,
  };

  const tradesResult = await pool.query(
    `SELECT id, symbol, entry_date, entry_price, exit_date, exit_price, exit_reason, pnl_pct
     FROM backtest_trades
     WHERE run_id = $1
     ORDER BY symbol, entry_date`,
    [run.id]
  );

  const trades: BacktestTradeRow[] = tradesResult.rows.map((t) => ({
    id: t.id,
    symbol: t.symbol,
    entryDate: t.entry_date,
    entryPrice: Number(t.entry_price),
    exitDate: t.exit_date,
    exitPrice: t.exit_price !== null ? Number(t.exit_price) : null,
    exitReason: t.exit_reason,
    pnlPct: t.pnl_pct !== null ? Number(t.pnl_pct) : null,
  }));

  return { run, trades };
}
