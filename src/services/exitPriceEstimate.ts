import { Pool } from 'pg';
import { getRecentOhlcBars } from './marketStore';
import { buildIndicatorContext, computeEstimatedExitLevel, DEFAULT_CONDITION_ID } from '../strategy/conditions';
import { describeConditionExpr, estimateConditionExprExitPrice, evaluateConditionExpr, labelConditionExpr, parseConditionExpr } from '../strategy/conditionExpr';
import { MULTI_CONDITION_OVERRIDES } from '../strategy/multiConditionOverrides';
import { getMainSymbolConditions } from './conditionStore';

const BARS_LOOKBACK = 100;
const MIN_BARS = 51;

export interface ExitPriceEstimate {
  price: number | null;
  source: string | null;
  computedAt: string;
  reason: string | null;
}

/**
 * Precio estimado de salida para un símbolo, calculado SIEMPRE en base a la condición de
 * venta activa y el estado ACTUAL del indicador (no el histórico al momento de compra) -
 * independiente de `bot_settings.exit_mode` (a diferencia de `SignalResult.estimatedExitPrice`,
 * que solo existe en modo 'bracket'). Usado por `GET /api/positions/:symbol/exit-price` y el
 * botón "Vender al precio estimado" de la tab Operaciones.
 */
export async function computeExitPriceEstimate(pool: Pool, symbol: string): Promise<ExitPriceEstimate> {
  const computedAt = new Date().toISOString();
  const bars = await getRecentOhlcBars(pool, symbol, BARS_LOOKBACK);

  if (bars.length < MIN_BARS) {
    return { price: null, source: null, computedAt, reason: 'insufficient_history' };
  }

  const symbolConditions = await getMainSymbolConditions(pool);
  const pick = symbolConditions.get(symbol);
  const override = MULTI_CONDITION_OVERRIDES[symbol];
  const sellConditionId = override?.sellExpr ?? pick?.sellConditionId ?? DEFAULT_CONDITION_ID;

  const sellExpr = parseConditionExpr(sellConditionId);
  const ctx = buildIndicatorContext(bars);
  const i = bars.length - 1;

  const price = estimateConditionExprExitPrice(sellExpr, ctx, i, computeEstimatedExitLevel);

  if (price === null) {
    return { price: null, source: labelConditionExpr(sellConditionId), computedAt, reason: 'no_projectable' };
  }

  const sellFiredNow = evaluateConditionExpr(sellExpr, ctx, i, 'SELL');
  const detail = describeConditionExpr(sellExpr, ctx, i);
  return {
    price,
    source: `${labelConditionExpr(sellConditionId)}${sellFiredNow ? ' (señal SELL activa ahora)' : ''} - ${detail}`,
    computedAt,
    reason: null,
  };
}
