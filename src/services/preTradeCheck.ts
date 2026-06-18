import { Pool } from 'pg';
import { AlpacaOrder, AlpacaPosition } from './alpaca';
import { getSymbolClassification, SymbolClassificationStatus } from './symbolClassificationStore';

export type BuyBlockReason =
  | 'SYMBOL_BLOCKED_MANUAL'
  | 'POSITION_ALREADY_OPEN'
  | 'PENDING_BUY_ORDER'
  | 'EXPOSURE_LIMIT_EXCEEDED'
  | 'MAX_POSITIONS_REACHED';

export interface CanPlaceBuyResult {
  allowed: boolean;
  reason?: BuyBlockReason;
  orderId?: string;
}

export interface BuyCheckContext {
  /** Posición abierta para el símbolo en la cuenta relevante (`undefined` si no hay). */
  position: AlpacaPosition | undefined;
  /** Órdenes ABIERTAS/PENDIENTES (cualquier lado) para el símbolo en esa cuenta. */
  openOrders: AlpacaOrder[];
  openPositionsCount: number;
  maxPositions: number;
  equity: number;
  /** `riskProfile.positionSizePct` activo - usado como tope de exposición por símbolo. */
  positionSizePct: number;
  /** Valor ($) de la orden BUY que se está evaluando colocar ahora (qty × precio de referencia). */
  estimatedOrderValue: number;
}

function computeCanPlaceBuyOrder(classification: SymbolClassificationStatus, ctx: BuyCheckContext): CanPlaceBuyResult {
  // 1) Clasificación manual - bloqueo duro, sin excepciones (regla histórica, sin tocar).
  if (classification === 'bloqueado') {
    return { allowed: false, reason: 'SYMBOL_BLOCKED_MANUAL' };
  }

  // 2) Posición ya abierta para el símbolo.
  if (ctx.position) {
    return { allowed: false, reason: 'POSITION_ALREADY_OPEN' };
  }

  // 3) Orden BUY pendiente (causa raíz del bug de duplicación: antes solo se chequeaba
  // "alguna orden abierta" sin filtrar por lado - una SELL pendiente bloqueaba un BUY nuevo
  // sin motivo, y el reason genérico no distinguía el caso de duplicación real).
  const pendingBuy = ctx.openOrders.find((o) => o.side === 'buy');
  if (pendingBuy) {
    return { allowed: false, reason: 'PENDING_BUY_ORDER', orderId: pendingBuy.id };
  }

  // 4) Tope de exposición por símbolo: posición existente (0 acá, ver check 2) + órdenes BUY
  // pendientes (0 acá, ver check 3) + el valor estimado de la orden nueva, contra
  // equity × positionSizePct. Con los checks 2/3 ya filtrando cualquier exposición previa,
  // esto en la práctica acota la orden nueva sola - se mantiene la fórmula completa (no solo
  // `estimatedOrderValue > limit`) para que siga siendo correcta si en el futuro se llama
  // con posiciones parciales (fills parciales, multi-cuenta real).
  const pendingBuyValue = ctx.openOrders
    .filter((o) => o.side === 'buy')
    .reduce((sum, o) => sum + o.qty * (o.limitPrice ?? 0), 0);
  const positionValue = ctx.position ? (ctx.position as AlpacaPosition).marketValue : 0;
  const exposureLimit = ctx.equity * ctx.positionSizePct;
  const projectedExposure = positionValue + pendingBuyValue + ctx.estimatedOrderValue;
  if (projectedExposure > exposureLimit) {
    return { allowed: false, reason: 'EXPOSURE_LIMIT_EXCEEDED' };
  }

  // 5) Tope de posiciones abiertas máximas del perfil de riesgo activo.
  if (ctx.openPositionsCount >= ctx.maxPositions) {
    return { allowed: false, reason: 'MAX_POSITIONS_REACHED' };
  }

  return { allowed: true };
}

interface CacheEntry {
  result: CanPlaceBuyResult;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(group: string, symbol: string): string {
  return `${group}:${symbol}`;
}

/**
 * Pre-trade check unificado para BUY (Fase Operaciones multi-cuenta, 2026-06-18) - mata de
 * raíz el bug de duplicación: antes, `tradingRunner.ts` solo chequeaba "¿hay alguna orden
 * abierta?" sin distinguir lado ni exponer un motivo específico. Acá se consulta, en orden
 * fail-fast: clasificación bloqueada, posición abierta, orden BUY pendiente, tope de
 * exposición por símbolo, tope de posiciones abiertas - el primero que falla determina el
 * `reason`. Cachea por `group+symbol` 30s (`invalidateBuyCheck` limpia la entrada al colocar/
 * cancelar una orden o al final del ciclo) para no recalcular dentro del mismo ciclo si se
 * consulta más de una vez para el mismo símbolo.
 *
 * `pool` se usa solo para `getSymbolClassification` (que ya tiene su propia caché de 30s en
 * `symbolClassificationStore.ts`); el resto del contexto (posición/órdenes/equity) lo pasa el
 * caller porque ya lo tiene fresco del ciclo en curso - volver a pedirlo acá adentro
 * desperdiciaría exactamente las llamadas a Alpaca que esta caché busca evitar.
 */
export async function canPlaceBuyOrder(pool: Pool, symbol: string, group: string, ctx: BuyCheckContext): Promise<CanPlaceBuyResult> {
  const key = cacheKey(group, symbol);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.result;

  const classification = await getSymbolClassification(pool, symbol);
  const result = computeCanPlaceBuyOrder(classification, ctx);
  cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

/** Invalida la caché de `canPlaceBuyOrder` - sin argumentos limpia todo (fin de ciclo); con `group` (+ `symbol`) limpia solo esa entrada. */
export function invalidateBuyCheck(group?: string, symbol?: string): void {
  if (!group) {
    cache.clear();
    return;
  }
  if (!symbol) {
    for (const key of cache.keys()) {
      if (key.startsWith(`${group}:`)) cache.delete(key);
    }
    return;
  }
  cache.delete(cacheKey(group, symbol));
}
