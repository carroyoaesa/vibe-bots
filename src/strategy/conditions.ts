/**
 * Catálogo de "condiciones de estado" de análisis técnico clásicas (Fase 6),
 * usadas como señales de entrada/salida de la estrategia, una por símbolo
 * según el resultado de `npm run backtest` (ver `services/conditionStore.ts`).
 *
 * Cada condición representa un patrón de TA ampliamente documentado:
 *
 *  1. sma_cross_10_30      - Cruce de medias móviles (estrategia original de vibe-bots:
 *                            SMA10 cruza sobre/bajo SMA30, confirmado por RSI<70 y momentum>0).
 *  2. sma_cross_20_50      - "Golden/Death Cross" clásico (medias más lentas, tendencia de fondo).
 *  3. ema_cross_12_26      - Cruce de medias exponenciales rápidas (base del MACD, más reactivo).
 *  4. macd_cross           - MACD(12,26,9): cruce de la línea MACD sobre/bajo su línea de señal.
 *  5. rsi_reversal_30_70   - Reversión por RSI(14): sale de sobreventa (<30) / sale de sobrecompra (>70).
 *  6. bollinger_reversion  - Reversión a la media: rebote desde la banda inferior de Bollinger(20,2)
 *                            hasta la media móvil central.
 *  7. bollinger_breakout   - Ruptura de la banda superior de Bollinger(20,2) (momentum/continuación).
 *  8. stochastic_cross     - Oscilador estocástico(14,3): cruce %K/%D en zonas de sobreventa/sobrecompra.
 *  9. williams_r_reversal  - Reversión por Williams %R(14): sale de zonas extremas (-80 / -20).
 * 10. cci_reversal         - Reversión por CCI(20): sale de zonas extremas (-100 / +100).
 * 11. donchian_breakout_20 - Ruptura de Canal de Donchian: nuevo máximo de 20 sesiones / mínimo de 10.
 * 12. trend_pullback_sma50 - Tendencia + pullback: precio sobre SMA50 y RSI recupera el nivel 40.
 */

import {
  Series,
  bollingerBands,
  cciSeries,
  emaSeries,
  estimateEntryPrice,
  macdSeries,
  priorHighSeries,
  priorLowSeries,
  rocSeries,
  rsiSeries,
  smaSeries,
  stochasticSeries,
  williamsRSeries,
} from './indicators';

/** Misma forma que `services/marketStore.ts`'s `OhlcBar` - sin importar de `services/` para mantener `strategy/` libre de I/O. */
export interface OhlcBar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface IndicatorContext {
  bars: OhlcBar[];
  closes: number[];
  sma10: Series;
  sma20: Series;
  sma30: Series;
  sma50: Series;
  ema12: Series;
  ema26: Series;
  rsi14: Series;
  macd: Series;
  macdSignal: Series;
  bbUpper: Series;
  bbMiddle: Series;
  bbLower: Series;
  stochK: Series;
  stochD: Series;
  williamsR: Series;
  cci20: Series;
  priorHigh20: Series;
  priorLow10: Series;
  momentum10: Series;
}

export function buildIndicatorContext(bars: OhlcBar[]): IndicatorContext {
  const closes = bars.map((bar) => bar.close);
  const highs = bars.map((bar) => bar.high);
  const lows = bars.map((bar) => bar.low);

  const macd = macdSeries(closes, 12, 26, 9);
  const bb = bollingerBands(closes, 20, 2);
  const stoch = stochasticSeries(highs, lows, closes, 14, 3);

  return {
    bars,
    closes,
    sma10: smaSeries(closes, 10),
    sma20: smaSeries(closes, 20),
    sma30: smaSeries(closes, 30),
    sma50: smaSeries(closes, 50),
    ema12: emaSeries(closes, 12),
    ema26: emaSeries(closes, 26),
    rsi14: rsiSeries(closes, 14),
    macd: macd.macd,
    macdSignal: macd.signal,
    bbUpper: bb.upper,
    bbMiddle: bb.middle,
    bbLower: bb.lower,
    stochK: stoch.k,
    stochD: stoch.d,
    williamsR: williamsRSeries(highs, lows, closes, 14),
    cci20: cciSeries(highs, lows, closes, 20),
    priorHigh20: priorHighSeries(highs, 20),
    priorLow10: priorLowSeries(lows, 10),
    momentum10: rocSeries(closes, 10),
  };
}

export type ConditionAction = 'BUY' | 'SELL' | 'HOLD';

export interface Condition {
  id: string;
  label: string;
  evaluate(ctx: IndicatorContext, i: number): ConditionAction;
  /** Fragmento con los valores de indicador que justifican la señal en `i` (para `reason`). */
  describe(ctx: IndicatorContext, i: number): string;
}

function crossedUp(prevA: number | null, prevB: number | null, a: number | null, b: number | null): boolean {
  return prevA !== null && prevB !== null && a !== null && b !== null && prevA <= prevB && a > b;
}

function crossedDown(prevA: number | null, prevB: number | null, a: number | null, b: number | null): boolean {
  return prevA !== null && prevB !== null && a !== null && b !== null && prevA >= prevB && a < b;
}

function crossedAboveLevel(prev: number | null, curr: number | null, level: number): boolean {
  return prev !== null && curr !== null && prev < level && curr >= level;
}

function crossedBelowLevel(prev: number | null, curr: number | null, level: number): boolean {
  return prev !== null && curr !== null && prev > level && curr <= level;
}

/** Formatea un valor de indicador para `Condition.describe()` (`'n/a'` si es `null`). */
function fmtVal(value: number | null, decimals = 2): string {
  return value === null ? 'n/a' : value.toFixed(decimals);
}

export const CONDITIONS: Condition[] = [
  {
    id: 'sma_cross_10_30',
    label: 'Cruce SMA10/SMA30 + RSI<70 + Momentum>0',
    evaluate(ctx, i) {
      const { sma10, sma30, rsi14, momentum10 } = ctx;
      if (crossedUp(sma10[i - 1], sma30[i - 1], sma10[i], sma30[i])) {
        const rsiOk = rsi14[i] === null || (rsi14[i] as number) < 70;
        const momentumOk = momentum10[i] === null || (momentum10[i] as number) > 0;
        if (rsiOk && momentumOk) return 'BUY';
      }
      if (crossedDown(sma10[i - 1], sma30[i - 1], sma10[i], sma30[i])) return 'SELL';
      return 'HOLD';
    },
    describe(ctx, i) {
      return `SMA10=${fmtVal(ctx.sma10[i])} SMA30=${fmtVal(ctx.sma30[i])} RSI14=${fmtVal(ctx.rsi14[i])} Mom10=${fmtVal(ctx.momentum10[i])}%`;
    },
  },
  {
    id: 'sma_cross_20_50',
    label: 'Golden/Death Cross SMA20/SMA50',
    evaluate(ctx, i) {
      const { sma20, sma50 } = ctx;
      if (crossedUp(sma20[i - 1], sma50[i - 1], sma20[i], sma50[i])) return 'BUY';
      if (crossedDown(sma20[i - 1], sma50[i - 1], sma20[i], sma50[i])) return 'SELL';
      return 'HOLD';
    },
    describe(ctx, i) {
      return `SMA20=${fmtVal(ctx.sma20[i])} SMA50=${fmtVal(ctx.sma50[i])}`;
    },
  },
  {
    id: 'ema_cross_12_26',
    label: 'Cruce EMA12/EMA26',
    evaluate(ctx, i) {
      const { ema12, ema26 } = ctx;
      if (crossedUp(ema12[i - 1], ema26[i - 1], ema12[i], ema26[i])) return 'BUY';
      if (crossedDown(ema12[i - 1], ema26[i - 1], ema12[i], ema26[i])) return 'SELL';
      return 'HOLD';
    },
    describe(ctx, i) {
      return `EMA12=${fmtVal(ctx.ema12[i])} EMA26=${fmtVal(ctx.ema26[i])}`;
    },
  },
  {
    id: 'macd_cross',
    label: 'Cruce MACD(12,26,9) / Señal',
    evaluate(ctx, i) {
      const { macd, macdSignal } = ctx;
      if (crossedUp(macd[i - 1], macdSignal[i - 1], macd[i], macdSignal[i])) return 'BUY';
      if (crossedDown(macd[i - 1], macdSignal[i - 1], macd[i], macdSignal[i])) return 'SELL';
      return 'HOLD';
    },
    describe(ctx, i) {
      return `MACD=${fmtVal(ctx.macd[i], 3)} Señal=${fmtVal(ctx.macdSignal[i], 3)}`;
    },
  },
  {
    id: 'rsi_reversal_30_70',
    label: 'Reversión RSI(14) 30/70',
    evaluate(ctx, i) {
      const { rsi14 } = ctx;
      if (crossedAboveLevel(rsi14[i - 1], rsi14[i], 30)) return 'BUY';
      if (crossedBelowLevel(rsi14[i - 1], rsi14[i], 70)) return 'SELL';
      return 'HOLD';
    },
    describe(ctx, i) {
      return `RSI14=${fmtVal(ctx.rsi14[i])}`;
    },
  },
  {
    id: 'bollinger_reversion',
    label: 'Reversión a la media (Bollinger 20,2)',
    evaluate(ctx, i) {
      const { closes, bbLower, bbMiddle } = ctx;
      const prevLower = bbLower[i - 1];
      const lower = bbLower[i];
      if (prevLower !== null && lower !== null && closes[i - 1] < prevLower && closes[i] >= lower) return 'BUY';

      const prevMiddle = bbMiddle[i - 1];
      const middle = bbMiddle[i];
      if (prevMiddle !== null && middle !== null && closes[i - 1] < prevMiddle && closes[i] >= middle) return 'SELL';

      return 'HOLD';
    },
    describe(ctx, i) {
      return `Precio=${fmtVal(ctx.closes[i])} BB(20,2) inf=${fmtVal(ctx.bbLower[i])} media=${fmtVal(ctx.bbMiddle[i])}`;
    },
  },
  {
    id: 'bollinger_breakout',
    label: 'Ruptura banda superior (Bollinger 20,2)',
    evaluate(ctx, i) {
      const { closes, bbUpper, bbMiddle } = ctx;
      const prevUpper = bbUpper[i - 1];
      const upper = bbUpper[i];
      if (prevUpper !== null && upper !== null && closes[i - 1] <= prevUpper && closes[i] > upper) return 'BUY';

      const middle = bbMiddle[i];
      if (middle !== null && closes[i] < middle) return 'SELL';

      return 'HOLD';
    },
    describe(ctx, i) {
      return `Precio=${fmtVal(ctx.closes[i])} BB(20,2) sup=${fmtVal(ctx.bbUpper[i])} media=${fmtVal(ctx.bbMiddle[i])}`;
    },
  },
  {
    id: 'stochastic_cross',
    label: 'Cruce %K/%D Estocástico(14,3) en extremos',
    evaluate(ctx, i) {
      const { stochK, stochD } = ctx;
      const k = stochK[i];
      const d = stochD[i];
      if (crossedUp(stochK[i - 1], stochD[i - 1], k, d) && k !== null && k < 20) return 'BUY';
      if (crossedDown(stochK[i - 1], stochD[i - 1], k, d) && k !== null && k > 80) return 'SELL';
      return 'HOLD';
    },
    describe(ctx, i) {
      return `%K=${fmtVal(ctx.stochK[i], 1)} %D=${fmtVal(ctx.stochD[i], 1)}`;
    },
  },
  {
    id: 'williams_r_reversal',
    label: 'Reversión Williams %R(14)',
    evaluate(ctx, i) {
      const { williamsR } = ctx;
      if (crossedAboveLevel(williamsR[i - 1], williamsR[i], -80)) return 'BUY';
      if (crossedBelowLevel(williamsR[i - 1], williamsR[i], -20)) return 'SELL';
      return 'HOLD';
    },
    describe(ctx, i) {
      return `%R=${fmtVal(ctx.williamsR[i], 1)}`;
    },
  },
  {
    id: 'cci_reversal',
    label: 'Reversión CCI(20) ±100',
    evaluate(ctx, i) {
      const { cci20 } = ctx;
      if (crossedAboveLevel(cci20[i - 1], cci20[i], -100)) return 'BUY';
      if (crossedBelowLevel(cci20[i - 1], cci20[i], 100)) return 'SELL';
      return 'HOLD';
    },
    describe(ctx, i) {
      return `CCI20=${fmtVal(ctx.cci20[i], 1)}`;
    },
  },
  {
    id: 'donchian_breakout_20',
    label: 'Ruptura Canal Donchian (20/10)',
    evaluate(ctx, i) {
      const { closes, priorHigh20, priorLow10 } = ctx;
      const highBound = priorHigh20[i];
      if (highBound !== null && closes[i] > highBound) return 'BUY';

      const lowBound = priorLow10[i];
      if (lowBound !== null && closes[i] < lowBound) return 'SELL';

      return 'HOLD';
    },
    describe(ctx, i) {
      return `Precio=${fmtVal(ctx.closes[i])} canal20/10=[${fmtVal(ctx.priorLow10[i])}, ${fmtVal(ctx.priorHigh20[i])}]`;
    },
  },
  {
    id: 'trend_pullback_sma50',
    label: 'Tendencia (precio>SMA50) + pullback RSI>40',
    evaluate(ctx, i) {
      const { closes, sma50, rsi14 } = ctx;
      const sma = sma50[i];
      if (sma !== null && closes[i] > sma && crossedAboveLevel(rsi14[i - 1], rsi14[i], 40)) return 'BUY';
      if (sma !== null && closes[i] < sma) return 'SELL';
      return 'HOLD';
    },
    describe(ctx, i) {
      return `Precio=${fmtVal(ctx.closes[i])} SMA50=${fmtVal(ctx.sma50[i])} RSI14=${fmtVal(ctx.rsi14[i])}`;
    },
  },
];

/** Condición usada cuando un símbolo todavía no tiene fila en `symbol_conditions` (= comportamiento histórico). */
export const DEFAULT_CONDITION_ID = CONDITIONS[0].id;

/**
 * Precio estimado de entrada (orden límite) para la condición activa en el bar `i`.
 *
 * `scale = 1` para velas diarias; `scale = SCALE_1H` (8) para velas 1H
 * (`computeEstimatedEntryPrice1H` en `conditions1h.ts`).
 *
 * Por condición:
 * - Cruce de SMAs: precio donde SMA_rápida_next = SMA_lenta_actual (proyección analítica).
 * - Cruce de EMAs/MACD: precio donde la EMA rápida alcanzaría a la lenta en 1 barra
 *   (fórmula de actualización EMA: EMA_next = p×k + EMA_curr×(1−k)).
 * - Bollinger / Donchian / SMA50: el nivel de indicador que activa la señal
 *   (bbLower, bbUpper, priorHigh20, sma50).
 * - Estocástico / Williams %R / CCI: precio que llevaría el oscilador al umbral de
 *   activación, calculado desde los bars del período correspondiente.
 * - RSI: mantenemos precio actual (el mapeo RSI→precio es path-dependent).
 */
export function computeEstimatedEntryPrice(ctx: IndicatorContext, i: number, conditionId: string, scale = 1): number | null {
  const price = ctx.closes[i];

  // --- Cruce SMA (sin cambios) ---
  if (conditionId === 'sma_cross_10_30') {
    return estimateEntryPrice(ctx.closes.slice(0, i + 1), 10 * scale, ctx.sma30[i]);
  }
  if (conditionId === 'sma_cross_20_50') {
    return estimateEntryPrice(ctx.closes.slice(0, i + 1), 20 * scale, ctx.sma50[i]);
  }

  // --- Cruce EMA: precio p donde EMA12_next = EMA26_curr ---
  // EMA_next = p×k + EMA_curr×(1−k) → igualando ambas: p×(k12−k26) = EMA26×(1−k26) − EMA12×(1−k12)
  if (conditionId === 'ema_cross_12_26') {
    const ema12 = ctx.ema12[i];
    const ema26 = ctx.ema26[i];
    if (ema12 === null || ema26 === null) return price;
    const k12 = 2 / (12 * scale + 1);
    const k26 = 2 / (26 * scale + 1);
    const p = (ema26 * (1 - k26) - ema12 * (1 - k12)) / (k12 - k26);
    return p > 0 && p < price * 4 ? p : price;
  }

  // --- Cruce MACD: precio p donde MACD_next = macdSignal_curr ---
  // MACD_next = EMA12_next − EMA26_next; igualando a macdSignal:
  // p×(k12−k26) = macdSignal − EMA12×(1−k12) + EMA26×(1−k26)
  if (conditionId === 'macd_cross') {
    const ema12 = ctx.ema12[i];
    const ema26 = ctx.ema26[i];
    const signal = ctx.macdSignal[i];
    if (ema12 === null || ema26 === null || signal === null) return price;
    const k12 = 2 / (12 * scale + 1);
    const k26 = 2 / (26 * scale + 1);
    const p = (signal - ema12 * (1 - k12) + ema26 * (1 - k26)) / (k12 - k26);
    return p > 0 && p < price * 4 ? p : price;
  }

  // --- Nivel de indicador directo ---
  if (conditionId === 'bollinger_reversion') return ctx.bbLower[i] ?? price;   // entrada en banda inferior
  if (conditionId === 'bollinger_breakout')  return ctx.bbUpper[i] ?? price;   // entrada en nivel de ruptura
  if (conditionId === 'donchian_breakout_20') return ctx.priorHigh20[i] ?? price; // entrada en máximo Donchian
  if (conditionId === 'trend_pullback_sma50') return ctx.sma50[i] ?? price;    // entrada cerca del soporte SMA50

  // --- Osciladores: precio en el umbral de activación ---

  // Estocástico: %K = 20 implica Close = Low_period + 0.20 × (High_period − Low_period)
  if (conditionId === 'stochastic_cross') {
    const period = 14 * scale;
    const recentBars = ctx.bars.slice(Math.max(0, i - period + 1), i + 1);
    const high = Math.max(...recentBars.map((b) => b.high));
    const low  = Math.min(...recentBars.map((b) => b.low));
    const range = high - low;
    return range > 0 ? low + 0.2 * range : price;
  }

  // Williams %R: %R = −80 → Close = High_period − 0.80 × (High_period − Low_period)
  if (conditionId === 'williams_r_reversal') {
    const period = 14 * scale;
    const recentBars = ctx.bars.slice(Math.max(0, i - period + 1), i + 1);
    const high = Math.max(...recentBars.map((b) => b.high));
    const low  = Math.min(...recentBars.map((b) => b.low));
    const range = high - low;
    return range > 0 ? high - 0.8 * range : price;
  }

  // CCI: CCI = −100 → Close = SMA20 − 1.5 × MeanDesviation20
  if (conditionId === 'cci_reversal') {
    const sma = ctx.sma20[i];
    if (sma === null) return price;
    const period = 20 * scale;
    const recentCloses = ctx.closes.slice(Math.max(0, i - period + 1), i + 1);
    const meanDev = recentCloses.reduce((s, c) => s + Math.abs(c - sma), 0) / recentCloses.length;
    const p = sma - 1.5 * meanDev;
    return p > 0 ? p : price;
  }

  // rsi_reversal_30_70: mapeo RSI→precio es path-dependent (avgGain/avgLoss); usamos precio actual
  return price;
}
