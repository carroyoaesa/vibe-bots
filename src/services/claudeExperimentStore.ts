import { Pool } from 'pg';
import { ClaudeExperimentVariant } from './claude';

/**
 * Experimento de sesgo de Claude, limitado a señales BUY (Fase eficiencia/experimento,
 * 2026-06-21) - 4 variantes por símbolo candidato en el mismo ciclo: 'A' (control, = la
 * evaluación normal de producción, reusada sin llamada extra), 'B' (sin señal técnica), 'C'
 * (solo señal técnica) y 'D' (mismo contenido que A con el orden de secciones invertido). 'A'
 * se registra siempre (con o sin el flag); B/C/D solo si `bot_settings.claude_experiment_enabled`.
 */
export type ExperimentVariant = 'A' | ClaudeExperimentVariant;

export async function setupClaudeExperimentSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS claude_gate_experiment (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL,
      variant TEXT NOT NULL CHECK (variant IN ('A', 'B', 'C', 'D')),
      recommendation TEXT NOT NULL,
      score NUMERIC,
      confidence NUMERIC,
      rationale TEXT,
      model TEXT NOT NULL,
      tokens_used INTEGER NOT NULL,
      cost_estimate_usd NUMERIC
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS claude_gate_experiment_symbol_ts_idx ON claude_gate_experiment (symbol, ts)`);
}

export interface ExperimentResultRecord {
  symbol: string;
  /**
   * Mismo timestamp para las 4 variantes de un símbolo en un ciclo (capturado una vez por el
   * caller, NO `NOW()` por fila) - es lo que permite el self-join de `getExperimentDisagreements`
   * sin depender de una ventana de tiempo aproximada.
   */
  ts: Date;
  variant: ExperimentVariant;
  recommendation: string;
  score: number | null;
  confidence: number | null;
  rationale: string | null;
  model: string;
  tokensUsed: number;
  costEstimateUsd: number | null;
}

export async function recordExperimentResult(pool: Pool, r: ExperimentResultRecord): Promise<void> {
  await pool.query(
    `INSERT INTO claude_gate_experiment (symbol, ts, variant, recommendation, score, confidence, rationale, model, tokens_used, cost_estimate_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [r.symbol, r.ts, r.variant, r.recommendation, r.score, r.confidence, r.rationale, r.model, r.tokensUsed, r.costEstimateUsd]
  );
}

export interface ExperimentVariantSummary {
  variant: ExperimentVariant;
  evaluations: number;
  buyRatePct: number;
  holdRatePct: number;
  avoidRatePct: number;
  avgScore: number | null;
  avgConfidence: number | null;
}

/** Tasas de recomendación y confianza promedio por variante, sobre los últimos `days` días. */
export async function getExperimentSummary(pool: Pool, days: number): Promise<ExperimentVariantSummary[]> {
  const { rows } = await pool.query(
    `SELECT
       variant,
       COUNT(*)::int AS evaluations,
       100.0 * COUNT(*) FILTER (WHERE recommendation = 'buy') / COUNT(*) AS buy_rate_pct,
       100.0 * COUNT(*) FILTER (WHERE recommendation = 'hold') / COUNT(*) AS hold_rate_pct,
       100.0 * COUNT(*) FILTER (WHERE recommendation = 'avoid') / COUNT(*) AS avoid_rate_pct,
       AVG(score) AS avg_score,
       AVG(confidence) AS avg_confidence
     FROM claude_gate_experiment
     WHERE ts >= NOW() - ($1 || ' days')::INTERVAL
     GROUP BY variant
     ORDER BY variant`,
    [days]
  );

  return rows.map((row) => ({
    variant: row.variant,
    evaluations: Number(row.evaluations),
    buyRatePct: Number(row.buy_rate_pct),
    holdRatePct: Number(row.hold_rate_pct),
    avoidRatePct: Number(row.avoid_rate_pct),
    avgScore: row.avg_score !== null ? Number(row.avg_score) : null,
    avgConfidence: row.avg_confidence !== null ? Number(row.avg_confidence) : null,
  }));
}

export interface ExperimentDisagreement {
  symbol: string;
  ts: string;
  recommendationA: string;
  recommendationB: string;
  scoreA: number | null;
  scoreB: number | null;
  rationaleA: string | null;
  rationaleB: string | null;
}

/**
 * Casos A (control, producción) vs B (sin señal técnica) donde la recomendación difiere - el
 * caso de interés central de la hipótesis de sesgo: ¿Claude recomienda "buy" en base a la señal
 * técnica en sí (no a los fundamentales/noticias), de modo que sin saber que la estrategia ya
 * dio BUY, cambiaría de opinión? Self-join por (symbol, ts) exacto - ver nota en `ExperimentResultRecord.ts`.
 */
export async function getExperimentDisagreements(pool: Pool, days: number): Promise<ExperimentDisagreement[]> {
  const { rows } = await pool.query(
    `SELECT a.symbol, a.ts, a.recommendation AS rec_a, b.recommendation AS rec_b,
            a.score AS score_a, b.score AS score_b, a.rationale AS rationale_a, b.rationale AS rationale_b
     FROM claude_gate_experiment a
     JOIN claude_gate_experiment b ON a.symbol = b.symbol AND a.ts = b.ts AND b.variant = 'B'
     WHERE a.variant = 'A'
       AND a.recommendation <> b.recommendation
       AND a.ts >= NOW() - ($1 || ' days')::INTERVAL
     ORDER BY a.ts DESC`,
    [days]
  );

  return rows.map((row) => ({
    symbol: row.symbol,
    ts: row.ts,
    recommendationA: row.rec_a,
    recommendationB: row.rec_b,
    scoreA: row.score_a !== null ? Number(row.score_a) : null,
    scoreB: row.score_b !== null ? Number(row.score_b) : null,
    rationaleA: row.rationale_a,
    rationaleB: row.rationale_b,
  }));
}

export interface ExperimentCostSummary {
  totalCostUsd: number;
  totalTokens: number;
  evaluations: number;
  byVariant: { variant: ExperimentVariant; costUsd: number; tokens: number; evaluations: number }[];
}

/** Costo acumulado del experimento (variantes B/C/D - 'A' es la evaluación de producción, ya contada en `claude_usage_log`). */
export async function getExperimentCost(pool: Pool, days: number): Promise<ExperimentCostSummary> {
  const { rows } = await pool.query(
    `SELECT variant, COALESCE(SUM(cost_estimate_usd), 0) AS cost_usd, COALESCE(SUM(tokens_used), 0) AS tokens, COUNT(*)::int AS evaluations
     FROM claude_gate_experiment
     WHERE variant IN ('B', 'C', 'D') AND ts >= NOW() - ($1 || ' days')::INTERVAL
     GROUP BY variant
     ORDER BY variant`,
    [days]
  );

  const byVariant = rows.map((row) => ({
    variant: row.variant as ExperimentVariant,
    costUsd: Number(row.cost_usd),
    tokens: Number(row.tokens),
    evaluations: Number(row.evaluations),
  }));

  return {
    totalCostUsd: byVariant.reduce((sum, v) => sum + v.costUsd, 0),
    totalTokens: byVariant.reduce((sum, v) => sum + v.tokens, 0),
    evaluations: byVariant.reduce((sum, v) => sum + v.evaluations, 0),
    byVariant,
  };
}
