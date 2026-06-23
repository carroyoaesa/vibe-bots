import { buildIndicatorContext, computeEstimatedEntryPrice, DEFAULT_CONDITION_ID, IndicatorContext, OhlcBar } from './conditions';
import { buildIndicatorContext1H, computeEstimatedEntryPrice1H, MIN_BARS_1H } from './conditions1h';
import { describeConditionExpr, estimateConditionExprEntryPrice, evaluateConditionExpr, labelConditionExpr, parseConditionExpr } from './conditionExpr';
import { ExitMode, RISK_PROFILE, RiskProfile } from './config';

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

function emptySignal(symbol: string, buyConditionExpr: string, buyConditionLabel: string, sellConditionExpr: string, sellConditionLabel: string, reason: string, price = 0): SignalResult {
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
    buyConditionId: buyConditionExpr,
    buyConditionLabel,
    sellConditionId: sellConditionExpr,
    sellConditionLabel,
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
  exitMode: ExitMode,
  minBars: number,
  insufficientReason: string,
  buildCtx: (bars: OhlcBar[]) => IndicatorContext,
  computeEntryPrice: (ctx: IndicatorContext, i: number, conditionId: string) => number | null
): SignalResult {
  const buyExpr = parseConditionExpr(buyConditionId);
  const sellExpr = parseConditionExpr(sellConditionId);
  const buyLabel = labelConditionExpr(buyConditionId);
  const sellLabel = labelConditionExpr(sellConditionId);

  if (bars.length === 0) {
    return emptySignal(symbol, buyConditionId, buyLabel, sellConditionId, sellLabel, 'Sin datos en market_bars (ejecutar npm run ingest primero)');
  }

  if (bars.length < minBars) {
    return emptySignal(symbol, buyConditionId, buyLabel, sellConditionId, sellLabel, insufficientReason, bars[bars.length - 1].close);
  }

  const ctx = buildCtx(bars);
  const i = bars.length - 1;

  const estimatedEntryPrice = estimateConditionExprEntryPrice(buyExpr, ctx, i, computeEntryPrice);
  // El TP solo es un precio real de salida en modo 'bracket' (única orden que lo coloca en
  // Alpaca, ver placeBracketBuyOrder). En 'signal_only' la salida es ÚNICAMENTE por señal
  // SELL - mostrar un "precio est. de salida" ahí sería un TP teórico que ninguna orden usa
  // (bug corregido: antes se calculaba igual en ambos modos, ver CLAUDE.md Fase 8.1).
  const estimatedExitPrice = (estimatedEntryPrice !== null && exitMode === 'bracket' && riskProfile.takeProfitPct > 0)
    ? estimatedEntryPrice * (1 + riskProfile.takeProfitPct)
    : null;

  const buyFires = evaluateConditionExpr(buyExpr, ctx, i, 'BUY');
  const sellFires = evaluateConditionExpr(sellExpr, ctx, i, 'SELL');
  const action: SignalAction = buyFires ? 'BUY' : sellFires ? 'SELL' : 'HOLD';

  const sameExpr = buyConditionId === sellConditionId;
  // Se pide describeConditionExpr() una vez por acción (BUY/SELL) aunque sameExpr, para que la
  // marca "→ " resalte la hoja correcta en cada lado (la misma expresión puede tener una hoja
  // que dispara BUY y otra distinta que dispara SELL, ver conditionExpr.ts).
  const buyDetails = describeConditionExpr(buyExpr, ctx, i, 'BUY');
  const sellDetails = describeConditionExpr(sellExpr, ctx, i, 'SELL');

  let reason: string;
  if (action === 'BUY') {
    reason = `BUY por "${buyLabel}" (${buyDetails})`;
  } else if (action === 'SELL') {
    reason = `SELL por "${sellLabel}" (${sellDetails})`;
  } else if (sameExpr) {
    reason = `Sin señal (condición activa: "${buyLabel}"; ${buyDetails})`;
  } else {
    reason = `Sin señal (compra: "${buyLabel}" ${buyDetails}; venta: "${sellLabel}" ${sellDetails})`;
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
    buyConditionId,
    buyConditionLabel: buyLabel,
    sellConditionId,
    sellConditionLabel: sellLabel,
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
  sellConditionId: string = DEFAULT_CONDITION_ID,
  exitMode: ExitMode = 'bracket'
): SignalResult {
  return computeSignalWith(
    symbol,
    bars,
    riskProfile,
    buyConditionId,
    sellConditionId,
    exitMode,
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
  sellConditionId: string = DEFAULT_CONDITION_ID,
  exitMode: ExitMode = 'bracket'
): SignalResult {
  return computeSignalWith(
    symbol,
    bars,
    riskProfile,
    buyConditionId,
    sellConditionId,
    exitMode,
    MIN_BARS_1H,
    `Histórico 1H insuficiente para calcular indicadores (mínimo ${MIN_BARS_1H} velas)`,
    buildIndicatorContext1H,
    computeEstimatedEntryPrice1H
  );
}
