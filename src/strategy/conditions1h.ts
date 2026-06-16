/**
 * Variante de `buildIndicatorContext`/`computeEstimatedEntryPrice` (`./conditions.ts`)
 * para velas de 1 HORA, reescalando los períodos de cada indicador por `SCALE_1H` para
 * preservar aproximadamente el mismo significado "calendario" que tienen sobre velas
 * diarias (p.ej. SMA10 diario ≈ 2 semanas -> SMA80 en 1H con SCALE_1H=8).
 *
 * `CONDITIONS` (evaluate/describe, `./conditions.ts`) NO cambia: lee `ctx.sma10`,
 * `ctx.rsi14`, etc. por nombre de campo, que aquí contienen series calculadas con el
 * período reescalado (p.ej. `ctx.sma10` es en realidad una SMA de `10*SCALE_1H` velas).
 *
 * Puerto de `bots/backtests/src/hourly1Symbol/vibeStrategyScaled/conditions.ts`
 * (SCALE=8, validado en el experimento Fase 1 sobre los 20 símbolos del watchlist).
 */
import {
  bollingerBands,
  cciSeries,
  emaSeries,
  macdSeries,
  priorHighSeries,
  priorLowSeries,
  rocSeries,
  rsiSeries,
  smaSeries,
  stochasticSeries,
  williamsRSeries,
} from './indicators';
import { IndicatorContext, OhlcBar, computeEstimatedEntryPrice } from './conditions';

/** Factor de reescalado de períodos para velas 1H (10 -> 80, 14 -> 112, 20 -> 160, etc.). Fijado en Fase 1 (`phase1_full20`). */
export const SCALE_1H = 8;

export function buildIndicatorContext1H(bars: OhlcBar[]): IndicatorContext {
  const closes = bars.map((bar) => bar.close);
  const highs = bars.map((bar) => bar.high);
  const lows = bars.map((bar) => bar.low);

  const macd = macdSeries(closes, 12 * SCALE_1H, 26 * SCALE_1H, 9 * SCALE_1H);
  const bb = bollingerBands(closes, 20 * SCALE_1H, 2);
  const stoch = stochasticSeries(highs, lows, closes, 14 * SCALE_1H, 3 * SCALE_1H);

  return {
    bars,
    closes,
    sma10: smaSeries(closes, 10 * SCALE_1H),
    sma20: smaSeries(closes, 20 * SCALE_1H),
    sma30: smaSeries(closes, 30 * SCALE_1H),
    sma50: smaSeries(closes, 50 * SCALE_1H),
    ema12: emaSeries(closes, 12 * SCALE_1H),
    ema26: emaSeries(closes, 26 * SCALE_1H),
    rsi14: rsiSeries(closes, 14 * SCALE_1H),
    macd: macd.macd,
    macdSignal: macd.signal,
    bbUpper: bb.upper,
    bbMiddle: bb.middle,
    bbLower: bb.lower,
    stochK: stoch.k,
    stochD: stoch.d,
    williamsR: williamsRSeries(highs, lows, closes, 14 * SCALE_1H),
    cci20: cciSeries(highs, lows, closes, 20 * SCALE_1H),
    priorHigh20: priorHighSeries(highs, 20 * SCALE_1H),
    priorLow10: priorLowSeries(lows, 10 * SCALE_1H),
    momentum10: rocSeries(closes, 10 * SCALE_1H),
  };
}

/** Igual que `computeEstimatedEntryPrice` (`./conditions.ts`) pero con todos los períodos reescalados por `SCALE_1H`. */
export function computeEstimatedEntryPrice1H(ctx: IndicatorContext, i: number, conditionId: string): number | null {
  return computeEstimatedEntryPrice(ctx, i, conditionId, SCALE_1H);
}

/** Mínimo de velas 1H para que SMA50 (reescalada a `50*SCALE_1H`) esté disponible en `i` e `i-1`. */
export const MIN_BARS_1H = 50 * SCALE_1H + 1;
