import { Pool } from 'pg';
import { RISK_PROFILE, RiskProfile } from '../strategy/config';

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
}

export interface BotSettings {
  riskPreset: string;
  riskProfile: RiskProfile;
  claudeModel: string | null;
  tradingEnabled: boolean;
}

export async function getSettings(pool: Pool): Promise<BotSettings> {
  const result = await pool.query(
    `SELECT risk_preset, position_size_pct, stop_loss_pct, take_profit_pct, max_positions, claude_model, trading_enabled
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
  };
}

export async function saveSettings(pool: Pool, settings: Pick<BotSettings, 'riskPreset' | 'riskProfile' | 'claudeModel'>): Promise<void> {
  await pool.query(
    `UPDATE bot_settings
     SET risk_preset = $1, position_size_pct = $2, stop_loss_pct = $3, take_profit_pct = $4,
         max_positions = $5, claude_model = $6, updated_at = NOW()
     WHERE id = 1`,
    [
      settings.riskPreset,
      settings.riskProfile.positionSizePct,
      settings.riskProfile.stopLossPct,
      settings.riskProfile.takeProfitPct,
      settings.riskProfile.maxPositions,
      settings.claudeModel,
    ]
  );
}

export async function setTradingEnabled(pool: Pool, enabled: boolean): Promise<void> {
  await pool.query(
    `UPDATE bot_settings SET trading_enabled = $1, updated_at = NOW() WHERE id = 1`,
    [enabled]
  );
}
