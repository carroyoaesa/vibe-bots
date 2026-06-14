import { sma, rsi, momentum, estimateEntryPrice } from './indicators';
import { STRATEGY_PARAMS, RISK_PROFILE, RiskProfile } from './config';

export type SignalAction = 'BUY' | 'SELL' | 'HOLD';

export interface SignalResult {
  symbol: string;
  price: number;
  smaFast: number | null;
  smaSlow: number | null;
  rsi: number | null;
  momentum: number | null;
  estimatedEntryPrice: number | null;
  estimatedExitPrice: number | null;
  signal: SignalAction;
  reason: string;
}

/**
 * Estrategia Fase 2: cruce de medias móviles (SMA10/SMA30) confirmado por RSI y momentum.
 *
 * - BUY: SMA rápida cruza por encima de la lenta, sin sobrecompra (RSI < umbral) y con momentum positivo.
 * - SELL: SMA rápida cruza por debajo de la lenta (señal de salida de tendencia).
 * - HOLD: sin cruce, o datos históricos insuficientes.
 */
export function computeSignal(symbol: string, closes: number[], riskProfile: RiskProfile = RISK_PROFILE): SignalResult {
  const { smaFastPeriod, smaSlowPeriod, rsiPeriod, rsiOverbought, momentumPeriod } = STRATEGY_PARAMS;

  if (closes.length === 0) {
    return {
      symbol,
      price: 0,
      smaFast: null,
      smaSlow: null,
      rsi: null,
      momentum: null,
      estimatedEntryPrice: null,
      estimatedExitPrice: null,
      signal: 'HOLD',
      reason: 'Sin datos en market_bars (ejecutar npm run ingest primero)',
    };
  }

  const price = closes[closes.length - 1];
  const smaFast = sma(closes, smaFastPeriod);
  const smaSlow = sma(closes, smaSlowPeriod);
  const smaFastPrev = sma(closes.slice(0, -1), smaFastPeriod);
  const smaSlowPrev = sma(closes.slice(0, -1), smaSlowPeriod);
  const rsiValue = rsi(closes, rsiPeriod);
  const momentumValue = momentum(closes, momentumPeriod);

  if (smaFast === null || smaSlow === null || smaFastPrev === null || smaSlowPrev === null) {
    return {
      symbol,
      price,
      smaFast,
      smaSlow,
      rsi: rsiValue,
      momentum: momentumValue,
      estimatedEntryPrice: null,
      estimatedExitPrice: null,
      signal: 'HOLD',
      reason: `Histórico insuficiente para SMA${smaSlowPeriod} (se requieren ${smaSlowPeriod + 1} cierres)`,
    };
  }

  const estimatedEntryPrice = estimateEntryPrice(closes, smaFastPeriod, smaSlow);
  // Precio objetivo de salida (take-profit) a partir del precio estimado de entrada.
  const estimatedExitPrice = estimatedEntryPrice !== null ? estimatedEntryPrice * (1 + riskProfile.takeProfitPct) : null;

  const crossedUp = smaFastPrev <= smaSlowPrev && smaFast > smaSlow;
  const crossedDown = smaFastPrev >= smaSlowPrev && smaFast < smaSlow;

  if (crossedUp && (rsiValue === null || rsiValue < rsiOverbought) && (momentumValue === null || momentumValue > 0)) {
    return {
      symbol,
      price,
      smaFast,
      smaSlow,
      rsi: rsiValue,
      momentum: momentumValue,
      estimatedEntryPrice,
      estimatedExitPrice,
      signal: 'BUY',
      reason: `SMA${smaFastPeriod} cruzó sobre SMA${smaSlowPeriod}, RSI=${rsiValue?.toFixed(1) ?? 'n/a'}, momentum=${momentumValue?.toFixed(2) ?? 'n/a'}%`,
    };
  }

  if (crossedDown) {
    return {
      symbol,
      price,
      smaFast,
      smaSlow,
      rsi: rsiValue,
      momentum: momentumValue,
      estimatedEntryPrice,
      estimatedExitPrice,
      signal: 'SELL',
      reason: `SMA${smaFastPeriod} cruzó bajo SMA${smaSlowPeriod}`,
    };
  }

  return {
    symbol,
    price,
    smaFast,
    smaSlow,
    rsi: rsiValue,
    momentum: momentumValue,
    estimatedEntryPrice,
    estimatedExitPrice,
    signal: 'HOLD',
    reason: 'Sin cruce de medias móviles',
  };
}
