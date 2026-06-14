import { Pool } from 'pg';
import { WATCHLIST } from './watchlist';
import { getAllBars } from './services/marketStore';
import { runBacktest, BacktestTrade, SymbolBacktestSummary } from './strategy/backtest';
import { saveBacktestRun } from './services/backtestStore';
import { setupSettingsSchema, getSettings } from './services/settingsStore';
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
  const settings = await getSettings(pool);

  const symbolSummaries: SymbolBacktestSummary[] = [];
  const trades: BacktestTrade[] = [];
  let startDate: string | null = null;
  let endDate: string | null = null;

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
      continue;
    }

    const firstDate = bars[0].ts.slice(0, 10);
    const lastDate = bars[bars.length - 1].ts.slice(0, 10);
    if (startDate === null || firstDate < startDate) startDate = firstDate;
    if (endDate === null || lastDate > endDate) endDate = lastDate;

    const result = runBacktest(symbol, bars, settings.riskProfile);
    symbolSummaries.push(result.summary);
    trades.push(...result.trades);
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
    params: { strategy: STRATEGY_PARAMS, risk: settings.riskProfile },
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

  return { runId, startDate, endDate, symbolSummaries, portfolio, trades };
}
