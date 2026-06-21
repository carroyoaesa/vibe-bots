import { Pool } from 'pg';
import { ExitMode, RISK_PROFILE, RiskProfile } from '../strategy/config';

export async function setupSettingsSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1,
      risk_preset TEXT NOT NULL DEFAULT 'moderado',
      position_size_pct NUMERIC NOT NULL,
      stop_loss_pct NUMERIC NOT NULL,
      take_profit_pct NUMERIC NOT NULL,
      max_positions INTEGER NOT NULL,
      claude_model TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT bot_settings_singleton CHECK (id = 1)
    )
  `);

  await pool.query(
    `INSERT INTO bot_settings (id, risk_preset, position_size_pct, stop_loss_pct, take_profit_pct, max_positions, claude_model)
     VALUES (1, 'moderado', $1, $2, $3, $4, NULL)
     ON CONFLICT (id) DO NOTHING`,
    [RISK_PROFILE.positionSizePct, RISK_PROFILE.stopLossPct, RISK_PROFILE.takeProfitPct, RISK_PROFILE.maxPositions]
  );

  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS trading_enabled BOOLEAN NOT NULL DEFAULT TRUE`);

  // Fase A.1 (2026-06-15): modo de salida de las compras. 'bracket' (default, comportamiento
  // histórico) adjunta take-profit/stop-loss vía placeBracketBuyOrder. 'signal_only' coloca
  // una orden simple (placeBuyOrder, sin TP/SL) y la posición se cierra únicamente cuando la
  // condición activa emite señal SELL (closePosition en runTradingCycle, sin cambios).
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS exit_mode TEXT NOT NULL DEFAULT 'bracket'`);

  // Fase Operaciones multi-cuenta (2026-06-18): minutos que una orden BUY puede quedar
  // pendiente antes de considerarse "huérfana" (cancelStaleOrders, services/preTradeCheck.ts) -
  // y si esa cancelación corre automática (default false: solo se detecta/loguea/muestra en UI).
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS pending_order_timeout_min INTEGER NOT NULL DEFAULT 60`);
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS auto_cancel_stale_orders BOOLEAN NOT NULL DEFAULT FALSE`);

  // Fase eficiencia/experimento (2026-06-21): apagado por defecto - con el flag en false,
  // runTradingCycle() solo corre la variante 'A' (evaluación normal de producción) para los
  // candidatos BUY; con el flag en true, además corre B/C/D (ver tradingRunner.ts/claude.ts).
  await pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS claude_experiment_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
}

export interface BotSettings {
  riskPreset: string;
  riskProfile: RiskProfile;
  claudeModel: string | null;
  tradingEnabled: boolean;
  exitMode: ExitMode;
  pendingOrderTimeoutMin: number;
  autoCancelStaleOrders: boolean;
  claudeExperimentEnabled: boolean;
}

export async function getSettings(pool: Pool): Promise<BotSettings> {
  const result = await pool.query(
    `SELECT risk_preset, position_size_pct, stop_loss_pct, take_profit_pct, max_positions, claude_model, trading_enabled, exit_mode, pending_order_timeout_min, auto_cancel_stale_orders, claude_experiment_enabled
     FROM bot_settings WHERE id = 1`
  );

  const row = result.rows[0];

  return {
    riskPreset: row.risk_preset,
    riskProfile: {
      positionSizePct: Number(row.position_size_pct),
      stopLossPct: Number(row.stop_loss_pct),
      takeProfitPct: Number(row.take_profit_pct),
      maxPositions: Number(row.max_positions),
    },
    claudeModel: row.claude_model,
    tradingEnabled: row.trading_enabled,
    exitMode: row.exit_mode,
    pendingOrderTimeoutMin: Number(row.pending_order_timeout_min),
    autoCancelStaleOrders: row.auto_cancel_stale_orders,
    claudeExperimentEnabled: row.claude_experiment_enabled,
  };
}

export async function setAutoCancelStaleOrders(pool: Pool, enabled: boolean): Promise<void> {
  await pool.query(`UPDATE bot_settings SET auto_cancel_stale_orders = $1, updated_at = NOW() WHERE id = 1`, [enabled]);
}

export async function saveSettings(pool: Pool, settings: Pick<BotSettings, 'riskPreset' | 'riskProfile' | 'claudeModel' | 'exitMode'>): Promise<void> {
  await pool.query(
    `UPDATE bot_settings
     SET risk_preset = $1, position_size_pct = $2, stop_loss_pct = $3, take_profit_pct = $4,
         max_positions = $5, claude_model = $6, exit_mode = $7, updated_at = NOW()
     WHERE id = 1`,
    [
      settings.riskPreset,
      settings.riskProfile.positionSizePct,
      settings.riskProfile.stopLossPct,
      settings.riskProfile.takeProfitPct,
      settings.riskProfile.maxPositions,
      settings.claudeModel,
      settings.exitMode,
    ]
  );
}

export async function setTradingEnabled(pool: Pool, enabled: boolean): Promise<void> {
  await pool.query(
    `UPDATE bot_settings SET trading_enabled = $1, updated_at = NOW() WHERE id = 1`,
    [enabled]
  );
}

export async function setClaudeExperimentEnabled(pool: Pool, enabled: boolean): Promise<void> {
  await pool.query(
    `UPDATE bot_settings SET claude_experiment_enabled = $1, updated_at = NOW() WHERE id = 1`,
    [enabled]
  );
}
