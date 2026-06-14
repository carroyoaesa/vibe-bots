import { loadAlpacaConfig, loadPostgresConfig, loadMinioConfig, loadAnthropicConfig } from './config';
import { createPostgresPool } from './services/db';
import { createMinioClient, putJsonSnapshot } from './services/storage';
import {
  getCloses,
  getLatestFundamentals,
  getRecentNewsForSymbol,
  getLatestMacroObservations,
} from './services/marketStore';
import {
  createAlpacaClient,
  getAccount,
  getPositions,
  getOpenOrders,
  placeBracketBuyOrder,
  cancelOrder,
  closePosition,
  AlpacaAccountSummary,
  AlpacaOrder,
} from './services/alpaca';
import { setupTradingSchema, saveSignal, saveOrder, saveAssessment } from './services/tradingStore';
import { computeSignal, SignalResult } from './strategy/signals';
import { setupSettingsSchema, getSettings } from './services/settingsStore';
import { WATCHLIST, ETF_SYMBOLS, MACRO_SERIES } from './watchlist';
import { createAnthropicClient, assessWatchlist, SymbolAssessment, SymbolAssessmentContext } from './services/claude';

const CLOSES_LOOKBACK = 60;
const NEWS_LOOKBACK = 5;

export type TradingAction =
  | { type: 'OPEN_POSITION'; symbol: string; qty: number; takeProfitPrice: number; stopLossPrice: number; alpacaOrderId: string }
  | { type: 'CLOSE_POSITION'; symbol: string; qty: number; alpacaOrderId?: string }
  | { type: 'AI_BLOCKED'; symbol: string; reason: string }
  | { type: 'NO_ACTION'; symbol: string; reason: string }
  | { type: 'SKIPPED'; symbol: string; reason: string }
  | { type: 'ERROR'; symbol: string; error: string };

export interface TradingCycleResult {
  account: AlpacaAccountSummary;
  signals: SignalResult[];
  actions: TradingAction[];
  snapshotKey: string | null;
}

/**
 * Acota un precio ajustado propuesto por Claude a ±maxDeviation respecto del valor
 * algorítmico original. Si el ajuste no es válido o se sale del rango, devuelve el
 * valor original sin modificar.
 */
function applyPriceAdjustment(original: number | null, adjusted: number | null | undefined, maxDeviation = 0.10): number | null {
  if (original === null || adjusted === null || adjusted === undefined || adjusted <= 0) {
    return original;
  }

  const deviation = Math.abs(adjusted - original) / original;
  if (deviation > maxDeviation) {
    return original;
  }

  return adjusted;
}

export async function runTradingCycle(): Promise<TradingCycleResult> {
  const alpacaConfig = loadAlpacaConfig();
  const postgresConfig = loadPostgresConfig();

  const pool = createPostgresPool(postgresConfig);
  const alpacaClient = createAlpacaClient(alpacaConfig);

  try {
    await setupTradingSchema(pool);
    await setupSettingsSchema(pool);
    const settings = await getSettings(pool);

    const account = await getAccount(alpacaClient);
    const positions = await getPositions(alpacaClient);
    const openOrders = await getOpenOrders(alpacaClient);

    const positionsBySymbol = new Map(positions.map((p) => [p.symbol, p]));
    const openOrdersBySymbol = new Map<string, AlpacaOrder[]>();
    for (const order of openOrders) {
      const list = openOrdersBySymbol.get(order.symbol) ?? [];
      list.push(order);
      openOrdersBySymbol.set(order.symbol, list);
    }
    let openPositionsCount = positions.length;

    // Pasada 1: señales técnicas frescas para todo el watchlist (sin tocar la DB todavía),
    // así quedan disponibles para la fase de IA antes de guardar/ejecutar nada.
    const signals: SignalResult[] = [];
    for (const symbol of WATCHLIST) {
      const closes = await getCloses(pool, symbol, CLOSES_LOOKBACK);
      signals.push(computeSignal(symbol, closes, settings.riskProfile));
    }

    // Fase de IA (Claude): una sola evaluación batched del watchlist completo. Fail-open:
    // si falta ANTHROPIC_API_KEY o falla la llamada, se loguea y el ciclo sigue sin gating
    // (igual que antes de la Fase 4).
    let assessments = new Map<string, SymbolAssessment>();
    let assessmentModel: string | null = null;
    try {
      const anthropicConfig = loadAnthropicConfig();
      const anthropicClient = createAnthropicClient(anthropicConfig);

      const [contexts, macro] = await Promise.all([
        Promise.all(
          WATCHLIST.map(async (symbol, index): Promise<SymbolAssessmentContext> => {
            const signal = signals[index];
            const [fundamentals, news] = await Promise.all([
              getLatestFundamentals(pool, symbol),
              getRecentNewsForSymbol(pool, symbol, NEWS_LOOKBACK),
            ]);

            return {
              symbol,
              type: ETF_SYMBOLS.includes(symbol) ? 'ETF' : 'STOCK',
              signal: signal.signal,
              price: signal.price,
              smaFast: signal.smaFast,
              smaSlow: signal.smaSlow,
              rsi: signal.rsi,
              momentum: signal.momentum,
              estimatedEntryPrice: signal.estimatedEntryPrice,
              estimatedExitPrice: signal.estimatedExitPrice,
              fundamentals,
              news: news.map((item) => ({
                headline: item.headline,
                summary: item.summary,
                publishedAt: item.publishedAt,
              })),
            };
          })
        ),
        getLatestMacroObservations(pool, MACRO_SERIES),
      ]);

      const model = settings.claudeModel || anthropicConfig.model;
      const results = await assessWatchlist(anthropicClient, model, contexts, macro);
      assessments = new Map(results.map((result) => [result.symbol, result]));
      assessmentModel = model;
    } catch (error) {
      console.warn('Fase de IA (Claude) omitida en este ciclo:', error instanceof Error ? error.message : error);
    }

    const actions: TradingAction[] = [];

    // Pasada 2: persistencia + ejecución, con gating de IA sobre señales BUY.
    for (let index = 0; index < WATCHLIST.length; index++) {
      const symbol = WATCHLIST[index];
      const signal = signals[index];

      try {
        const assessment = assessments.get(symbol);

        if (assessment) {
          // Aplica el ajuste de precios propuesto por Claude (acotado a ±10%) ANTES de
          // persistir/usar la señal, para que lo guardado/mostrado y la bracket order
          // sean consistentes con el valor verificado.
          const adjEntry = applyPriceAdjustment(signal.estimatedEntryPrice, assessment.adjustedEntryPrice);
          const adjExit = applyPriceAdjustment(signal.estimatedExitPrice, assessment.adjustedExitPrice);
          if (adjEntry !== null && adjExit !== null && adjExit > adjEntry) {
            signal.estimatedEntryPrice = adjEntry;
            signal.estimatedExitPrice = adjExit;
          }
        }

        const signalId = await saveSignal(pool, signal);

        if (assessment && assessmentModel) {
          await saveAssessment(pool, {
            symbol,
            score: assessment.score,
            recommendation: assessment.recommendation,
            confidence: assessment.confidence,
            rationale: assessment.rationale,
            model: assessmentModel,
            adjustedEntryPrice: assessment.adjustedEntryPrice,
            adjustedExitPrice: assessment.adjustedExitPrice,
          });
        }

        const position = positionsBySymbol.get(symbol);
        const symbolOpenOrders = openOrdersBySymbol.get(symbol) ?? [];

        if (signal.signal === 'BUY') {
          if (position) {
            actions.push({ type: 'NO_ACTION', symbol, reason: 'Ya existe una posición abierta' });
          } else if (symbolOpenOrders.length > 0) {
            actions.push({ type: 'NO_ACTION', symbol, reason: 'Ya hay una orden pendiente' });
          } else if (openPositionsCount >= settings.riskProfile.maxPositions) {
            actions.push({ type: 'NO_ACTION', symbol, reason: `Máximo de posiciones alcanzado (${settings.riskProfile.maxPositions})` });
          } else if (assessment?.recommendation === 'avoid') {
            actions.push({ type: 'AI_BLOCKED', symbol, reason: assessment.rationale });
          } else {
            const positionValue = account.equity * settings.riskProfile.positionSizePct;
            const qty = Math.floor(positionValue / signal.price);

            if (qty < 1) {
              actions.push({
                type: 'SKIPPED',
                symbol,
                reason: `Tamaño calculado < 1 acción ($${positionValue.toFixed(2)} / $${signal.price.toFixed(2)})`,
              });
            } else {
              // Orden límite al precio estimado de entrada (no a mercado), con TP/SL relativos a ese precio.
              // Si el precio actual ya está por debajo del estimado, conviene tomar el menor de los dos
              // (mejor precio de entrada para el comprador) en lugar de esperar a que suba al estimado.
              const entryPrice = signal.estimatedEntryPrice !== null
                ? Math.min(signal.estimatedEntryPrice, signal.price)
                : signal.price;
              const takeProfitPrice = entryPrice * (1 + settings.riskProfile.takeProfitPct);
              const stopLossPrice = entryPrice * (1 - settings.riskProfile.stopLossPct);

              const order = await placeBracketBuyOrder(alpacaClient, {
                symbol,
                qty,
                limitPrice: entryPrice,
                takeProfitPrice,
                stopLossPrice,
              });

              await saveOrder(pool, {
                signalId,
                symbol,
                side: 'buy',
                qty,
                orderType: 'bracket',
                alpacaOrderId: order.id,
                takeProfitPrice,
                stopLossPrice,
                status: order.status,
                raw: order,
              });

              actions.push({ type: 'OPEN_POSITION', symbol, qty, takeProfitPrice, stopLossPrice, alpacaOrderId: order.id });
              openPositionsCount += 1;
            }
          }
        } else if (signal.signal === 'SELL') {
          if (!position) {
            actions.push({ type: 'NO_ACTION', symbol, reason: 'Sin posición abierta para cerrar' });
          } else {
            for (const openOrder of symbolOpenOrders) {
              await cancelOrder(alpacaClient, openOrder.id);
            }

            const closeOrder = await closePosition(alpacaClient, symbol);

            await saveOrder(pool, {
              signalId,
              symbol,
              side: 'sell',
              qty: position.qty,
              orderType: 'close_position',
              alpacaOrderId: closeOrder.id,
              status: closeOrder.status,
              raw: closeOrder,
            });

            actions.push({ type: 'CLOSE_POSITION', symbol, qty: position.qty, alpacaOrderId: closeOrder.id });
            openPositionsCount -= 1;
          }
        } else {
          actions.push({ type: 'NO_ACTION', symbol, reason: 'Señal HOLD' });
        }
      } catch (error) {
        actions.push({ type: 'ERROR', symbol, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Snapshot crudo del ciclo en MinIO (Fase 3) - no debe romper el ciclo de trading si falla.
    let snapshotKey: string | null = null;
    try {
      const minioConfig = loadMinioConfig();
      const minioClient = createMinioClient(minioConfig);
      const key = `trading/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      const snapshot = await putJsonSnapshot(minioClient, minioConfig, key, {
        generatedAt: new Date().toISOString(),
        account,
        signals,
        actions,
        assessments: Array.from(assessments.values()),
      });
      snapshotKey = snapshot.key;
    } catch (error) {
      console.error('No se pudo guardar el snapshot del ciclo de trading en MinIO:', error);
    }

    return { account, signals, actions, snapshotKey };
  } finally {
    await pool.end();
  }
}
