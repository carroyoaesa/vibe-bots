import { Pool } from 'pg';
import { WATCHLIST } from './watchlist';
import { getAllBars } from './services/marketStore';
import { runCombinedBacktest, BacktestResult, BacktestTrade, SymbolBacktestSummary } from './strategy/backtest';
import { CONDITIONS, DEFAULT_CONDITION_ID } from './strategy/conditions';
import { saveBacktestRun } from './services/backtestStore';
import { setupSettingsSchema, getSettings } from './services/settingsStore';
import { setupConditionSchema, saveSymbolConditions, SymbolConditionPick } from './services/conditionStore';
import { STRATEGY_PARAMS } from './strategy/config';
import { HYBRID_CONFIG } from './strategy/hybridConfig';

export interface PortfolioBacktestSummary {
  symbols: number;
  totalTrades: number;
  avgReturnPct: number | null;
  avgWinRatePct: number | null;
  bestSymbol: string | null;
  worstSymbol: string | null;
}

export interface BacktestRunResult {
  runId: number;
  startDate: string | null;
  endDate: string | null;
  symbolSummaries: SymbolBacktestSummary[];
  portfolio: PortfolioBacktestSummary;
  trades: BacktestTrade[];
}

export async function runBacktestForWatchlist(pool: Pool): Promise<BacktestRunResult> {
  await setupSettingsSchema(pool);
  await setupConditionSchema(pool);
  const settings = await getSettings(pool);

  const symbolSummaries: SymbolBacktestSummary[] = [];
  const trades: BacktestTrade[] = [];
  const picks: SymbolConditionPick[] = [];
  let startDate: string | null = null;
  let endDate: string | null = null;

  const defaultCondition = CONDITIONS.find((c) => c.id === DEFAULT_CONDITION_ID) ?? CONDITIONS[0];

  for (const symbol of WATCHLIST) {
    const bars = await getAllBars(pool, symbol);
    const hybrid = HYBRID_CONFIG[symbol];

    if (bars.length > 0) {
      const firstDate = bars[0].ts.slice(0, 10);
      const lastDate = bars[bars.length - 1].ts.slice(0, 10);
      if (startDate === null || firstDate < startDate) startDate = firstDate;
      if (endDate === null || lastDate > endDate) endDate = lastDate;
    }

    if (hybrid) {
      // Todos los símbolos híbridos (Tier 1 SPY/XLU, Tier 2 MS/QQQM, shadow SCHD):
      // el análisis de 5.8 años muestra que 1Day siempre supera a 1Hour en los 20 símbolos,
      // por lo que el pick de portfolio es siempre el mejor combo 1Day del 144-matrix.
      // La 1H del HYBRID_CONFIG se guarda como informational pero no alimenta portfolio.
      // plus run HYBRID_CONFIG 1H combo for informational '1Hour' pick (NOT in portfolio).
      if (bars.length === 0) {
        symbolSummaries.push({ symbol, trades: 0, wins: 0, losses: 0, winRate: null, totalReturnPct: 0, avgReturnPct: null, maxDrawdownPct: 0 });
        picks.push({ symbol, timeframe: '1Day', buyConditionId: defaultCondition.id, buyConditionLabel: defaultCondition.label, sellConditionId: defaultCondition.id, sellConditionLabel: defaultCondition.label, trades: 0, winRatePct: null, totalReturnPct: 0, avgReturnPct: null, maxDrawdownPct: 0 });
      } else {
        let best: BacktestResult = runCombinedBacktest(symbol, bars, settings.riskProfile, defaultCondition.id, defaultCondition.id, settings.exitMode);
        let bestBuyCondition = defaultCondition;
        let bestSellCondition = defaultCondition;

        for (const buyCondition of CONDITIONS) {
          for (const sellCondition of CONDITIONS) {
            if (buyCondition.id === defaultCondition.id && sellCondition.id === defaultCondition.id) continue;
            const result = runCombinedBacktest(symbol, bars, settings.riskProfile, buyCondition.id, sellCondition.id, settings.exitMode);
            if (result.summary.trades > 0 && (best.summary.trades === 0 || result.summary.totalReturnPct > best.summary.totalReturnPct)) {
              best = result;
              bestBuyCondition = buyCondition;
              bestSellCondition = sellCondition;
            }
          }
        }

        symbolSummaries.push(best.summary);
        trades.push(...best.trades);
        picks.push({
          symbol,
          timeframe: '1Day',
          buyConditionId: bestBuyCondition.id,
          buyConditionLabel: bestBuyCondition.label,
          sellConditionId: bestSellCondition.id,
          sellConditionLabel: bestSellCondition.label,
          trades: best.summary.trades,
          winRatePct: best.summary.winRate,
          totalReturnPct: best.summary.totalReturnPct,
          avgReturnPct: best.summary.avgReturnPct,
          maxDrawdownPct: best.summary.maxDrawdownPct,
        });
      }

    } else {
      // Non-hybrid (13 symbols): existing 144-combo 1D logic, unchanged.
      if (bars.length === 0) {
        symbolSummaries.push({ symbol, trades: 0, wins: 0, losses: 0, winRate: null, totalReturnPct: 0, avgReturnPct: null, maxDrawdownPct: 0 });
        picks.push({ symbol, timeframe: '1Day', buyConditionId: defaultCondition.id, buyConditionLabel: defaultCondition.label, sellConditionId: defaultCondition.id, sellConditionLabel: defaultCondition.label, trades: 0, winRatePct: null, totalReturnPct: 0, avgReturnPct: null, maxDrawdownPct: 0 });
        continue;
      }

      let best: BacktestResult = runCombinedBacktest(symbol, bars, settings.riskProfile, defaultCondition.id, defaultCondition.id, settings.exitMode);
      let bestBuyCondition = defaultCondition;
      let bestSellCondition = defaultCondition;

      for (const buyCondition of CONDITIONS) {
        for (const sellCondition of CONDITIONS) {
          if (buyCondition.id === defaultCondition.id && sellCondition.id === defaultCondition.id) continue;

          const result = runCombinedBacktest(symbol, bars, settings.riskProfile, buyCondition.id, sellCondition.id, settings.exitMode);
          if (result.summary.trades > 0 && (best.summary.trades === 0 || result.summary.totalReturnPct > best.summary.totalReturnPct)) {
            best = result;
            bestBuyCondition = buyCondition;
            bestSellCondition = sellCondition;
          }
        }
      }

      symbolSummaries.push(best.summary);
      trades.push(...best.trades);
      picks.push({
        symbol,
        timeframe: '1Day',
        buyConditionId: bestBuyCondition.id,
        buyConditionLabel: bestBuyCondition.label,
        sellConditionId: bestSellCondition.id,
        sellConditionLabel: bestSellCondition.label,
        trades: best.summary.trades,
        winRatePct: best.summary.winRate,
        totalReturnPct: best.summary.totalReturnPct,
        avgReturnPct: best.summary.avgReturnPct,
        maxDrawdownPct: best.summary.maxDrawdownPct,
      });
    }
  }

  const withTrades = symbolSummaries.filter((s) => s.trades > 0);
  const totalTrades = symbolSummaries.reduce((sum, s) => sum + s.trades, 0);

  let bestSymbol: string | null = null;
  let worstSymbol: string | null = null;
  let bestReturn = -Infinity;
  let worstReturn = Infinity;
  for (const s of withTrades) {
    if (s.totalReturnPct > bestReturn) {
      bestReturn = s.totalReturnPct;
      bestSymbol = s.symbol;
    }
    if (s.totalReturnPct < worstReturn) {
      worstReturn = s.totalReturnPct;
      worstSymbol = s.symbol;
    }
  }

  const portfolio: PortfolioBacktestSummary = {
    symbols: WATCHLIST.length,
    totalTrades,
    avgReturnPct: withTrades.length > 0
      ? withTrades.reduce((sum, s) => sum + s.totalReturnPct, 0) / withTrades.length
      : null,
    avgWinRatePct: withTrades.length > 0
      ? withTrades.reduce((sum, s) => sum + (s.winRate ?? 0), 0) / withTrades.length
      : null,
    bestSymbol,
    worstSymbol,
  };

  const runId = await saveBacktestRun(pool, {
    symbols: WATCHLIST,
    startDate,
    endDate,
    params: {
      strategy: STRATEGY_PARAMS,
      risk: settings.riskProfile,
      exitMode: settings.exitMode,
      conditions: picks.map((p) => ({ symbol: p.symbol, timeframe: p.timeframe, buyConditionId: p.buyConditionId, sellConditionId: p.sellConditionId })),
    },
    summary: { symbols: symbolSummaries, portfolio },
    trades: trades.map((trade) => ({
      symbol: trade.symbol,
      entryDate: trade.entryDate.slice(0, 10),
      entryPrice: trade.entryPrice,
      exitDate: trade.exitDate ? trade.exitDate.slice(0, 10) : null,
      exitPrice: trade.exitPrice,
      exitReason: trade.exitReason,
      pnlPct: trade.pnlPct,
    })),
  });

  await saveSymbolConditions(pool, picks);

  return { runId, startDate, endDate, symbolSummaries, portfolio, trades };
}
