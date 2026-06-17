import { loadAlpacaConfig, loadPostgresConfig, loadMinioConfig, loadAnthropicConfig, loadRedisConfig } from './config';
import { createPostgresPool } from './services/db';
import { createMinioClient, putJsonSnapshot } from './services/storage';
import {
  createRedisClient,
  setCachedJson,
  ALPACA_ACCOUNT_CACHE_KEY,
  ALPACA_ACCOUNT_CACHE_TTL_SECONDS,
  ALPACA_POSITIONS_CACHE_KEY,
  ALPACA_POSITIONS_CACHE_TTL_SECONDS,
  ALPACA_OPEN_ORDERS_CACHE_KEY,
  ALPACA_OPEN_ORDERS_CACHE_TTL_SECONDS,
} from './services/cache';
import {
  getRecentOhlcBars,
  getLatestFundamentals,
  getRecentNewsForSymbol,
  getLatestMacroObservations,
} from './services/marketStore';
import {
  createAlpacaClient,
  getAccount,
  getPositions,
  getOpenOrders,
  placeBuyOrder,
  cancelOrder,
  closePosition,
  AlpacaAccountSummary,
  AlpacaOrder,
} from './services/alpaca';
import { setupTradingSchema, saveSignal, saveOrder, saveAssessment } from './services/tradingStore';
import { computeSignal, SignalResult } from './strategy/signals';
import { DEFAULT_CONDITION_ID } from './strategy/conditions';
import { MULTI_CONDITION_OVERRIDES } from './strategy/multiConditionOverrides';
import { setupSettingsSchema, getSettings } from './services/settingsStore';
import { setupConditionSchema, getMainSymbolConditions } from './services/conditionStore';
import { WATCHLIST, ETF_SYMBOLS, MACRO_SERIES } from './watchlist';
import { createAnthropicClient, assessWatchlist, SymbolAssessment, SymbolAssessmentContext } from './services/claude';

// Velas (OHLC diarias) pedidas por símbolo para calcular la condición activa (Fase 6):
// suficiente warm-up para SMA50/EMA26/MACD/Bollinger/Stochastic/CCI/Donchian.
const BARS_LOOKBACK = 100;
const NEWS_LOOKBACK = 5;


export type TradingAction =
  | { type: 'OPEN_POSITION'; symbol: string; qty: number; takeProfitPrice: number | null; stopLossPrice: number | null; alpacaOrderId: string }
  | { type: 'CLOSE_POSITION'; symbol: string; qty: number; alpacaOrderId?: string }
  | { type: 'AI_BLOCKED'; symbol: string; reason: string }
  | { type: 'TRADING_DISABLED'; symbol: string }
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
  const redis = createRedisClient(loadRedisConfig());

  try {
    await setupTradingSchema(pool);
    await setupSettingsSchema(pool);
    await setupConditionSchema(pool);
    const settings = await getSettings(pool);
    const symbolConditions = await getMainSymbolConditions(pool);

    const account = await getAccount(alpacaClient);
    const positions = await getPositions(alpacaClient);
    const openOrders = await getOpenOrders(alpacaClient);

    // Refresca la caché de estado de Alpaca (cuenta, posiciones, órdenes abiertas) que usa
    // /api/trading/status, para que el siguiente poll del dashboard no repita estas llamadas.
    // Las decisiones de trading de abajo SIEMPRE usan los valores recién obtenidos, no la caché.
    await Promise.all([
      setCachedJson(redis, ALPACA_ACCOUNT_CACHE_KEY, account, ALPACA_ACCOUNT_CACHE_TTL_SECONDS),
      setCachedJson(redis, ALPACA_POSITIONS_CACHE_KEY, positions, ALPACA_POSITIONS_CACHE_TTL_SECONDS),
      setCachedJson(redis, ALPACA_OPEN_ORDERS_CACHE_KEY, openOrders, ALPACA_OPEN_ORDERS_CACHE_TTL_SECONDS),
    ]).catch((error) => {
      console.warn('No se pudo refrescar la caché de Alpaca en Redis:', error instanceof Error ? error.message : error);
    });

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
      const bars = await getRecentOhlcBars(pool, symbol, BARS_LOOKBACK);
      const pick = symbolConditions.get(symbol);
      const override = MULTI_CONDITION_OVERRIDES[symbol];
      // Fase 8: el override de 2-3 condiciones (si existe) tiene precedencia sobre el pick
      // de 1 condición de symbol_conditions (Fase 7) - mismo patrón que HYBRID_CONFIG tier 1.
      const buyConditionId = override?.buyExpr ?? pick?.buyConditionId ?? DEFAULT_CONDITION_ID;
      const sellConditionId = override?.sellExpr ?? pick?.sellConditionId ?? DEFAULT_CONDITION_ID;
      signals.push(computeSignal(symbol, bars, settings.riskProfile, buyConditionId, sellConditionId));
    }

    // Fase de IA (Claude): gate de optimización de tokens.
    // - Primera llamada del día (según Redis `claude:last_run_date`): siempre se ejecuta,
    //   para tener evaluaciones frescas de referencia aunque no haya señales BUY.
    // - Llamadas siguientes (mismo día): solo si existe al menos 1 señal BUY — es el único
    //   caso donde Claude puede generar una acción (vetar o confirmar la compra). Para
    //   señales HOLD/SELL Claude no hace nada, así que no tiene sentido gastar tokens.
    // Fail-open: si falta ANTHROPIC_API_KEY o falla la llamada, el ciclo sigue sin gating.
    const CLAUDE_LAST_RUN_KEY = 'claude:last_run_date';
    const todayStr = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD' UTC
    const lastRunDate = await redis.get(CLAUDE_LAST_RUN_KEY).catch(() => null);
    const isFirstRunToday = lastRunDate !== todayStr;
    const hasBuySignals = signals.some((s) => s.signal === 'BUY');

    let assessments = new Map<string, SymbolAssessment>();
    let assessmentModel: string | null = null;

    if (!isFirstRunToday && !hasBuySignals) {
      console.log(`Fase de IA (Claude) saltada: ya se ejecutó hoy (${lastRunDate ?? 'n/a'}) y no hay señales BUY`);
    } else {
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
                buyConditionId: signal.buyConditionId,
                buyConditionLabel: signal.buyConditionLabel,
                sellConditionId: signal.sellConditionId,
                sellConditionLabel: signal.sellConditionLabel,
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

        // Registrar fecha de última llamada exitosa (TTL 48h para auto-expiración segura)
        await redis.set(CLAUDE_LAST_RUN_KEY, todayStr, 'EX', 172800).catch(() => {});
      } catch (error) {
        console.warn('Fase de IA (Claude) omitida en este ciclo:', error instanceof Error ? error.message : error);
      }
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
          // persistir/usar la señal, para que lo guardado/mostrado y la orden
          // sean consistentes con el valor verificado.
          const adjEntry = applyPriceAdjustment(signal.estimatedEntryPrice, assessment.adjustedEntryPrice);
          const adjExit = applyPriceAdjustment(signal.estimatedExitPrice, assessment.adjustedExitPrice);
          if (adjEntry !== null && adjExit !== null && adjExit > adjEntry) {
            signal.estimatedEntryPrice = adjEntry;
            signal.estimatedExitPrice = adjExit;
          }
        }

        const signalId = await saveSignal(pool, signal, 'main', '1Day');

        if (assessment && assessmentModel) {
          await saveAssessment(pool, {
            symbol,
            score: assessment.score,
            recommendation: assessment.recommendation,
            confidence: assessment.confidence,
            rationale: assessment.rationale,
            simplifiedReason: assessment.simplifiedReason ?? null,
            model: assessmentModel,
            adjustedEntryPrice: assessment.adjustedEntryPrice,
            adjustedExitPrice: assessment.adjustedExitPrice,
          });
        }

        const position = positionsBySymbol.get(symbol);
        const symbolOpenOrders = openOrdersBySymbol.get(symbol) ?? [];

        if (!settings.tradingEnabled && signal.signal !== 'HOLD') {
          // Interruptor ON/OFF del dashboard: bloquea tanto compras como ventas, pero las
          // señales y evaluaciones de IA ya se calcularon/guardaron arriba normalmente.
          actions.push({ type: 'TRADING_DISABLED', symbol });
        } else if (signal.signal === 'BUY') {
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
            // Ajusta qty si excede el buying power disponible (ocurre con flujo_de_caja
            // cuando hay >13 posiciones abiertas y se empieza a usar margen).
            let qty = Math.floor(positionValue / signal.price);
            if (qty > 0 && qty * signal.price > account.buyingPower) {
              qty = Math.floor(account.buyingPower / signal.price);
            }

            if (qty < 1) {
              actions.push({
                type: 'SKIPPED',
                symbol,
                reason: `Tamaño calculado < 1 acción ($${positionValue.toFixed(2)} / $${signal.price.toFixed(2)}, buyingPower=$${account.buyingPower.toFixed(0)})`,
              });
            } else {
              if (account.cash < qty * signal.price) {
                console.log(`[${symbol}] Usando margen: cash=$${account.cash.toFixed(0)}, orden=$${(qty * signal.price).toFixed(0)}, buyingPower=$${account.buyingPower.toFixed(0)}`);
              }
              // Orden límite al precio estimado de entrada (no a mercado), con TP/SL relativos a ese precio.
              // Si el precio actual ya está por debajo del estimado, conviene tomar el menor de los dos
              // (mejor precio de entrada para el comprador) en lugar de esperar a que suba al estimado.
              const entryPrice = signal.estimatedEntryPrice !== null
                ? Math.min(signal.estimatedEntryPrice, signal.price)
                : signal.price;

              // Orden límite simple, sin TP/SL. La posición se cierra únicamente cuando
              // la condición activa emite señal SELL (closePosition más abajo).
              const order = await placeBuyOrder(alpacaClient, {
                symbol,
                qty,
                limitPrice: entryPrice,
              });

              await saveOrder(pool, {
                signalId,
                symbol,
                side: 'buy',
                qty,
                orderType: 'simple',
                alpacaOrderId: order.id,
                status: order.status,
                raw: order,
              });

              actions.push({ type: 'OPEN_POSITION', symbol, qty, takeProfitPrice: null, stopLossPrice: null, alpacaOrderId: order.id });
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
    await redis.quit();
    await pool.end();
  }
}
