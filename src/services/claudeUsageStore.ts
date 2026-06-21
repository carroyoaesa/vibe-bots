import { Pool } from 'pg';

/**
 * Tracking diario de costo de Claude (Fase eficiencia/experimento, 2026-06-21) - visibilidad
 * pura, sin ningún bloqueo: el control del gasto lo hace el usuario manualmente (apagando
 * `bot_settings.claude_experiment_enabled` o, en el límite, `ANTHROPIC_API_KEY`), nunca el
 * código (ver reglas de la tarea - "NO implementes ningún corte automático de consultas a
 * Claude por presupuesto").
 */
export async function setupClaudeUsageSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS claude_usage_log (
      date DATE PRIMARY KEY,
      total_tokens BIGINT NOT NULL DEFAULT 0,
      total_cost_usd NUMERIC NOT NULL DEFAULT 0,
      calls_count INTEGER NOT NULL DEFAULT 0,
      calls_production INTEGER NOT NULL DEFAULT 0,
      calls_experiment INTEGER NOT NULL DEFAULT 0
    )
  `);
}

export interface RecordClaudeUsageInput {
  /** Fecha UTC 'YYYY-MM-DD' del ciclo - mantiene el log alineado con el resto del bot (todo en UTC). */
  date: string;
  totalTokens: number;
  costUsd: number;
  /** 'production' = llamada normal del gate de trading (variante A); 'experiment' = variantes B/C/D. */
  source: 'production' | 'experiment';
}

/** Upsert acumulativo por día - se llama una vez por cada llamada real a Claude (`/v1/messages`). */
export async function recordClaudeUsage(pool: Pool, input: RecordClaudeUsageInput): Promise<void> {
  const isProduction = input.source === 'production';
  await pool.query(
    `INSERT INTO claude_usage_log (date, total_tokens, total_cost_usd, calls_count, calls_production, calls_experiment)
     VALUES ($1, $2, $3, 1, $4, $5)
     ON CONFLICT (date) DO UPDATE SET
       total_tokens = claude_usage_log.total_tokens + EXCLUDED.total_tokens,
       total_cost_usd = claude_usage_log.total_cost_usd + EXCLUDED.total_cost_usd,
       calls_count = claude_usage_log.calls_count + 1,
       calls_production = claude_usage_log.calls_production + EXCLUDED.calls_production,
       calls_experiment = claude_usage_log.calls_experiment + EXCLUDED.calls_experiment`,
    [input.date, input.totalTokens, input.costUsd, isProduction ? 1 : 0, isProduction ? 0 : 1]
  );
}

export interface ClaudeUsageRow {
  date: string;
  totalTokens: number;
  totalCostUsd: number;
  callsCount: number;
  callsProduction: number;
  callsExperiment: number;
}

/** Últimos `days` días de uso (incluyendo hoy), más reciente primero. */
export async function getClaudeUsage(pool: Pool, days: number): Promise<ClaudeUsageRow[]> {
  const { rows } = await pool.query(
    `SELECT date, total_tokens, total_cost_usd, calls_count, calls_production, calls_experiment
     FROM claude_usage_log
     WHERE date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
     ORDER BY date DESC`,
    [days]
  );

  return rows.map((row) => ({
    date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date,
    totalTokens: Number(row.total_tokens),
    totalCostUsd: Number(row.total_cost_usd),
    callsCount: Number(row.calls_count),
    callsProduction: Number(row.calls_production),
    callsExperiment: Number(row.calls_experiment),
  }));
}

/** Fila de hoy (UTC) - usada por el banner del dashboard. `null` si todavía no hubo llamadas hoy. */
export async function getTodayClaudeUsage(pool: Pool): Promise<ClaudeUsageRow | null> {
  const { rows } = await pool.query(
    `SELECT date, total_tokens, total_cost_usd, calls_count, calls_production, calls_experiment
     FROM claude_usage_log WHERE date = CURRENT_DATE`
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date,
    totalTokens: Number(row.total_tokens),
    totalCostUsd: Number(row.total_cost_usd),
    callsCount: Number(row.calls_count),
    callsProduction: Number(row.calls_production),
    callsExperiment: Number(row.calls_experiment),
  };
}
