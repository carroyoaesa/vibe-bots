import { loadAlpacaConfig, loadPostgresConfig, loadMinioConfig } from './config';
import { createPostgresPool } from './services/db';
import { createMinioClient, putJsonSnapshot } from './services/storage';
import { getCloses } from './services/marketStore';
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
import { setupTradingSchema, saveSignal, saveOrder } from './services/tradingStore';
import { computeSignal, SignalResult } from './strategy/signals';
import { RISK_PROFILE } from './strategy/config';
import { WATCHLIST } from './watchlist';

const CLOSES_LOOKBACK = 60;

export type TradingAction =
  | { type: 'OPEN_POSITION'; symbol: string; qty: number; takeProfitPrice: number; stopLossPrice: number; alpacaOrderId: string }
  | { type: 'CLOSE_POSITION'; symbol: string; qty: number; alpacaOrderId?: string }
  | { type: 'NO_ACTION'; symbol: string; reason: string }
  | { type: 'SKIPPED'; symbol: string; reason: string }
  | { type: 'ERROR'; symbol: string; error: string };

export interface TradingCycleResult {
  account: AlpacaAccountSummary;
  signals: SignalResult[];
  actions: TradingAction[];
  snapshotKey: string | null;
}

export async function runTradingCycle(): Promise<TradingCycleResult> {
  const alpacaConfig = loadAlpacaConfig();
  const postgresConfig = loadPostgresConfig();

  const pool = createPostgresPool(postgresConfig);
  const alpacaClient = createAlpacaClient(alpacaConfig);

  try {
    await setupTradingSchema(pool);

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

    const signals: SignalResult[] = [];
    const actions: TradingAction[] = [];

    for (const symbol of WATCHLIST) {
      try {
        const closes = await getCloses(pool, symbol, CLOSES_LOOKBACK);
        const signal = computeSignal(symbol, closes);
        const signalId = await saveSignal(pool, signal);
        signals.push(signal);

        const position = positionsBySymbol.get(symbol);
        const symbolOpenOrders = openOrdersBySymbol.get(symbol) ?? [];

        if (signal.signal === 'BUY') {
          if (position) {
            actions.push({ type: 'NO_ACTION', symbol, reason: 'Ya existe una posición abierta' });
          } else if (symbolOpenOrders.length > 0) {
            actions.push({ type: 'NO_ACTION', symbol, reason: 'Ya hay una orden pendiente' });
          } else if (openPositionsCount >= RISK_PROFILE.maxPositions) {
            actions.push({ type: 'NO_ACTION', symbol, reason: `Máximo de posiciones alcanzado (${RISK_PROFILE.maxPositions})` });
          } else {
            const positionValue = account.equity * RISK_PROFILE.positionSizePct;
            const qty = Math.floor(positionValue / signal.price);

            if (qty < 1) {
              actions.push({
                type: 'SKIPPED',
                symbol,
                reason: `Tamaño calculado < 1 acción ($${positionValue.toFixed(2)} / $${signal.price.toFixed(2)})`,
              });
            } else {
              // Orden límite al precio estimado de entrada (no a mercado), con TP/SL relativos a ese precio.
              const entryPrice = signal.estimatedEntryPrice ?? signal.price;
              const takeProfitPrice = entryPrice * (1 + RISK_PROFILE.takeProfitPct);
              const stopLossPrice = entryPrice * (1 - RISK_PROFILE.stopLossPct);

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
