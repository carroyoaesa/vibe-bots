import { AxiosInstance } from 'axios';
import { AlpacaOrder, cancelOrder } from './alpaca';

export type StaleReason = 'timeout' | 'price_above_market';

export interface StaleOrderInfo {
  order: AlpacaOrder;
  reason: StaleReason;
}

/**
 * Órdenes BUY abiertas candidatas a huérfanas/desalineadas:
 * - 'timeout': pendientes hace más de `timeoutMin` minutos.
 * - 'price_above_market': el símbolo tiene señal BUY vigente este ciclo
 *   (`freshEntryPriceBySymbol`) y el precio que se colocaría HOY es MENOR que el límite de la
 *   orden pendiente (la orden vieja está pagando de más respecto de la estimación actual) -
 *   sin importar cuánto lleve abierta, y sin tolerancia mínima: cualquier diferencia cuenta
 *   (decisión explícita del usuario, 2026-06-21 - no usar un umbral de %). Direccional a
 *   propósito: si el precio de hoy es MAYOR que el límite viejo, no se toca - una orden de
 *   compra con límite más bajo no es "peor", solo menos probable de fillear, y reemplazarla no
 *   aporta nada.
 */
export function findStaleOrders(
  openOrders: AlpacaOrder[],
  timeoutMin: number,
  freshEntryPriceBySymbol: Map<string, number> = new Map(),
  now = new Date()
): StaleOrderInfo[] {
  const timeoutMs = timeoutMin * 60_000;
  const result: StaleOrderInfo[] = [];

  for (const order of openOrders) {
    if (order.side !== 'buy' || !order.submittedAt) continue;

    const ageMs = now.getTime() - new Date(order.submittedAt).getTime();
    if (ageMs > timeoutMs) {
      result.push({ order, reason: 'timeout' });
      continue;
    }

    const freshPrice = freshEntryPriceBySymbol.get(order.symbol);
    if (freshPrice !== undefined && order.limitPrice !== null && freshPrice < order.limitPrice) {
      result.push({ order, reason: 'price_above_market' });
    }
  }

  return result;
}

export interface StaleOrdersResult {
  stale: StaleOrderInfo[];
  cancelled: AlpacaOrder[];
}

/**
 * Detecta órdenes BUY huérfanas/desalineadas (ver `findStaleOrders`) y, SOLO si
 * `autoCancelStaleOrders` está activo (default `false`), las cancela. Por defecto se limita a
 * loguear/devolver la lista para que la UI las muestre ("órdenes huérfanas detectadas") y el
 * usuario decida - llamada una vez por ciclo de trading (cron), no en el poller de 60s.
 *
 * El "reemplazo" no es una operación separada: el caller (`runTradingCycle()`) saca del
 * `openOrders` en memoria las que esta función cancela ANTES de la Pasada 2, así que si la
 * señal del símbolo sigue siendo BUY este mismo ciclo, el flujo normal de compra ya no
 * encuentra una orden pendiente bloqueándolo y coloca una nueva al precio recién calculado -
 * cancelar + dejar el camino libre logra el cancelar-y-reemplazar en el mismo ciclo.
 */
export async function cancelStaleOrders(
  client: AxiosInstance,
  openOrders: AlpacaOrder[],
  timeoutMin: number,
  autoCancelStaleOrders: boolean,
  freshEntryPriceBySymbol: Map<string, number> = new Map()
): Promise<StaleOrdersResult> {
  const stale = findStaleOrders(openOrders, timeoutMin, freshEntryPriceBySymbol);

  if (stale.length === 0) {
    return { stale, cancelled: [] };
  }

  console.warn(
    `[cancelStaleOrders] ${stale.length} orden(es) BUY huérfana(s)/desalineada(s): ` +
      stale.map(({ order, reason }) => `${order.symbol}(${order.id}, ${reason})`).join(', ')
  );

  if (!autoCancelStaleOrders) {
    return { stale, cancelled: [] };
  }

  const cancelled: AlpacaOrder[] = [];
  for (const { order, reason } of stale) {
    try {
      await cancelOrder(client, order.id);
      cancelled.push(order);
      console.log(`[cancelStaleOrders] Cancelada orden huérfana/desalineada ${order.symbol} (${order.id}, motivo=${reason})`);
    } catch (error) {
      console.error(`[cancelStaleOrders] Error cancelando orden ${order.symbol} (${order.id}):`, error instanceof Error ? error.message : error);
    }
  }
  return { stale, cancelled };
}
