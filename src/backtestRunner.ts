import { Pool } from 'pg';
import { WATCHLIST } from './watchlist';
import { getAllBars } from './services/marketStore';
import { runBacktest, BacktestResult, BacktestTrade, SymbolBacktestSummary } from './strategy/backtest';
import { CONDITIONS, DEFAULT_CONDITION_ID } from './strategy/conditions';
import { saveBacktestRun } from './services/backtestStore';
import { setupSettingsSchema, getSettings } from './services/settingsStore';
import { setupConditionSchema, saveSymbolConditions, SymbolConditionPick } from './services/conditionStore';
import { STRATEGY_PARAMS } from './strategy/config';

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

    if (bars.length === 0) {
      symbolSummaries.push({
        symbol,
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: null,
        totalReturnPct: 0,
        avgReturnPct: null,
        maxDrawdownPct: 0,
      });
      picks.push({
        symbol,
        conditionId: defaultCondition.id,
        conditionLabel: defaultCondition.label,
        trades: 0,
        winRatePct: null,
        totalReturnPct: 0,
        avgReturnPct: null,
        maxDrawdownPct: 0,
      });
      continue;
    }

    const firstDate = bars[0].ts.slice(0, 10);
    const lastDate = bars[bars.length - 1].ts.slice(0, 10);
    if (startDate === null || firstDate < startDate) startDate = firstDate;
    if (endDate === null || lastDate > endDate) endDate = lastDate;

    // Corre las 12 condiciones con el motor real de vibe-bots (orden límite, fill solo si el
    // low de la sesión siguiente toca el precio límite) y elige la de mayor retorno total
    // entre las que operaron al menos una vez. Si ninguna operó, queda DEFAULT_CONDITION_ID
    // (trades: 0) = comportamiento histórico.
    let best: BacktestResult = runBacktest(symbol, bars, settings.riskProfile, defaultCondition.id);
    let bestCondition = defaultCondition;

    for (const condition of CONDITIONS) {
      if (condition.id === defaultCondition.id) continue;

      const result = runBacktest(symbol, bars, settings.riskProfile, condition.id);
      if (result.summary.trades > 0 && (best.summary.trades === 0 || result.summary.totalReturnPct > best.summary.totalReturnPct)) {
        best = result;
        bestCondition = condition;
      }
    }

    symbolSummaries.push(best.summary);
    trades.push(...best.trades);
    picks.push({
      symbol,
      conditionId: bestCondition.id,
      conditionLabel: bestCondition.label,
      trades: best.summary.trades,
      winRatePct: best.summary.winRate,
      totalReturnPct: best.summary.totalReturnPct,
      avgReturnPct: best.summary.avgReturnPct,
      maxDrawdownPct: best.summary.maxDrawdownPct,
    });
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
      conditions: picks.map((p) => ({ symbol: p.symbol, conditionId: p.conditionId })),
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
