import { AxiosInstance } from 'axios';
import { AlpacaOrder, cancelOrder } from './alpaca';

/** Órdenes BUY abiertas que llevan más de `timeoutMin` minutos pendientes (candidatas a huérfanas). */
export function findStaleOrders(openOrders: AlpacaOrder[], timeoutMin: number, now = new Date()): AlpacaOrder[] {
  const timeoutMs = timeoutMin * 60_000;
  return openOrders.filter((order) => {
    if (order.side !== 'buy' || !order.submittedAt) return false;
    return now.getTime() - new Date(order.submittedAt).getTime() > timeoutMs;
  });
}

export interface StaleOrdersResult {
  stale: AlpacaOrder[];
  cancelled: AlpacaOrder[];
}

/**
 * Detecta órdenes BUY huérfanas (pendientes más de `pending_order_timeout_min`, ver
 * `bot_settings`) y, SOLO si `autoCancelStaleOrders` está activo (default `false`), las
 * cancela. Por defecto se limita a loguear/devolver la lista para que la UI las muestre
 * ("órdenes huérfanas detectadas") y el usuario decida - llamada una vez por ciclo de
 * trading (cron), no en el poller de 60s.
 */
export async function cancelStaleOrders(
  client: AxiosInstance,
  openOrders: AlpacaOrder[],
  timeoutMin: number,
  autoCancelStaleOrders: boolean
): Promise<StaleOrdersResult> {
  const stale = findStaleOrders(openOrders, timeoutMin);

  if (stale.length === 0) {
    return { stale, cancelled: [] };
  }

  console.warn(`[cancelStaleOrders] ${stale.length} orden(es) BUY huérfana(s) (>${timeoutMin}min pendiente): ${stale.map((o) => `${o.symbol}(${o.id})`).join(', ')}`);

  if (!autoCancelStaleOrders) {
    return { stale, cancelled: [] };
  }

  const cancelled: AlpacaOrder[] = [];
  for (const order of stale) {
    try {
      await cancelOrder(client, order.id);
      cancelled.push(order);
      console.log(`[cancelStaleOrders] Cancelada orden huérfana ${order.symbol} (${order.id})`);
    } catch (error) {
      console.error(`[cancelStaleOrders] Error cancelando orden huérfana ${order.symbol} (${order.id}):`, error instanceof Error ? error.message : error);
    }
  }
  return { stale, cancelled };
}
