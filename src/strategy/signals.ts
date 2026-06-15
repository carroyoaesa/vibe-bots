import { buildIndicatorContext, computeEstimatedEntryPrice, CONDITIONS, DEFAULT_CONDITION_ID, OhlcBar } from './conditions';
import { RISK_PROFILE, RiskProfile } from './config';

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
  buyConditionId: string;
  buyConditionLabel: string;
  sellConditionId: string;
  sellConditionLabel: string;
}

// Mínimo de velas para que SMA50 (el indicador de mayor período entre las 12
// condiciones de strategy/conditions.ts) esté disponible en `i` e `i-1`.
const MIN_BARS = 51;

/**
 * Señal de trading para `symbol` según el par (condición de compra, condición de venta)
 * activo (Fase 7, `symbol_conditions` -> `buyConditionId`/`sellConditionId`, default
 * `DEFAULT_CONDITION_ID` para ambas).
 *
 * SMA10/SMA30/RSI14/Momentum10 se calculan siempre como contexto general (no
 * dependen de las condiciones activas) - se usan en el dashboard, `attractivenessScore`
 * y el contexto de IA, independientemente de qué condición genera la señal.
 */
export function computeSignal(
  symbol: string,
  bars: OhlcBar[],
  riskProfile: RiskProfile = RISK_PROFILE,
  buyConditionId: string = DEFAULT_CONDITION_ID,
  sellConditionId: string = DEFAULT_CONDITION_ID
): SignalResult {
  const buyCondition = CONDITIONS.find((c) => c.id === buyConditionId) ?? CONDITIONS[0];
  const sellCondition = CONDITIONS.find((c) => c.id === sellConditionId) ?? CONDITIONS[0];

  if (bars.length === 0) {
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
      buyConditionId: buyCondition.id,
      buyConditionLabel: buyCondition.label,
      sellConditionId: sellCondition.id,
      sellConditionLabel: sellCondition.label,
    };
  }

  if (bars.length < MIN_BARS) {
    return {
      symbol,
      price: bars[bars.length - 1].close,
      smaFast: null,
      smaSlow: null,
      rsi: null,
      momentum: null,
      estimatedEntryPrice: null,
      estimatedExitPrice: null,
      signal: 'HOLD',
      reason: `Histórico insuficiente para calcular indicadores (mínimo ${MIN_BARS} velas)`,
      buyConditionId: buyCondition.id,
      buyConditionLabel: buyCondition.label,
      sellConditionId: sellCondition.id,
      sellConditionLabel: sellCondition.label,
    };
  }

  const ctx = buildIndicatorContext(bars);
  const i = bars.length - 1;

  const estimatedEntryPrice = computeEstimatedEntryPrice(ctx, i, buyCondition.id);
  const estimatedExitPrice = estimatedEntryPrice !== null ? estimatedEntryPrice * (1 + riskProfile.takeProfitPct) : null;

  const buyAction = buyCondition.evaluate(ctx, i);
  const sellAction = sellCondition.evaluate(ctx, i);
  const action: SignalAction = buyAction === 'BUY' ? 'BUY' : sellAction === 'SELL' ? 'SELL' : 'HOLD';

  const sameCondition = buyCondition.id === sellCondition.id;
  const buyDetails = buyCondition.describe(ctx, i);
  const sellDetails = sameCondition ? buyDetails : sellCondition.describe(ctx, i);

  let reason: string;
  if (action === 'BUY') {
    reason = `BUY por "${buyCondition.label}" (${buyDetails})`;
  } else if (action === 'SELL') {
    reason = `SELL por "${sellCondition.label}" (${sellDetails})`;
  } else if (sameCondition) {
    reason = `Sin señal (condición activa: "${buyCondition.label}"; ${buyDetails})`;
  } else {
    reason = `Sin señal (compra: "${buyCondition.label}" ${buyDetails}; venta: "${sellCondition.label}" ${sellDetails})`;
  }

  return {
    symbol,
    price: ctx.closes[i],
    smaFast: ctx.sma10[i],
    smaSlow: ctx.sma30[i],
    rsi: ctx.rsi14[i],
    momentum: ctx.momentum10[i],
    estimatedEntryPrice,
    estimatedExitPrice,
    signal: action,
    reason,
    buyConditionId: buyCondition.id,
    buyConditionLabel: buyCondition.label,
    sellConditionId: sellCondition.id,
    sellConditionLabel: sellCondition.label,
  };
}
