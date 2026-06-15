import { buildIndicatorContext, computeEstimatedEntryPrice, CONDITIONS, DEFAULT_CONDITION_ID, OhlcBar } from './conditions';
import { RISK_PROFILE, RiskProfile } from './config';

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
 * Simulación por símbolo de la condición de estado activa (Fase 6, `strategy/conditions.ts`)
 * sobre velas diarias (OHLC), en % de retorno por operación. Reutiliza las reglas de la
 * bracket order real:
 * - Entrada límite = min(estimatedEntryPrice, price), fill al día siguiente si
 *   el low de esa sesión toca el precio límite (si no, la orden no se llena).
 * - Salida por TP (+6%) o SL (-3%) según high/low diario (SL gana si ambos se
 *   tocan el mismo día), o por señal SELL de la misma condición al cierre de esa sesión.
 * - Si no hay salida antes de fin de datos, se marca a mercado (END_OF_DATA).
 */
export function runBacktest(
  symbol: string,
  bars: OhlcBar[],
  riskProfile: RiskProfile = RISK_PROFILE,
  conditionId: string = DEFAULT_CONDITION_ID
): BacktestResult {
  const condition = CONDITIONS.find((c) => c.id === conditionId) ?? CONDITIONS[0];
  const ctx = buildIndicatorContext(bars);
  const trades: BacktestTrade[] = [];

  // i=1 (no i=0) para que ctx[i-1] sea siempre un índice válido del array;
  // las condiciones devuelven HOLD por sí solas mientras los indicadores sean null.
  let i = 1;

  while (i < bars.length) {
    const action = condition.evaluate(ctx, i);

    if (action === 'BUY' && i + 1 < bars.length) {
      const estimatedEntryPrice = computeEstimatedEntryPrice(ctx, i, condition.id);
      const price = ctx.closes[i];
      const entryPrice = estimatedEntryPrice !== null ? Math.min(estimatedEntryPrice, price) : price;

      const fillDay = bars[i + 1];

      if (fillDay.low <= entryPrice) {
        const takeProfitPrice = entryPrice * (1 + riskProfile.takeProfitPct);
        const stopLossPrice = entryPrice * (1 - riskProfile.stopLossPct);

        let exitDate: string | null = null;
        let exitPrice: number | null = null;
        let exitReason: BacktestExitReason | null = null;
        let exitIndex = bars.length - 1;

        for (let j = i + 1; j < bars.length; j++) {
          const day = bars[j];

          if (day.low <= stopLossPrice) {
            exitDate = day.ts;
            exitPrice = stopLossPrice;
            exitReason = 'SL';
            exitIndex = j;
            break;
          }

          if (day.high >= takeProfitPrice) {
            exitDate = day.ts;
            exitPrice = takeProfitPrice;
            exitReason = 'TP';
            exitIndex = j;
            break;
          }

          if (condition.evaluate(ctx, j) === 'SELL') {
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
