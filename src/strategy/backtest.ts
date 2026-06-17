import { buildIndicatorContext, computeEstimatedEntryPrice, DEFAULT_CONDITION_ID, IndicatorContext, OhlcBar } from './conditions';
import { buildIndicatorContext1H, computeEstimatedEntryPrice1H } from './conditions1h';
import { estimateConditionExprEntryPrice, evaluateConditionExpr, parseConditionExpr } from './conditionExpr';
import { ExitMode, RISK_PROFILE, RiskProfile } from './config';

export type BacktestExitReason = 'TP' | 'SL' | 'SELL_SIGNAL' | 'END_OF_DATA';

export interface BacktestTrade {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string | null;
  exitPrice: number | null;
  exitReason: BacktestExitReason | null;
  pnlPct: number | null;
}

export interface SymbolBacktestSummary {
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalReturnPct: number;
  avgReturnPct: number | null;
  maxDrawdownPct: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  summary: SymbolBacktestSummary;
}

/**
 * Simulación por símbolo de un par (condición de compra, condición de venta)
 * (Fase 7, `strategy/conditions.ts`) sobre velas diarias (OHLC), en % de retorno
 * por operación. Reutiliza las reglas de la orden real:
 * - Entrada: señal BUY de `buyCondition`. Entrada límite = min(estimatedEntryPrice,
 *   price) (proyectado con `buyCondition`), fill al día siguiente si el low de esa
 *   sesión toca el precio límite (si no, la orden no se llena).
 * - Salida (Fase A.1, `exitMode`):
 *   - `'bracket'` (default): por TP (+`riskProfile.takeProfitPct`) o SL
 *     (-`riskProfile.stopLossPct`) según high/low diario (SL gana si ambos se tocan
 *     el mismo día), o por señal SELL de `sellCondition` al cierre de esa sesión.
 *   - `'signal_only'`: sin TP/SL - solo por señal SELL de `sellCondition`.
 * - Si no hay salida antes de fin de datos, se marca a mercado (END_OF_DATA).
 *
 * Cuando `buyConditionId === sellConditionId` (caso `runBacktest`), el resultado
 * es idéntico al motor de una sola condición (Fase 6).
 */
export function runCombinedBacktest(
  symbol: string,
  bars: OhlcBar[],
  riskProfile: RiskProfile = RISK_PROFILE,
  buyConditionId: string = DEFAULT_CONDITION_ID,
  sellConditionId: string = DEFAULT_CONDITION_ID,
  exitMode: ExitMode = 'bracket'
): BacktestResult {
  return runCombinedBacktestWith(
    symbol,
    bars,
    riskProfile,
    buyConditionId,
    sellConditionId,
    exitMode,
    buildIndicatorContext,
    computeEstimatedEntryPrice
  );
}

/**
 * Igual que `runCombinedBacktest`, pero sobre velas de 1 HORA con los períodos de
 * indicador reescalados por `SCALE_1H=8` (`strategy/conditions1h.ts`). Usado por el
 * sistema híbrido (`strategy/hybridConfig.ts`) para los símbolos tier 1 (combo 1H
 * reemplaza el pick 1D) y tier 2/'shadow' (combo 1H informativo, además del pick 1D).
 */
export function runCombinedBacktest1H(
  symbol: string,
  bars: OhlcBar[],
  riskProfile: RiskProfile = RISK_PROFILE,
  buyConditionId: string = DEFAULT_CONDITION_ID,
  sellConditionId: string = DEFAULT_CONDITION_ID,
  exitMode: ExitMode = 'bracket'
): BacktestResult {
  return runCombinedBacktestWith(
    symbol,
    bars,
    riskProfile,
    buyConditionId,
    sellConditionId,
    exitMode,
    buildIndicatorContext1H,
    computeEstimatedEntryPrice1H
  );
}

/** Lógica común a `runCombinedBacktest` (velas 1D) y `runCombinedBacktest1H` (velas 1H) - difieren solo en cómo se construye el `IndicatorContext` y el precio estimado de entrada. */
function runCombinedBacktestWith(
  symbol: string,
  bars: OhlcBar[],
  riskProfile: RiskProfile,
  buyConditionId: string,
  sellConditionId: string,
  exitMode: ExitMode,
  buildCtx: (bars: OhlcBar[]) => IndicatorContext,
  computeEntryPrice: (ctx: IndicatorContext, i: number, conditionId: string) => number | null
): BacktestResult {
  const buyExpr = parseConditionExpr(buyConditionId);
  const sellExpr = parseConditionExpr(sellConditionId);
  const ctx = buildCtx(bars);
  const trades: BacktestTrade[] = [];

  // i=1 (no i=0) para que ctx[i-1] sea siempre un índice válido del array;
  // las condiciones devuelven HOLD por sí solas mientras los indicadores sean null.
  let i = 1;

  while (i < bars.length) {
    const isBuy = evaluateConditionExpr(buyExpr, ctx, i, 'BUY');

    if (isBuy && i + 1 < bars.length) {
      const estimatedEntryPrice = estimateConditionExprEntryPrice(buyExpr, ctx, i, computeEntryPrice);
      const price = ctx.closes[i];
      const entryPrice = estimatedEntryPrice !== null ? Math.min(estimatedEntryPrice, price) : price;

      const fillDay = bars[i + 1];

      if (fillDay.low <= entryPrice) {
        const takeProfitPrice = exitMode === 'bracket' ? entryPrice * (1 + riskProfile.takeProfitPct) : null;
        const stopLossPrice = exitMode === 'bracket' ? entryPrice * (1 - riskProfile.stopLossPct) : null;

        let exitDate: string | null = null;
        let exitPrice: number | null = null;
        let exitReason: BacktestExitReason | null = null;
        let exitIndex = bars.length - 1;

        for (let j = i + 1; j < bars.length; j++) {
          const day = bars[j];

          if (stopLossPrice !== null && day.low <= stopLossPrice) {
            exitDate = day.ts;
            exitPrice = stopLossPrice;
            exitReason = 'SL';
            exitIndex = j;
            break;
          }

          if (takeProfitPrice !== null && day.high >= takeProfitPrice) {
            exitDate = day.ts;
            exitPrice = takeProfitPrice;
            exitReason = 'TP';
            exitIndex = j;
            break;
          }

          if (evaluateConditionExpr(sellExpr, ctx, j, 'SELL')) {
            exitDate = day.ts;
            exitPrice = day.close;
            exitReason = 'SELL_SIGNAL';
            exitIndex = j;
            break;
          }
        }

        if (exitDate === null || exitPrice === null) {
          const lastDay = bars[bars.length - 1];
          exitDate = lastDay.ts;
          exitPrice = lastDay.close;
          exitReason = 'END_OF_DATA';
          exitIndex = bars.length - 1;
        }

        trades.push({
          symbol,
          entryDate: fillDay.ts,
          entryPrice,
          exitDate,
          exitPrice,
          exitReason,
          pnlPct: ((exitPrice - entryPrice) / entryPrice) * 100,
        });

        i = exitIndex + 1;
        continue;
      }
    }

    i += 1;
  }

  return { trades, summary: summarizeTrades(symbol, trades) };
}

/** Caso particular de `runCombinedBacktest` con la misma condición para comprar y vender (Fase 6). */
export function runBacktest(
  symbol: string,
  bars: OhlcBar[],
  riskProfile: RiskProfile = RISK_PROFILE,
  conditionId: string = DEFAULT_CONDITION_ID,
  exitMode: ExitMode = 'bracket'
): BacktestResult {
  return runCombinedBacktest(symbol, bars, riskProfile, conditionId, conditionId, exitMode);
}

function summarizeTrades(symbol: string, trades: BacktestTrade[]): SymbolBacktestSummary {
  const wins = trades.filter((trade) => (trade.pnlPct ?? 0) > 0).length;
  const losses = trades.filter((trade) => (trade.pnlPct ?? 0) <= 0).length;

  let equity = 1;
  let peak = 1;
  let maxDrawdownPct = 0;

  for (const trade of trades) {
    equity *= 1 + (trade.pnlPct ?? 0) / 100;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
  }

  return {
    symbol,
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? (wins / trades.length) * 100 : null,
    totalReturnPct: (equity - 1) * 100,
    avgReturnPct: trades.length > 0
      ? trades.reduce((sum, trade) => sum + (trade.pnlPct ?? 0), 0) / trades.length
      : null,
    maxDrawdownPct,
  };
}
