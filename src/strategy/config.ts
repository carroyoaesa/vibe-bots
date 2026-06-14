export const STRATEGY_PARAMS = {
  smaFastPeriod: 10,
  smaSlowPeriod: 30,
  rsiPeriod: 14,
  rsiOverbought: 70,
  momentumPeriod: 10,
};

// Perfil de riesgo "moderado" (Fase 2):
// - 10% del equity por posición
// - stop-loss -3% / take-profit +6% (ratio 2:1) vía bracket orders
// - máximo 5 posiciones simultáneas (todo el watchlist)
export const RISK_PROFILE = {
  positionSizePct: 0.10,
  stopLossPct: 0.03,
  takeProfitPct: 0.06,
  maxPositions: 5,
};
