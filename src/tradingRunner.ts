import { Pool } from 'pg';
import { AxiosInstance } from 'axios';
import { loadAlpacaConfig, loadPostgresConfig, loadMinioConfig, loadAnthropicConfig, loadRedisConfig, loadEmailAlertConfig } from './config';
import { createPostgresPool } from './services/db';
import { createMinioClient, putJsonSnapshot } from './services/storage';
import { sendTradeAlertEmail, TradeAlertEntry } from './services/email';
import { MacroObservation } from './services/fred';
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
import { setupTradingSchema, saveSignal, saveOrder, saveAssessment, markAssessmentsStale, markAssessmentsNotEvaluated } from './services/tradingStore';
import { setupSymbolClassificationSchema, getAllSymbolClassifications, classificationToAccountGroup } from './services/symbolClassificationStore';
import { computeSignal, SignalResult } from './strategy/signals';
import { DEFAULT_CONDITION_ID, OhlcBar } from './strategy/conditions';
import { MULTI_CONDITION_OVERRIDES } from './strategy/multiConditionOverrides';
import { setupSettingsSchema, getSettings } from './services/settingsStore';
import { setupConditionSchema, getMainSymbolConditions } from './services/conditionStore';
import { WATCHLIST, ETF_SYMBOLS, MACRO_SERIES } from './watchlist';
import {
  createAnthropicClient,
  assessWatchlist,
  assessSymbolVariant,
  SymbolAssessment,
  SymbolAssessmentContext,
  ClaudeExperimentVariant,
} from './services/claude';
import { canPlaceBuyOrder, invalidateBuyCheck } from './services/preTradeCheck';
import { cancelStaleOrders } from './services/staleOrders';
import { setupClaudeUsageSchema, recordClaudeUsage } from './services/claudeUsageStore';
import { setupClaudeExperimentSchema, recordExperimentResult } from './services/claudeExperimentStore';

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

/**
 * Experimento de sesgo de Claude, limitado a candidatos BUY (Tarea 4, 2026-06-21) - por cada
 * símbolo evaluado en la llamada de producción, registra la variante 'A' (control = el mismo
 * resultado de producción, sin llamada extra a Claude) y, solo si `experimentEnabled`, además
 * corre y registra B/C/D (`assessSymbolVariant`, 1 llamada por variante). Pensado para correr
 * fire-and-forget desde `runTradingCycle()` - cualquier error en una variante puntual se
 * loguea y se sigue con las demás, nunca se propaga al ciclo de trading real.
 */
async function runClaudeExperiment(
  pool: Pool,
  anthropicClient: AxiosInstance,
  model: string,
  contexts: SymbolAssessmentContext[],
  macro: MacroObservation[],
  productionResults: SymbolAssessment[],
  experimentEnabled: boolean,
  dateStr: string
): Promise<void> {
  const productionBySymbol = new Map(productionResults.map((r) => [r.symbol, r]));
  const variants: ClaudeExperimentVariant[] = ['B', 'C', 'D'];

  for (const context of contexts) {
    const production = productionBySymbol.get(context.symbol);
    if (!production) continue;

    // Mismo timestamp para las 4 variantes de este símbolo - permite el self-join de
    // getExperimentDisagreements() sin depender de una ventana de tiempo aproximada.
    const ts = new Date();

    await recordExperimentResult(pool, {
      symbol: context.symbol,
      ts,
      variant: 'A',
      recommendation: production.recommendation,
      score: production.score,
      confidence: production.confidence,
      rationale: production.rationale,
      model,
      tokensUsed: 0, // ya contabilizado en claude_usage_log por la llamada de producción - no se duplica
      costEstimateUsd: 0,
    });

    if (!experimentEnabled) continue;

    const outcomes = await Promise.allSettled(
      variants.map((variant) => assessSymbolVariant(anthropicClient, model, context, macro, variant))
    );

    for (let i = 0; i < variants.length; i++) {
      const variant = variants[i];
      const outcome = outcomes[i];

      if (outcome.status === 'rejected') {
        console.warn(`[runClaudeExperiment] Variante ${variant} falló para ${context.symbol}:`, outcome.reason instanceof Error ? outcome.reason.message : outcome.reason);
        continue;
      }

      const { assessment, usage } = outcome.value;
      await recordExperimentResult(pool, {
        symbol: context.symbol,
        ts,
        variant,
        recommendation: assessment.recommendation,
        score: assessment.score,
        confidence: assessment.confidence,
        rationale: assessment.rationale,
        model,
        tokensUsed: usage.inputTokens + usage.outputTokens,
        costEstimateUsd: usage.costUsd,
      });

      await recordClaudeUsage(pool, {
        date: dateStr,
        totalTokens: usage.inputTokens + usage.outputTokens,
        costUsd: usage.costUsd ?? 0,
        source: 'experiment',
      });
    }
  }
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
    await setupSymbolClassificationSchema(pool);
    await setupClaudeUsageSchema(pool);
    await setupClaudeExperimentSchema(pool);
    const settings = await getSettings(pool);
    const symbolConditions = await getMainSymbolConditions(pool);

    const account = await getAccount(alpacaClient);
    const positions = await getPositions(alpacaClient);
    let openOrders = await getOpenOrders(alpacaClient);
    const positionsBySymbol = new Map(positions.map((p) => [p.symbol, p]));
    let openPositionsCount = positions.length;

    // Pasada 1: señales técnicas frescas para todo el watchlist (sin tocar la DB todavía),
    // así quedan disponibles para la fase de IA antes de guardar/ejecutar nada.
    const signals: SignalResult[] = [];
    // Velas usadas para cada señal este ciclo - se reusan (sin volver a pedirlas) para el
    // gráfico adjunto a la alerta de email (Fase 12) si el símbolo termina en BUY/SELL.
    const barsBySymbol = new Map<string, OhlcBar[]>();
    for (const symbol of WATCHLIST) {
      const bars = await getRecentOhlcBars(pool, symbol, BARS_LOOKBACK);
      barsBySymbol.set(symbol, bars);
      const pick = symbolConditions.get(symbol);
      const override = MULTI_CONDITION_OVERRIDES[symbol];
      // Fase 8: el override de 2-3 condiciones (si existe) tiene precedencia sobre el pick
      // de 1 condición de symbol_conditions (Fase 7) - mismo patrón que HYBRID_CONFIG tier 1.
      const buyConditionId = override?.buyExpr ?? pick?.buyConditionId ?? DEFAULT_CONDITION_ID;
      const sellConditionId = override?.sellExpr ?? pick?.sellConditionId ?? DEFAULT_CONDITION_ID;
      signals.push(computeSignal(symbol, bars, settings.riskProfile, buyConditionId, sellConditionId, settings.exitMode));
    }

    // Precio de entrada que se colocaría HOY para cada símbolo con señal BUY vigente - mismo
    // cálculo que la Pasada 2 (min(estimatedEntryPrice, price)) - usado por cancelStaleOrders
    // para detectar órdenes BUY pendientes cuyo precio ya no se parece al de hoy (p.ej. una
    // orden encolada fuera de horario de mercado cuya señal cambió antes de la sesión siguiente).
    const freshEntryPriceBySymbol = new Map<string, number>();
    for (let i = 0; i < WATCHLIST.length; i++) {
      if (signals[i].signal !== 'BUY') continue;
      const entryPrice = signals[i].estimatedEntryPrice !== null
        ? Math.min(signals[i].estimatedEntryPrice!, signals[i].price)
        : signals[i].price;
      freshEntryPriceBySymbol.set(WATCHLIST[i], entryPrice);
    }

    // Detección de órdenes BUY huérfanas (>pending_order_timeout_min pendientes) o cuyo precio
    // límite quedó por encima del precio que se colocaría hoy para ese símbolo (sin tolerancia
    // mínima - cualquier diferencia cuenta, ver staleOrders.ts) - una vez por ciclo de trading
    // (no en el poller de 60s). Por defecto solo loguea/devuelve la
    // lista (bot_settings.auto_cancel_stale_orders=false) - la UI las muestra para que el
    // usuario decida cancelarlas manualmente. Si está activo, además de cancelarlas en
    // Alpaca, se sacan de `openOrders` en memoria ANTES de construir `openOrdersBySymbol` -
    // así, si la señal del símbolo sigue siendo BUY este ciclo, la Pasada 2 las reemplaza con
    // una orden nueva al precio recalculado en el mismo ciclo (ver cancelStaleOrders).
    const { stale: staleOrders, cancelled: cancelledStaleOrders } = await cancelStaleOrders(
      alpacaClient,
      openOrders,
      settings.pendingOrderTimeoutMin,
      settings.autoCancelStaleOrders,
      freshEntryPriceBySymbol
    );
    if (staleOrders.length > 0) {
      console.warn(`[runTradingCycle] ${staleOrders.length} orden(es) BUY huérfana(s)/desalineada(s) detectada(s): ${staleOrders.map(({ order, reason }) => `${order.symbol}(${order.id}, ${reason})`).join(', ')}`);
    }
    if (cancelledStaleOrders.length > 0) {
      const cancelledIds = new Set(cancelledStaleOrders.map((o) => o.id));
      openOrders = openOrders.filter((o) => !cancelledIds.has(o.id));
    }

    // Refresca la caché de estado de Alpaca (cuenta, posiciones, órdenes abiertas) que usa
    // /api/trading/status, para que el siguiente poll del dashboard no repita estas llamadas.
    // Ya refleja las cancelaciones de arriba. Las decisiones de trading de abajo SIEMPRE usan
    // los valores recién obtenidos, no la caché.
    await Promise.all([
      setCachedJson(redis, ALPACA_ACCOUNT_CACHE_KEY, account, ALPACA_ACCOUNT_CACHE_TTL_SECONDS),
      setCachedJson(redis, ALPACA_POSITIONS_CACHE_KEY, positions, ALPACA_POSITIONS_CACHE_TTL_SECONDS),
      setCachedJson(redis, ALPACA_OPEN_ORDERS_CACHE_KEY, openOrders, ALPACA_OPEN_ORDERS_CACHE_TTL_SECONDS),
    ]).catch((error) => {
      console.warn('No se pudo refrescar la caché de Alpaca en Redis:', error instanceof Error ? error.message : error);
    });

    const openOrdersBySymbol = new Map<string, AlpacaOrder[]>();
    for (const order of openOrders) {
      const list = openOrdersBySymbol.get(order.symbol) ?? [];
      list.push(order);
      openOrdersBySymbol.set(order.symbol, list);
    }

    // Tarea de eficiencia (2026-06-21): Claude antes se consultaba para los 27 símbolos en
    // cada ciclo (o, como mínimo, 1 vez por día aunque no hubiera BUYs, vía el viejo gate de
    // Redis `claude:last_run_date`) - eso multiplicaba el costo sin necesidad real: Claude
    // SOLO puede actuar (vetar) sobre una señal BUY que ya pasó los demás chequeos, así que
    // HOLD/SELL no aportan nada evaluados. El filtro de candidatos pasa primero por la
    // clasificación manual (symbol_classifications) - un símbolo bloqueado nunca coloca una
    // orden real aunque su señal técnica sea BUY, así que tampoco tiene sentido gastar
    // tokens evaluándolo.
    const classifications = await getAllSymbolClassifications(pool);
    const buyCandidateIndexes: number[] = [];
    for (let i = 0; i < WATCHLIST.length; i++) {
      if (signals[i].signal !== 'BUY') continue;
      if ((classifications[WATCHLIST[i]] ?? 'apto') === 'bloqueado') continue;
      buyCandidateIndexes.push(i);
    }
    const buyCandidateSymbols = buyCandidateIndexes.map((i) => WATCHLIST[i]);
    const nonCandidateSymbols = WATCHLIST.filter((symbol) => !buyCandidateSymbols.includes(symbol));

    // Invalidación de evaluaciones de IA (Tarea 2, mismo formato '<recomendacion>-<estado>' en
    // la columna existente ai_assessments.recommendation, sin columnas nuevas): toda evaluación
    // 'fresh' pasa a 'stale' antes de evaluar de nuevo; los símbolos que ni siquiera son
    // candidatos este ciclo (HOLD/SELL técnico o bloqueados) bajan directo a 'not-evaluated'.
    // Si un candidato se reevalúa más abajo, su 'stale' recién puesto queda pisado por la fila
    // 'fresh' nueva que inserta saveAssessment(); si Claude falla para un candidato, su 'stale'
    // queda como está (correcto: hay opinión vieja, pero no se reevaluó este ciclo).
    await markAssessmentsStale(pool);
    await markAssessmentsNotEvaluated(pool, nonCandidateSymbols);

    console.log(
      `[runTradingCycle] Fase de IA (Claude): ${buyCandidateSymbols.length} símbolo(s) candidato(s) BUY este ciclo` +
        (buyCandidateSymbols.length > 0 ? ` -> ${buyCandidateSymbols.join(', ')}` : ' (costo $0 este ciclo)')
    );

    let assessments = new Map<string, SymbolAssessment>();
    let assessmentModel: string | null = null;
    let claudeExperimentPromise: Promise<void> = Promise.resolve();
    const todayStr = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD' UTC

    if (buyCandidateSymbols.length > 0) {
      try {
        const anthropicConfig = loadAnthropicConfig();
        const anthropicClient = createAnthropicClient(anthropicConfig);

        const [contexts, macro] = await Promise.all([
          Promise.all(
            buyCandidateIndexes.map(async (index): Promise<SymbolAssessmentContext> => {
              const symbol = WATCHLIST[index];
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
        const { assessments: results, usage } = await assessWatchlist(anthropicClient, model, contexts, macro);
        assessments = new Map(results.map((result) => [result.symbol, result]));
        assessmentModel = model;

        await recordClaudeUsage(pool, {
          date: todayStr,
          totalTokens: usage.inputTokens + usage.outputTokens,
          costUsd: usage.costUsd ?? 0,
          source: 'production',
        });

        // Experimento de sesgo (Tarea 4) - fire-and-forget: no se espera acá (no debe agregar
        // latencia a la Pasada 2), pero se guarda la promesa (ya con .catch propio, nunca
        // rechaza) para esperarla recién al final del ciclo, ANTES de cerrar el pool en el
        // `finally` - si no, una query tardía del experimento podría correr contra un pool
        // ya cerrado.
        claudeExperimentPromise = runClaudeExperiment(
          pool,
          anthropicClient,
          model,
          contexts,
          macro,
          results,
          settings.claudeExperimentEnabled,
          todayStr
        ).catch((error) => {
          console.warn('[runTradingCycle] Experimento de sesgo de Claude falló (no afecta el ciclo de trading):', error instanceof Error ? error.message : error);
        });
      } catch (error) {
        console.warn('Fase de IA (Claude) omitida en este ciclo:', error instanceof Error ? error.message : error);
      }
    }

    const actions: TradingAction[] = [];
    // Entradas para la alerta por email (Fase 12) - solo BUY/SELL REALMENTE ejecutados
    // (OPEN_POSITION/CLOSE_POSITION), no señales técnicas bloqueadas/omitidas.
    const tradeAlertEntries: TradeAlertEntry[] = [];

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

        const position = positionsBySymbol.get(symbol);
        const symbolOpenOrders = openOrdersBySymbol.get(symbol) ?? [];

        // Grupo de cuenta derivado de la clasificación ACTUAL del símbolo (Fase Operaciones
        // multi-cuenta) - solo etiqueta trading_signals/trading_orders.account_group para que
        // la tab "Operaciones" pueda filtrar; NO rutea la orden real a esa cuenta todavía
        // (sigue siendo la única cuenta de ALPACA_API_KEY/SECRET/BASE_URL). Reusa el mismo
        // snapshot de clasificaciones que el filtro de candidatos BUY de Claude (arriba), en
        // vez de pedirlo de nuevo por símbolo.
        const classification = classifications[symbol] ?? 'apto';
        const accountGroup = classificationToAccountGroup(classification);

        const signalId = await saveSignal(pool, signal, 'main', '1Day', accountGroup);

        if (assessment && assessmentModel) {
          // Formato unificado '<recomendacion>-fresh' (Tarea 2) en la misma columna
          // `ai_assessments.recommendation` - esta es la única evaluación "de este ciclo" para
          // el símbolo, así que siempre se guarda como fresh; markAssessmentsStale() ya bajó
          // cualquier fila vieja antes de este punto.
          await saveAssessment(pool, {
            symbol,
            score: assessment.score,
            recommendation: `${assessment.recommendation}-fresh`,
            confidence: assessment.confidence,
            rationale: assessment.rationale,
            simplifiedReason: assessment.simplifiedReason ?? null,
            model: assessmentModel,
            adjustedEntryPrice: assessment.adjustedEntryPrice,
            adjustedExitPrice: assessment.adjustedExitPrice,
          });
        }

        if (!settings.tradingEnabled && signal.signal !== 'HOLD') {
          // Interruptor ON/OFF del dashboard: bloquea tanto compras como ventas, pero las
          // señales y evaluaciones de IA ya se calcularon/guardaron arriba normalmente.
          actions.push({ type: 'TRADING_DISABLED', symbol });
        } else if (signal.signal === 'BUY') {
          const estimatedOrderValue = account.equity * settings.riskProfile.positionSizePct;

          // Pre-trade check unificado (Fase Operaciones multi-cuenta) - reemplaza la cadena
          // de ifs anterior (clasificación/posición/orden pendiente/máx. posiciones) por una
          // sola función con reason codes explícitos. Fix del bug de duplicación: antes se
          // chequeaba "¿alguna orden abierta?" sin filtrar por lado; PENDING_BUY_ORDER filtra
          // específicamente órdenes side='buy', y queda visible en NO_ACTION.reason para la UI.
          const buyCheck = await canPlaceBuyOrder(pool, symbol, accountGroup, {
            position,
            openOrders: symbolOpenOrders,
            openPositionsCount,
            maxPositions: settings.riskProfile.maxPositions,
            equity: account.equity,
            positionSizePct: settings.riskProfile.positionSizePct,
            estimatedOrderValue,
          });

          if (!buyCheck.allowed) {
            console.log(`[${symbol}] BUY bloqueado: ${buyCheck.reason}${buyCheck.orderId ? ` (orden pendiente ${buyCheck.orderId})` : ''}`);
            actions.push({ type: 'NO_ACTION', symbol, reason: buyCheck.reason! });
          } else if (assessment?.recommendation === 'avoid') {
            // `assessment` acá es siempre el resultado EN MEMORIA de la llamada a Claude de
            // este mismo ciclo (`assessWatchlist`, recomendación cruda 'buy'|'hold'|'avoid'),
            // nunca el valor persistido con sufijo '-fresh'/'-stale'/'not-evaluated' de
            // ai_assessments - el gate nunca lee esa columna, así que no puede llegar acá un
            // valor "viejo" o sin evaluar; no hace falta chequeo extra de estado.
            actions.push({ type: 'AI_BLOCKED', symbol, reason: assessment.rationale });
          } else {
            const positionValue = estimatedOrderValue;
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
                accountGroup,
              });

              invalidateBuyCheck(accountGroup, symbol);
              actions.push({ type: 'OPEN_POSITION', symbol, qty, takeProfitPrice: null, stopLossPrice: null, alpacaOrderId: order.id });
              tradeAlertEntries.push({
                type: 'BUY',
                symbol,
                qty,
                price: entryPrice,
                orderId: order.id,
                signal,
                bars: barsBySymbol.get(symbol) ?? [],
                ai: assessment
                  ? { recommendation: assessment.recommendation, score: assessment.score, confidence: assessment.confidence, rationale: assessment.rationale }
                  : null,
              });
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
              accountGroup,
            });

            invalidateBuyCheck(accountGroup, symbol);
            actions.push({ type: 'CLOSE_POSITION', symbol, qty: position.qty, alpacaOrderId: closeOrder.id });
            tradeAlertEntries.push({
              type: 'SELL',
              symbol,
              qty: position.qty,
              price: signal.price,
              orderId: closeOrder.id,
              signal,
              bars: barsBySymbol.get(symbol) ?? [],
              ai: null, // la fase de IA (Fase 11) solo evalúa candidatos BUY, nunca SELL
            });
            openPositionsCount -= 1;
          }
        } else {
          actions.push({ type: 'NO_ACTION', symbol, reason: 'Señal HOLD' });
        }
      } catch (error) {
        actions.push({ type: 'ERROR', symbol, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Fin del ciclo: invalida toda la caché de canPlaceBuyOrder (30s) - el próximo ciclo
    // (cron horario) debe recalcular con datos frescos de Alpaca, no con la decisión cacheada.
    invalidateBuyCheck();

    // Espera al experimento de sesgo de Claude (fire-and-forget respecto de la Pasada 2, ver
    // más arriba) ANTES de que el `finally` cierre `pool`/`redis` - la promesa ya tiene su
    // propio `.catch`, así que esto nunca lanza ni afecta `actions`/`signals` del ciclo.
    await claudeExperimentPromise;

    // Alerta por email (Fase 12) - best-effort, igual patrón que el snapshot de MinIO de
    // abajo: si no hay SMTP configurado (loadEmailAlertConfig devuelve null) o no hubo
    // ningún BUY/SELL ejecutado este ciclo, no se envía nada. Incluye condiciones técnicas,
    // motivo de IA (solo BUY) y un gráfico PNG del símbolo por entrada.
    if (tradeAlertEntries.length > 0) {
      try {
        const emailConfig = loadEmailAlertConfig();
        if (emailConfig) {
          await sendTradeAlertEmail(emailConfig, tradeAlertEntries);
        }
      } catch (error) {
        console.error('No se pudo enviar la alerta de email del ciclo de trading:', error instanceof Error ? error.message : error);
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
