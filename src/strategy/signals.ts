import { buildIndicatorContext, computeEstimatedEntryPrice, CONDITIONS, DEFAULT_CONDITION_ID, IndicatorContext, OhlcBar } from './conditions';
import { buildIndicatorContext1H, computeEstimatedEntryPrice1H, MIN_BARS_1H } from './conditions1h';
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

function emptySignal(symbol: string, buyCondition: { id: string; label: string }, sellCondition: { id: string; label: string }, reason: string, price = 0): SignalResult {
  return {
    symbol,
    price,
    smaFast: null,
    smaSlow: null,
    rsi: null,
    momentum: null,
    estimatedEntryPrice: null,
    estimatedExitPrice: null,
    signal: 'HOLD',
    reason,
    buyConditionId: buyCondition.id,
    buyConditionLabel: buyCondition.label,
    sellConditionId: sellCondition.id,
    sellConditionLabel: sellCondition.label,
  };
}

/**
 * Lógica común a `computeSignal` (velas 1D) y `computeSignal1H` (velas 1H,
 * `strategy/conditions1h.ts`, Fase híbrido) - difieren solo en cómo se construye el
 * `IndicatorContext`, el precio estimado de entrada y el mínimo de velas requerido.
 */
function computeSignalWith(
  symbol: string,
  bars: OhlcBar[],
  riskProfile: RiskProfile,
  buyConditionId: string,
  sellConditionId: string,
  minBars: number,
  insufficientReason: string,
  buildCtx: (bars: OhlcBar[]) => IndicatorContext,
  computeEntryPrice: (ctx: IndicatorContext, i: number, conditionId: string) => number | null
): SignalResult {
  const buyCondition = CONDITIONS.find((c) => c.id === buyConditionId) ?? CONDITIONS[0];
  const sellCondition = CONDITIONS.find((c) => c.id === sellConditionId) ?? CONDITIONS[0];

  if (bars.length === 0) {
    return emptySignal(symbol, buyCondition, sellCondition, 'Sin datos en market_bars (ejecutar npm run ingest primero)');
  }

  if (bars.length < minBars) {
    return emptySignal(symbol, buyCondition, sellCondition, insufficientReason, bars[bars.length - 1].close);
  }

  const ctx = buildCtx(bars);
  const i = bars.length - 1;

  const estimatedEntryPrice = computeEntryPrice(ctx, i, buyCondition.id);
  // takeProfitPct=0 → modo signal_only sin TP (p.ej. PARALLEL_RISK_PROFILE): salida indefinida.
  const estimatedExitPrice = (estimatedEntryPrice !== null && riskProfile.takeProfitPct > 0)
    ? estimatedEntryPrice * (1 + riskProfile.takeProfitPct)
    : null;

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

/**
 * Señal de trading para `symbol` según el par (condición de compra, condición de venta)
 * activo (Fase 7, `symbol_conditions` -> `buyConditionId`/`sellConditionId`, default
 * `DEFAULT_CONDITION_ID` para ambas), sobre velas DIARIAS.
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
  return computeSignalWith(
    symbol,
    bars,
    riskProfile,
    buyConditionId,
    sellConditionId,
    MIN_BARS,
    `Histórico insuficiente para calcular indicadores (mínimo ${MIN_BARS} velas)`,
    buildIndicatorContext,
    computeEstimatedEntryPrice
  );
}

/**
 * Igual que `computeSignal`, pero sobre velas de 1 HORA con los períodos de indicador
 * reescalados por `SCALE_1H=8` (`strategy/conditions1h.ts`). Usado por el sistema
 * híbrido (`strategy/hybridConfig.ts`) para los símbolos Tier 1 (in-place), Tier 2
 * (paralelo) y 'shadow'.
 */
export function computeSignal1H(
  symbol: string,
  bars: OhlcBar[],
  riskProfile: RiskProfile = RISK_PROFILE,
  buyConditionId: string = DEFAULT_CONDITION_ID,
  sellConditionId: string = DEFAULT_CONDITION_ID
): SignalResult {
  return computeSignalWith(
    symbol,
    bars,
    riskProfile,
    buyConditionId,
    sellConditionId,
    MIN_BARS_1H,
    `Histórico 1H insuficiente para calcular indicadores (mínimo ${MIN_BARS_1H} velas)`,
    buildIndicatorContext1H,
    computeEstimatedEntryPrice1H
  );
}
