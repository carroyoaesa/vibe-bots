// Fase 8 (2026-06-17, basada en el reporte de `bots/backtests` - ver `strategy/multiConditionOverrides.ts`):
// se reincorporan AVGO, HD, LOW, MAIN, MU, SCHG, SHW (excluidos en la reducción de 28->20 de
// 2026-06-14 o nunca antes trackeados) tras confirmar que tienen señal robusta con 3 condiciones
// Y volumen diario líquido (decenas/cientos de miles de acciones, verificado contra `market_bars`).
// `QQQ` queda excluido de forma permanente (duplicado de QQQM, comisión mayor - no reabrir).
// `GOLD`, `AGM`, `DBEZ`, `NECB`, `PPA` también aparecían con señal "usar" en ese reporte pero NO se
// agregan: GOLD porque Alpaca resuelve hoy ese ticker a "Gold.com, Inc." (no la Barrick Gold del
// histórico backtested); los otros 4 por volumen diario muy bajo (198-2.542 acciones/día, riesgo
// de slippage/fills pobres) - mismo motivo de iliquidez que los excluyó originalmente el 2026-06-14.
export const WATCHLIST = [
  'AAPL', 'MSFT', 'SPY', 'NVDA',
  'REG', 'TOL', 'SCHE', 'SCHF', 'AMZN', 'XLP', 'XLU', 'XMMO', 'VUG',
  'TSM', 'GOOGL', 'SCHD', 'MS', 'SPMO', 'QQQM', 'SOXQ',
  'AVGO', 'HD', 'LOW', 'MAIN', 'MU', 'SCHG', 'SHW',
];

// Subconjunto de WATCHLIST que son ETFs (el resto se considera "acciones" en el front end).
// Clasificación verificada contra Alpaca (`GET /v2/assets/:symbol`) el 2026-06-17.
export const ETF_SYMBOLS = [
  'SPY', 'SCHE', 'SCHF', 'XLP', 'XLU', 'XMMO', 'VUG',
  'SCHD', 'SPMO', 'QQQM', 'SOXQ', 'SCHG',
];

export const MACRO_SERIES = ['FEDFUNDS', 'CPIAUCSL', 'UNRATE'];

// ~220 días calendario ≈ 150 sesiones de trading, suficiente para SMA30 + RSI14 con margen.
export const BARS_LOOKBACK_DAYS = 220;
