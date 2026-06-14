export const WATCHLIST = [
  'AAPL', 'MSFT', 'SPY', 'QQQ', 'NVDA',
  'NECB', 'REG', 'TOL', 'SCHE', 'SCHF', 'AMZN', 'XLP', 'XLU', 'XMMO', 'VUG',
  'DBEZ', 'PPA', 'SCHG', 'TSM', 'AVGO', 'GOOGL', 'MU', 'AGM', 'SCHD', 'MS',
  'SPMO', 'QQQM', 'SOXQ',
];

// Subconjunto de WATCHLIST que son ETFs (el resto se considera "acciones" en el front end).
export const ETF_SYMBOLS = [
  'SPY', 'QQQ', 'SCHE', 'SCHF', 'XLP', 'XLU', 'XMMO', 'VUG', 'DBEZ', 'PPA',
  'SCHG', 'SCHD', 'SPMO', 'QQQM', 'SOXQ',
];

export const MACRO_SERIES = ['FEDFUNDS', 'CPIAUCSL', 'UNRATE'];

// ~220 días calendario ≈ 150 sesiones de trading, suficiente para SMA30 + RSI14 con margen.
export const BARS_LOOKBACK_DAYS = 220;
