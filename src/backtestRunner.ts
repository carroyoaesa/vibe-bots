import { Pool } from 'pg';
import { WATCHLIST } from './watchlist';
import { getAllBars } from './services/marketStore';
import { runCombinedBacktest, BacktestResult, BacktestTrade, SymbolBacktestSummary } from './strategy/backtest';
import { CONDITIONS, DEFAULT_CONDITION_ID } from './strategy/conditions';
import { saveBacktestRun } from './services/backtestStore';
import { setupSettingsSchema, getSettings } from './services/settingsStore';
import { setupConditionSchema, saveSymbolConditions, SymbolConditionPick } from './services/conditionStore';
import { setupSymbolClassificationSchema, getSymbolsByClassification, SymbolClassificationStatus } from './services/symbolClassificationStore';
import { STRATEGY_PARAMS } from './strategy/config';
import { HYBRID_CONFIG } from './strategy/hybridConfig';

/** Grupo de backtest segmentado (`backtest-by-classification`) - mapea 1:1 a `SymbolClassificationStatus`. */
export type BacktestGroup = 'aptos' | 'observados' | 'bloqueados';

const GROUP_TO_STATUS: Record<BacktestGroup, SymbolClassificationStatus> = {
  aptos: 'apto',
  observados: 'observar',
  bloqueados: 'bloqueado',
};

export const BACKTEST_GROUPS: BacktestGroup[] = ['aptos', 'observados', 'bloqueados'];

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

/**
 * Núcleo del backtest (144 combos por símbolo + persistencia), parametrizado por la
 * lista de símbolos a cubrir - `runBacktestForWatchlist` (legacy, sin filtrar por
 * clasificación) y `runBacktestForGroup` (Fase 10, segmentado por `symbol_classifications`)
 * son wrappers de esta misma función, solo cambia el universo de símbolos.
 * `classificationGroup` se persiste en `backtest_runs.classification_group` (`null` para
 * la corrida legacy) - no afecta ningún cálculo, solo etiqueta el resultado guardado.
 */
async function runBacktestForSymbols(pool: Pool, symbols: string[], classificationGroup: BacktestGroup | null): Promise<BacktestRunResult> {
  await setupSettingsSchema(pool);
  await setupConditionSchema(pool);
  const settings = await getSettings(pool);

  console.log(`[backtest] grupo='${classificationGroup ?? 'all (legacy)'}' - ${symbols.length} símbolos: ${symbols.join(', ')}`);

  const symbolSummaries: SymbolBacktestSummary[] = [];
  const trades: BacktestTrade[] = [];
  const picks: SymbolConditionPick[] = [];
  let startDate: string | null = null;
  let endDate: string | null = null;

  const defaultCondition = CONDITIONS.find((c) => c.id === DEFAULT_CONDITION_ID) ?? CONDITIONS[0];

  for (const symbol of symbols) {
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
    symbols: symbols.length,
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
    symbols,
    startDate,
    endDate,
    classificationGroup,
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

/** Backtest legacy sobre todo el watchlist (27 símbolos), sin filtrar por clasificación - comportamiento histórico, sin cambios. */
export async function runBacktestForWatchlist(pool: Pool): Promise<BacktestRunResult> {
  return runBacktestForSymbols(pool, WATCHLIST, null);
}

/** Backtest acotado a los símbolos de un grupo de clasificación (`symbol_classifications`). */
export async function runBacktestForGroup(pool: Pool, group: BacktestGroup): Promise<BacktestRunResult> {
  await setupSymbolClassificationSchema(pool);
  const symbols = await getSymbolsByClassification(pool, GROUP_TO_STATUS[group]);
  return runBacktestForSymbols(pool, symbols, group);
}

export interface BacktestGroupRunResult extends BacktestRunResult {
  group: BacktestGroup;
}

/** Corre los 3 grupos (aptos/observados/bloqueados) secuencialmente - usado por `group: 'all'` en `POST /api/backtest/run`. */
export async function runBacktestForAllGroups(pool: Pool): Promise<BacktestGroupRunResult[]> {
  const results: BacktestGroupRunResult[] = [];
  for (const group of BACKTEST_GROUPS) {
    const result = await runBacktestForGroup(pool, group);
    results.push({ ...result, group });
  }
  return results;
}
