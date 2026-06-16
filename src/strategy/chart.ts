import { buildIndicatorContext, IndicatorContext, OhlcBar } from './conditions';
import { buildIndicatorContext1H } from './conditions1h';

export interface ChartPoint {
  ts: string;
  close: number;
  sma10: number | null;
  sma20: number | null;
  sma30: number | null;
  sma50: number | null;
  ema12: number | null;
  ema26: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  stochK: number | null;
  stochD: number | null;
  williamsR: number | null;
  cci20: number | null;
  priorHigh20: number | null;
  priorLow10: number | null;
}

/**
 * Construye la serie de precio + todos los indicadores del catálogo de 12 condiciones
 * (Fase 6) para graficar el histórico de un símbolo. El frontend elige qué campos
 * mostrar como overlay según la condición activa del símbolo (`CONDITION_CHART_CONFIG`
 * en `public/app.js`).
 */
export function buildChartSeries(bars: OhlcBar[]): ChartPoint[] {
  return buildChartSeriesWith(bars, buildIndicatorContext);
}

/**
 * Igual que `buildChartSeries`, pero sobre velas de 1 HORA con los períodos de
 * indicador reescalados por `SCALE_1H=8` (`strategy/conditions1h.ts`). Usado para el
 * gráfico de los símbolos del sistema híbrido (`strategy/hybridConfig.ts`), cuya
 * condición activa se evalúa sobre este contexto.
 */
export function buildChartSeries1H(bars: OhlcBar[]): ChartPoint[] {
  return buildChartSeriesWith(bars, buildIndicatorContext1H);
}

function buildChartSeriesWith(bars: OhlcBar[], buildCtx: (bars: OhlcBar[]) => IndicatorContext): ChartPoint[] {
  const ctx = buildCtx(bars);

  return bars.map((bar, i) => ({
    ts: bar.ts,
    close: bar.close,
    sma10: ctx.sma10[i],
    sma20: ctx.sma20[i],
    sma30: ctx.sma30[i],
    sma50: ctx.sma50[i],
    ema12: ctx.ema12[i],
    ema26: ctx.ema26[i],
    rsi14: ctx.rsi14[i],
    macd: ctx.macd[i],
    macdSignal: ctx.macdSignal[i],
    bbUpper: ctx.bbUpper[i],
    bbMiddle: ctx.bbMiddle[i],
    bbLower: ctx.bbLower[i],
    stochK: ctx.stochK[i],
    stochD: ctx.stochD[i],
    williamsR: ctx.williamsR[i],
    cci20: ctx.cci20[i],
    priorHigh20: ctx.priorHigh20[i],
    priorLow10: ctx.priorLow10[i],
  }));
}
