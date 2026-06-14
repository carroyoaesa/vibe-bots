import { computeSignal } from './signals';
import { RISK_PROFILE, RiskProfile, STRATEGY_PARAMS } from './config';

export interface BacktestBar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

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
 * Simulación por símbolo de la estrategia Fase 2 sobre velas diarias (OHLC), en % de
 * retorno por operación. Reutiliza las reglas de la bracket order real:
 * - Entrada límite = min(estimatedEntryPrice, price), fill al día siguiente si
 *   el low de esa sesión toca el precio límite (si no, la orden no se llena).
 * - Salida por TP (+6%) o SL (-3%) según high/low diario (SL gana si ambos se
 *   tocan el mismo día), o por señal SELL al cierre de esa sesión.
 * - Si no hay salida antes de fin de datos, se marca a mercado (END_OF_DATA).
 */
export function runBacktest(symbol: string, bars: BacktestBar[], riskProfile: RiskProfile = RISK_PROFILE): BacktestResult {
  const { smaSlowPeriod } = STRATEGY_PARAMS;
  const closes = bars.map((bar) => bar.close);
  const trades: BacktestTrade[] = [];

  // computeSignal solo deja de devolver HOLD por "histórico insuficiente" a partir
  // de smaSlowPeriod + 1 cierres (índice smaSlowPeriod, base 0).
  let i = smaSlowPeriod;

  while (i < bars.length) {
    const signal = computeSignal(symbol, closes.slice(0, i + 1), riskProfile);

    if (signal.signal === 'BUY' && i + 1 < bars.length) {
      const entryPrice = signal.estimatedEntryPrice !== null
        ? Math.min(signal.estimatedEntryPrice, signal.price)
        : signal.price;

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

          const exitSignal = computeSignal(symbol, closes.slice(0, j + 1), riskProfile);
          if (exitSignal.signal === 'SELL') {
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
