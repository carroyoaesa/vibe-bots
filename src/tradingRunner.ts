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
  getRecentOhlcBars1H,
  getLatestFundamentals,
  getRecentNewsForSymbol,
  getLatestMacroObservations,
  saveHourlyBars,
} from './services/marketStore';
import { createMarketDataClient, getHourlyBars } from './services/marketData';
import {
  createAlpacaClient,
  getAccount,
  getPositions,
  getOpenOrders,
  placeBuyOrder,
  cancelOrder,
  closePosition,
  closePositionQty,
  AlpacaAccountSummary,
  AlpacaOrder,
} from './services/alpaca';
import { setupTradingSchema, saveSignal, saveOrder, saveAssessment } from './services/tradingStore';
import { computeSignal, computeSignal1H, SignalResult } from './strategy/signals';
import { DEFAULT_CONDITION_ID } from './strategy/conditions';
import { setupSettingsSchema, getSettings } from './services/settingsStore';
import { setupConditionSchema, getMainSymbolConditions } from './services/conditionStore';
import { setupParallelSchema, getOpenParallelPositions, openParallelPosition, closeParallelPosition } from './services/parallelStore';
import { HYBRID_CONFIG, HYBRID_SYMBOLS, TIER2_SYMBOLS, SHADOW_SYMBOLS, PARALLEL_RISK_PROFILE } from './strategy/hybridConfig';
import { WATCHLIST, ETF_SYMBOLS, MACRO_SERIES } from './watchlist';
import { createAnthropicClient, assessWatchlist, SymbolAssessment, SymbolAssessmentContext } from './services/claude';

// Velas (OHLC diarias) pedidas por símbolo para calcular la condición activa (Fase 6):
// suficiente warm-up para SMA50/EMA26/MACD/Bollinger/Stochastic/CCI/Donchian.
const BARS_LOOKBACK = 100;
const NEWS_LOOKBACK = 5;

// Fase híbrido (`strategy/hybridConfig.ts`): ventana de ingesta de velas 1H para los
// 5 símbolos híbridos (~140 días hábiles * ~7 velas/día ≈ 980 velas, igual patrón que
// `BARS_LOOKBACK`/`MIN_BARS` en 1D - cubre MIN_BARS_1H=401 con margen para warm-up de
// indicadores y detección de cruces) y velas pedidas a `getRecentOhlcBars1H` para
// `computeSignal1H`.
const HOURLY_BARS_LOOKBACK_DAYS = 200;
const HOURLY_BARS_FOR_SIGNAL = 450;

export type TradingAction =
  | { type: 'OPEN_POSITION'; symbol: string; qty: number; takeProfitPrice: number | null; stopLossPrice: number | null; alpacaOrderId: string }
  | { type: 'CLOSE_POSITION'; symbol: string; qty: number; alpacaOrderId?: string }
  | { type: 'OPEN_PARALLEL_POSITION'; symbol: string; qty: number; alpacaOrderId: string }
  | { type: 'CLOSE_PARALLEL_POSITION'; symbol: string; qty: number; alpacaOrderId?: string }
  | { type: 'AI_BLOCKED'; symbol: string; reason: string }
  | { type: 'TRADING_DISABLED'; symbol: string; system?: 'main' | 'parallel' }
  | { type: 'NO_ACTION'; symbol: string; system?: 'main' | 'parallel' | 'shadow'; reason: string }
  | { type: 'SKIPPED'; symbol: string; system?: 'main' | 'parallel' | 'shadow'; reason: string }
  | { type: 'ERROR'; symbol: string; system?: 'main' | 'parallel' | 'shadow'; error: string };

/** Señal 1H de Tier 2 (`parallel`, MS/QQQM) o de SCHD en modo sombra (`shadow`) - Fase híbrido. */
export interface HybridSignalResult {
  symbol: string;
  system: 'parallel' | 'shadow';
  signal: SignalResult;
}

export interface TradingCycleResult {
  account: AlpacaAccountSummary;
  signals: SignalResult[];
  hybridSignals: HybridSignalResult[];
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
    await setupParallelSchema(pool);
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

    // Fase híbrido (`strategy/hybridConfig.ts`): ingesta best-effort de velas 1H para los
    // 5 símbolos híbridos (SPY, XLU, MS, QQQM, SCHD), reutilizando `market_bars` con
    // timeframe='1Hour'. Si Alpaca falla, se loguea y el ciclo sigue con las velas 1H
    // que ya hubiera en la DB (o señal "datos insuficientes" si no hay ninguna).
    try {
      const marketDataClient = createMarketDataClient(alpacaConfig);
      const hourlyBars = await getHourlyBars(marketDataClient, HYBRID_SYMBOLS, HOURLY_BARS_LOOKBACK_DAYS);
      await saveHourlyBars(pool, hourlyBars);
    } catch (error) {
      console.warn('No se pudieron actualizar las velas 1H (Fase híbrido):', error instanceof Error ? error.message : error);
    }

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
    // Fase híbrido: los símbolos Tier 1 (refinamiento in-place, `HYBRID_CONFIG`) usan su
    // combo 1H (`computeSignal1H`) en lugar de `symbol_conditions`/1D - esta señal
    // REEMPLAZA la señal "main" de ese símbolo y fluye sin cambios por la Pasada 2.
    const signals: SignalResult[] = [];
    for (const symbol of WATCHLIST) {
      const hybrid = HYBRID_CONFIG[symbol];
      if (hybrid?.tier === 1) {
        const bars1h = await getRecentOhlcBars1H(pool, symbol, HOURLY_BARS_FOR_SIGNAL);
        signals.push(computeSignal1H(symbol, bars1h, settings.riskProfile, hybrid.buyConditionId, hybrid.sellConditionId));
      } else {
        const bars = await getRecentOhlcBars(pool, symbol, BARS_LOOKBACK);
        const pick = symbolConditions.get(symbol);
        const buyConditionId = pick?.buyConditionId ?? DEFAULT_CONDITION_ID;
        const sellConditionId = pick?.sellConditionId ?? DEFAULT_CONDITION_ID;
        signals.push(computeSignal(symbol, bars, settings.riskProfile, buyConditionId, sellConditionId));
      }
    }

    // Pasada 1b (Fase híbrido): señales 1H adicionales para Tier 2 (sistema paralelo,
    // MS/QQQM) y SCHD (modo sombra). No reemplazan la señal "main" de esos símbolos
    // (calculada arriba en la Pasada 1 con su combo 1D habitual) - se persisten y, para
    // Tier 2, se ejecutan por separado en la Pasada 2b. No pasan por la fase de IA.
    const hybridSignals: HybridSignalResult[] = [];
    for (const symbol of [...TIER2_SYMBOLS, ...SHADOW_SYMBOLS]) {
      const hybrid = HYBRID_CONFIG[symbol];
      const bars1h = await getRecentOhlcBars1H(pool, symbol, HOURLY_BARS_FOR_SIGNAL);
      const signal = computeSignal1H(symbol, bars1h, PARALLEL_RISK_PROFILE, hybrid.buyConditionId, hybrid.sellConditionId);
      hybridSignals.push({ symbol, system: hybrid.tier === 'shadow' ? 'shadow' : 'parallel', signal });
    }

    // Fase de IA (Claude): una sola evaluación batched del watchlist completo. Fail-open:
    // si falta ANTHROPIC_API_KEY o falla la llamada, se loguea y el ciclo sigue sin gating
    // (igual que antes de la Fase 4). No se extiende a `hybridSignals` (Tier 2/sombra).
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
          // persistir/usar la señal, para que lo guardado/mostrado y la orden
          // sean consistentes con el valor verificado.
          const adjEntry = applyPriceAdjustment(signal.estimatedEntryPrice, assessment.adjustedEntryPrice);
          const adjExit = applyPriceAdjustment(signal.estimatedExitPrice, assessment.adjustedExitPrice);
          if (adjEntry !== null && adjExit !== null && adjExit > adjEntry) {
            signal.estimatedEntryPrice = adjEntry;
            signal.estimatedExitPrice = adjExit;
          }
        }

        // Fase híbrido: Tier 1 (in-place, `HYBRID_CONFIG`) persiste su señal "main" con
        // timeframe='1Hour' (combo 1H reemplaza al 1D para ese símbolo); el resto sigue
        // con '1Day' como siempre.
        const timeframe: '1Day' | '1Hour' = HYBRID_CONFIG[symbol]?.tier === 1 ? '1Hour' : '1Day';
        const signalId = await saveSignal(pool, signal, 'main', timeframe);

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

    // Pasada 2b (Fase híbrido): persistencia + ejecución de `hybridSignals` (Tier 2
    // paralelo y SCHD sombra). Tier 2 (MS/QQQM) opera con su propio presupuesto de riesgo
    // (`PARALLEL_RISK_PROFILE`) y su propia tabla `parallel_positions`, vendiendo solo su
    // porción de la posición de Alpaca (`closePositionQty`) sin tocar la posición "main"
    // del mismo símbolo. SCHD (sombra) solo guarda la señal, nunca coloca órdenes.
    const openParallelPositions = await getOpenParallelPositions(pool);
    const parallelPositionsBySymbol = new Map(openParallelPositions.map((p) => [p.symbol, p]));
    let openParallelCount = openParallelPositions.length;

    for (const { symbol, system, signal } of hybridSignals) {
      try {
        const signalId = await saveSignal(pool, signal, system, '1Hour');

        if (system === 'shadow') {
          actions.push({ type: 'NO_ACTION', symbol, system: 'shadow', reason: `Señal sombra (${signal.signal}): ${signal.reason}` });
          continue;
        }

        if (!settings.tradingEnabled && signal.signal !== 'HOLD') {
          actions.push({ type: 'TRADING_DISABLED', symbol, system: 'parallel' });
          continue;
        }

        const openParallel = parallelPositionsBySymbol.get(symbol);

        if (signal.signal === 'BUY') {
          if (openParallel) {
            actions.push({ type: 'NO_ACTION', symbol, system: 'parallel', reason: 'Ya existe una posición paralela abierta' });
          } else if (openParallelCount >= PARALLEL_RISK_PROFILE.maxPositions) {
            actions.push({ type: 'NO_ACTION', symbol, system: 'parallel', reason: `Máximo de posiciones paralelas alcanzado (${PARALLEL_RISK_PROFILE.maxPositions})` });
          } else {
            const positionValue = account.equity * PARALLEL_RISK_PROFILE.positionSizePct;
            const qty = Math.floor(positionValue / signal.price);

            if (qty < 1) {
              actions.push({
                type: 'SKIPPED',
                symbol,
                system: 'parallel',
                reason: `Tamaño calculado < 1 acción ($${positionValue.toFixed(2)} / $${signal.price.toFixed(2)})`,
              });
            } else {
              const entryPrice = signal.estimatedEntryPrice !== null
                ? Math.min(signal.estimatedEntryPrice, signal.price)
                : signal.price;

              const order = await placeBuyOrder(alpacaClient, { symbol, qty, limitPrice: entryPrice });

              await saveOrder(pool, {
                signalId,
                symbol,
                side: 'buy',
                qty,
                orderType: 'simple',
                alpacaOrderId: order.id,
                status: order.status,
                raw: order,
                system: 'parallel',
              });

              await openParallelPosition(pool, { symbol, qty, entryPrice, openOrderId: order.id });

              actions.push({ type: 'OPEN_PARALLEL_POSITION', symbol, qty, alpacaOrderId: order.id });
              openParallelCount += 1;
            }
          }
        } else if (signal.signal === 'SELL') {
          if (!openParallel) {
            actions.push({ type: 'NO_ACTION', symbol, system: 'parallel', reason: 'Sin posición paralela abierta para cerrar' });
          } else {
            const closeOrder = await closePositionQty(alpacaClient, symbol, openParallel.qty);

            await saveOrder(pool, {
              signalId,
              symbol,
              side: 'sell',
              qty: openParallel.qty,
              orderType: 'close_position_qty',
              alpacaOrderId: closeOrder.id,
              status: closeOrder.status,
              raw: closeOrder,
              system: 'parallel',
            });

            await closeParallelPosition(pool, openParallel.id, { exitPrice: signal.price, closeOrderId: closeOrder.id });

            actions.push({ type: 'CLOSE_PARALLEL_POSITION', symbol, qty: openParallel.qty, alpacaOrderId: closeOrder.id });
            openParallelCount -= 1;
          }
        } else {
          actions.push({ type: 'NO_ACTION', symbol, system: 'parallel', reason: 'Señal HOLD' });
        }
      } catch (error) {
        actions.push({ type: 'ERROR', symbol, system, error: error instanceof Error ? error.message : String(error) });
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
        hybridSignals,
        actions,
        assessments: Array.from(assessments.values()),
      });
      snapshotKey = snapshot.key;
    } catch (error) {
      console.error('No se pudo guardar el snapshot del ciclo de trading en MinIO:', error);
    }

    return { account, signals, hybridSignals, actions, snapshotKey };
  } finally {
    await redis.quit();
    await pool.end();
  }
}
