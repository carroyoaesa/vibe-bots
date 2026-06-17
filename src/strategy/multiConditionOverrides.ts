/**
 * Overrides de condición de compra/venta por símbolo (Fase 8, 2026-06-17), basados en el
 * reporte de `bots/backtests` (`output/report_data.json`, 33 símbolos, 3 tiers: 1 condición
 * -144 combos-, 2 condiciones -17.424 combos AND/OR-, 3 condiciones -3.097.600 combos, 8
 * formas lógicas-, todo bajo `exit_mode='signal_only'`). El reporte elige, por símbolo, el
 * tier MÁS SIMPLE que mejora de forma real con muestra confiable (`MIN_TRADES=5`,
 * `MIN_BARS=300`, ver `backtests/src/buildReportData.ts#pickRecommendedTier`).
 *
 * Mismo patrón de precedencia que `hybridConfig.ts#HYBRID_CONFIG` para tier 1: se consulta
 * ANTES de `symbol_conditions` (Fase 7) en `tradingRunner.ts`/`server.ts` - si un símbolo
 * tiene entrada acá, sus expresiones reemplazan al pick de 1 condición de
 * `getMainSymbolConditions`/`DEFAULT_CONDITION_ID`, que sigue siendo el fallback para
 * cualquier símbolo SIN entrada (incluido SOXQ, ver abajo).
 *
 * `buyExpr`/`sellExpr` usan la sintaxis de `strategy/conditionExpr.ts` (igual a la que
 * produce `bots/backtests/src/runMultiCondMatrix.ts`/`runTripleCondMatrix.ts#shapeLabel`).
 *
 * Símbolos SIN entrada acá (siguen 100% en el pick de 1 condición de `symbol_conditions`):
 * - `SOXQ`: ni 2 ni 3 condiciones mejoran de forma robusta sobre la condición simple que ya
 *   corre en producción - es, en sí mismo, el resultado del reporte para este símbolo.
 * - Cualquier símbolo agregado a `WATCHLIST` en el futuro sin pasar por este análisis.
 *
 * Símbolos del reporte que NO se reincorporaron al watchlist (ver `watchlist.ts`):
 * - `QQQ`: redundante con `QQQM` (mismo índice, mismas empresas/pesos, comisión mayor) -
 *   exclusión permanente, no reabrir.
 * - `GOLD`: Alpaca resuelve hoy ese ticker a "Gold.com, Inc.", NO a Barrick Gold - el
 *   histórico backtested casi seguro corresponde a una empresa distinta a la tradable hoy.
 * - `AGM`, `DBEZ`, `NECB`, `PPA`: señal "usar" en el reporte, pero volumen diario muy bajo
 *   (198-2.542 acciones/día contra `market_bars`, verificado 2026-06-17) - mismo motivo de
 *   iliquidez que los excluyó originalmente el 2026-06-14, que este reporte no re-evalúa.
 *
 * `SCHG` SÍ se reincorporó (señal "usar" + volumen líquido), pero queda la tensión sin
 * resolver de que su exclusión original (2026-06-14) fue por ser casi duplicado de `VUG`
 * (r=0.993, comisión mayor: 0.04% vs 0.03%) - este reporte no vuelve a chequear esa
 * correlación. Decisión del usuario: reincorporarlo igual (2026-06-17).
 */
export interface MultiConditionOverride {
  tier: 2 | 3;
  buyExpr: string;
  sellExpr: string;
}

export const MULTI_CONDITION_OVERRIDES: Record<string, MultiConditionOverride> = {
  // --- Watchlist original (20 símbolos) ---
  AAPL: { tier: 3, buyExpr: 'OR(bollinger_reversion+stochastic_cross+trend_pullback_sma50)', sellExpr: '(sma_cross_10_30|williams_r_reversal)&bollinger_breakout' },
  AMZN: { tier: 3, buyExpr: 'OR(sma_cross_20_50+macd_cross+bollinger_breakout)', sellExpr: '(stochastic_cross|williams_r_reversal)&rsi_reversal_30_70' },
  GOOGL: { tier: 3, buyExpr: '(rsi_reversal_30_70&williams_r_reversal)|trend_pullback_sma50', sellExpr: '(sma_cross_20_50|cci_reversal)&bollinger_breakout' },
  MS: { tier: 3, buyExpr: '(stochastic_cross&cci_reversal)|macd_cross', sellExpr: '(macd_cross|stochastic_cross)&rsi_reversal_30_70' },
  MSFT: { tier: 3, buyExpr: 'OR(ema_cross_12_26+stochastic_cross+cci_reversal)', sellExpr: '(macd_cross&bollinger_breakout)|bollinger_reversion' },
  NVDA: { tier: 3, buyExpr: '(bollinger_reversion&williams_r_reversal)|donchian_breakout_20', sellExpr: '(williams_r_reversal|cci_reversal)&rsi_reversal_30_70' },
  QQQM: { tier: 3, buyExpr: '(rsi_reversal_30_70&cci_reversal)|stochastic_cross', sellExpr: '(sma_cross_10_30|williams_r_reversal)&trend_pullback_sma50' },
  REG: { tier: 3, buyExpr: 'OR(sma_cross_10_30+bollinger_reversion+cci_reversal)', sellExpr: '(bollinger_breakout&williams_r_reversal)|bollinger_reversion' },
  SCHD: { tier: 3, buyExpr: '(rsi_reversal_30_70&williams_r_reversal)|trend_pullback_sma50', sellExpr: '(bollinger_breakout|cci_reversal)&macd_cross' },
  SCHE: { tier: 3, buyExpr: 'OR(sma_cross_20_50+bollinger_reversion+bollinger_breakout)', sellExpr: '(rsi_reversal_30_70&williams_r_reversal)|sma_cross_20_50' },
  SCHF: { tier: 3, buyExpr: 'OR(bollinger_breakout+stochastic_cross+donchian_breakout_20)', sellExpr: '(sma_cross_10_30|rsi_reversal_30_70)&trend_pullback_sma50' },
  SPMO: { tier: 3, buyExpr: '(sma_cross_10_30&williams_r_reversal)|stochastic_cross', sellExpr: '(stochastic_cross&trend_pullback_sma50)|sma_cross_10_30' },
  SPY: { tier: 3, buyExpr: '(bollinger_reversion&stochastic_cross)|rsi_reversal_30_70', sellExpr: '(ema_cross_12_26|williams_r_reversal)&trend_pullback_sma50' },
  TOL: { tier: 3, buyExpr: '(macd_cross&bollinger_breakout)|stochastic_cross', sellExpr: '(sma_cross_10_30|williams_r_reversal)&trend_pullback_sma50' },
  TSM: { tier: 3, buyExpr: 'OR(ema_cross_12_26+rsi_reversal_30_70+stochastic_cross)', sellExpr: '(macd_cross|williams_r_reversal)&bollinger_breakout' },
  VUG: { tier: 3, buyExpr: 'OR(rsi_reversal_30_70+bollinger_breakout+stochastic_cross)', sellExpr: '(macd_cross|williams_r_reversal)&trend_pullback_sma50' },
  XLP: { tier: 3, buyExpr: 'OR(sma_cross_10_30+bollinger_reversion+stochastic_cross)', sellExpr: 'OR(sma_cross_10_30+sma_cross_20_50+macd_cross)' },
  XMMO: { tier: 3, buyExpr: 'OR(macd_cross+bollinger_reversion+cci_reversal)', sellExpr: '(williams_r_reversal&trend_pullback_sma50)|sma_cross_20_50' },
  XLU: { tier: 2, buyExpr: 'bollinger_reversion|stochastic_cross', sellExpr: 'sma_cross_10_30|macd_cross' },
  // SOXQ: sin entrada (ver comentario de arriba).

  // --- Reincorporados al watchlist (Fase 8, ver watchlist.ts) ---
  AVGO: { tier: 3, buyExpr: '(ema_cross_12_26|bollinger_reversion)&williams_r_reversal', sellExpr: '(rsi_reversal_30_70|cci_reversal)&bollinger_breakout' },
  HD: { tier: 3, buyExpr: '(rsi_reversal_30_70|bollinger_reversion)&williams_r_reversal', sellExpr: '(macd_cross|trend_pullback_sma50)&cci_reversal' },
  LOW: { tier: 3, buyExpr: '(bollinger_reversion&cci_reversal)|sma_cross_20_50', sellExpr: '(macd_cross|cci_reversal)&rsi_reversal_30_70' },
  MAIN: { tier: 3, buyExpr: '(ema_cross_12_26&donchian_breakout_20)|bollinger_reversion', sellExpr: '(williams_r_reversal&trend_pullback_sma50)|sma_cross_20_50' },
  MU: { tier: 3, buyExpr: 'OR(sma_cross_20_50+rsi_reversal_30_70+stochastic_cross)', sellExpr: '(sma_cross_10_30|williams_r_reversal)&bollinger_breakout' },
  SCHG: { tier: 3, buyExpr: '(bollinger_breakout&donchian_breakout_20)|stochastic_cross', sellExpr: '(sma_cross_10_30|williams_r_reversal)&trend_pullback_sma50' },
  SHW: { tier: 3, buyExpr: '(bollinger_reversion|stochastic_cross)&rsi_reversal_30_70', sellExpr: 'AND(rsi_reversal_30_70+williams_r_reversal+cci_reversal)' },
};

// Fail-loud: un typo acá es un bug de autoría estática, no una falla externa - tiene que
// romper el arranque del proceso (npm run dev/trade/web/backtest), no degradar en silencio
// una señal real en paper. Se valida al importar este módulo (cualquier entrypoint que lo
// use, directa o indirectamente, falla inmediato si algo no parsea).
import { parseConditionExpr } from './conditionExpr';

for (const [symbol, override] of Object.entries(MULTI_CONDITION_OVERRIDES)) {
  try {
    parseConditionExpr(override.buyExpr);
    parseConditionExpr(override.sellExpr);
  } catch (err) {
    throw new Error(
      `MULTI_CONDITION_OVERRIDES["${symbol}"] tiene una expresión inválida: ${err instanceof Error ? err.message : err}`
    );
  }
}
