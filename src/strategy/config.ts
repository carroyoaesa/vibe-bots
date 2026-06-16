export const STRATEGY_PARAMS = {
  smaFastPeriod: 10,
  smaSlowPeriod: 30,
  rsiPeriod: 14,
  rsiOverbought: 70,
  momentumPeriod: 10,
};

export interface RiskProfile {
  positionSizePct: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxPositions: number;
}

// Fase A.1 (2026-06-15): modo de salida de las compras (bot_settings.exit_mode).
// 'bracket' (default) = TP/SL del riskProfile activo; 'signal_only' = sin TP/SL,
// solo señal SELL de la condición activa. Ver strategy/backtest.ts y tradingRunner.ts.
export type ExitMode = 'bracket' | 'signal_only';

// Perfil de riesgo "moderado" (Fase 2, default/semilla de bot_settings - Fase 5):
// - 10% del equity por posición
// - stop-loss -3% / take-profit +6% (ratio 2:1) vía bracket orders
// - máximo 5 posiciones simultáneas (todo el watchlist)
export const RISK_PROFILE: RiskProfile = {
  positionSizePct: 0.10,
  stopLossPct: 0.03,
  takeProfitPct: 0.06,
  maxPositions: 5,
};

// Presets de perfil de riesgo (Fase 5) - punto de partida editable desde el dashboard
// ("Configuración"). El perfil activo en runtime vive en bot_settings, no aquí.
// "flujo_de_caja": 7%×18 = 126% equity máximo (26% margin), basado en el análisis de
// concurrencia del backtest (media 12.6 posiciones, máx 18) - diseñado para desplegar
// siempre el 100% del cash y aprovechar el buying power en los picos de señales.
export const RISK_PROFILE_PRESETS: Record<'conservador' | 'moderado' | 'agresivo' | 'flujo_de_caja', RiskProfile> = {
  conservador: {
    positionSizePct: 0.05,
    stopLossPct: 0.02,
    takeProfitPct: 0.04,
    maxPositions: 3,
  },
  moderado: RISK_PROFILE,
  agresivo: {
    positionSizePct: 0.15,
    stopLossPct: 0.05,
    takeProfitPct: 0.10,
    maxPositions: 8,
  },
  flujo_de_caja: {
    positionSizePct: 0.07,
    stopLossPct: 0.03,
    takeProfitPct: 0.06,
    maxPositions: 18,
  },
};
