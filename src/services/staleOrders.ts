import { AxiosInstance } from 'axios';
import { AlpacaOrder, cancelOrder } from './alpaca';

export type StaleReason = 'timeout' | 'price_above_market';

export interface StaleOrderInfo {
  order: AlpacaOrder;
  reason: StaleReason;
}

/**
 * Órdenes BUY abiertas candidatas a huérfanas/desalineadas:
 * - 'timeout': pendientes hace más de `timeoutMin` minutos, Y el precio fresco de hoy para ese
 *   símbolo (si lo hay) es DISTINTO del límite de la orden - ver nota 2026-06-23 más abajo.
 * - 'price_above_market': el símbolo tiene señal BUY vigente este ciclo
 *   (`freshEntryPriceBySymbol`) y el precio que se colocaría HOY es MENOR que el límite de la
 *   orden pendiente (la orden vieja está pagando de más respecto de la estimación actual) -
 *   sin importar cuánto lleve abierta, y sin tolerancia mínima: cualquier diferencia cuenta
 *   (decisión explícita del usuario, 2026-06-21 - no usar un umbral de %). Direccional a
 *   propósito: si el precio de hoy es MAYOR que el límite viejo, no se toca - una orden de
 *   compra con límite más bajo no es "peor", solo menos probable de fillear, y reemplazarla no
 *   aporta nada.
 *
 * Nota 2026-06-23: 'timeout' ya NO dispara si el precio fresco de hoy redondea exactamente al
 * mismo valor que el límite de la orden. Antes de este cambio, cancelar por timeout no miraba el
 * precio en absoluto - con una señal BUY "pegajosa" (condición técnica que se mantiene varias
 * horas porque viene de la vela diaria, que solo se actualiza con la ingesta 3x/día) y un precio
 * estimado que tampoco cambia, cada ~`timeoutMin` minutos se cancelaba la orden y la Pasada 2 del
 * mismo ciclo colocaba una IDÉNTICA (mismo símbolo/precio/cantidad) - sin ningún cambio real,
 * solo un ID de orden nuevo y, por la Fase 12, un email de alerta nuevo. Confirmado en producción
 * 2026-06-22: AAPL generó 10 órdenes BUY a $289.53 entre 16:05 y 19:50 UTC mientras su vela diaria
 * (y por lo tanto su señal/precio estimado) quedó congelada en $300.89 toda la tarde - cada
 * reemplazo sin cambio de precio disparó su propio email y su propia evaluación de Claude (48
 * llamadas solo de AAPL ese día). Si el símbolo ya no es candidato BUY este ciclo
 * (`freshPrice === undefined`, p.ej. la condición cambió a HOLD/SELL), 'timeout' sigue
 * disparando igual que antes - ese caso es una orden genuinamente huérfana (no hay reemplazo en
 * la Pasada 2), no el bucle de clones. Sin tolerancia de PORCENTAJE en ningún lado de esta
 * función (decisión explícita del usuario, 2026-06-21) - esto solo evita reemplazar una orden por
 * una copia exacta de sí misma.
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

    const freshPrice = freshEntryPriceBySymbol.get(order.symbol);
    // Redondeo a centavos antes de comparar: `order.limitPrice` viene de Alpaca ya redondeado
    // a 2 decimales (`placeBuyOrder` manda `limitPrice.toFixed(2)`), pero `freshPrice` es un
    // float crudo de la estrategia (p.ej. 289.52969999999993 para un precio "real" de 289.53) -
    // sin este redondeo, ese ruido de representación se leía como "el precio bajó" en CADA
    // ciclo (nunca es 100% igual en punto flotante), cancelando y reemplazando la misma orden
    // sin que el precio se haya movido un centavo - confirmado en producción 2026-06-22 (AAPL
    // generaba una orden nueva y un email de alerta cada 5 min). Sigue sin tolerancia de
    // PORCENTAJE (decisión explícita del usuario, 2026-06-21) - esto solo iguala la precisión
    // de la comparación a la que ya tienen los precios reales de las órdenes (centavos).
    const freshPriceCents = freshPrice !== undefined ? Math.round(freshPrice * 100) / 100 : undefined;
    const priceUnchanged = freshPriceCents !== undefined && order.limitPrice !== null && freshPriceCents === order.limitPrice;

    const ageMs = now.getTime() - new Date(order.submittedAt).getTime();
    if (ageMs > timeoutMs && !priceUnchanged) {
      result.push({ order, reason: 'timeout' });
      continue;
    }

    if (freshPriceCents !== undefined && order.limitPrice !== null && freshPriceCents < order.limitPrice) {
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
