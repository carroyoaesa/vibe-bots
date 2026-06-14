import { smaSeries, rsiSeries } from './indicators';
import { STRATEGY_PARAMS } from './config';

export interface ChartPoint {
  ts: string;
  close: number;
  smaFast: number | null;
  smaSlow: number | null;
  rsi: number | null;
}

/** Construye la serie de precio + SMA10/SMA30 + RSI(14) para graficar el histórico de un símbolo. */
export function buildChartSeries(bars: { ts: string; close: number }[]): ChartPoint[] {
  const closes = bars.map((bar) => bar.close);
  const smaFastSeries = smaSeries(closes, STRATEGY_PARAMS.smaFastPeriod);
  const smaSlowSeries = smaSeries(closes, STRATEGY_PARAMS.smaSlowPeriod);
  const rsiValues = rsiSeries(closes, STRATEGY_PARAMS.rsiPeriod);

  return bars.map((bar, index) => ({
    ts: bar.ts,
    close: bar.close,
    smaFast: smaFastSeries[index],
    smaSlow: smaSlowSeries[index],
    rsi: rsiValues[index],
  }));
}
