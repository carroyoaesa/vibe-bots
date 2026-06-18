import axios, { AxiosInstance } from 'axios';
import { AlpacaConfig } from '../config';

export function createAlpacaClient(config: AlpacaConfig): AxiosInstance {
  return axios.create({
    baseURL: config.baseUrl,
    headers: {
      'APCA-API-KEY-ID': config.apiKey,
      'APCA-API-SECRET-KEY': config.apiSecret,
    },
  });
}

export type AccountGroup = 'aptos' | 'observados' | 'bloqueados';

export const ACCOUNT_GROUPS: AccountGroup[] = ['aptos', 'observados', 'bloqueados'];

/**
 * Cliente Alpaca por cuenta paper segmentada (`symbol_classifications` - 'apto'->'aptos',
 * 'observar'->'observados', 'bloqueado'->'bloqueados'), credenciales leídas de
 * `ALPACA_<GRUPO>_KEY`/`_SECRET`/`_ENDPOINT` en `secure/keys.env` - nunca hardcodeadas ni
 * logueadas (Fase Operaciones multi-cuenta). Si el grupo no tiene las 3 variables
 * configuradas (hoy, 'bloqueados' es opcional - no se opera ahí), devuelve `null` (solo se
 * loguea el nombre del grupo) y el caller debe degradar sin enviar nada a Alpaca para ese grupo.
 */
export function getAlpacaClient(group: AccountGroup): AxiosInstance | null {
  const prefix = group.toUpperCase();
  const apiKey = process.env[`ALPACA_${prefix}_KEY`];
  const apiSecret = process.env[`ALPACA_${prefix}_SECRET`];
  const endpoint = process.env[`ALPACA_${prefix}_ENDPOINT`];

  if (!apiKey || !apiSecret || !endpoint) {
    console.warn(`[getAlpacaClient] Sin credenciales completas para el grupo '${group}' (ALPACA_${prefix}_KEY/_SECRET/_ENDPOINT) - sync omitida para este grupo.`);
    return null;
  }

  // El baseURL de axios no debe incluir '/v2' - cada request lo agrega (ver resto de este archivo).
  const baseUrl = endpoint.replace(/\/v2\/?$/, '');
  return createAlpacaClient({ apiKey, apiSecret, baseUrl });
}

/**
 * Reintenta `fn` con backoff exponencial (2s, 4s, 8s, tope 30s) si Alpaca devuelve 429
 * (rate limit). Cualquier otro error se relanza de inmediato. Usado por el poller de
 * sincronización multi-cuenta para nunca tirar una excepción al ciclo principal por un
 * 429 pasajero - agota los reintentos y loguea un warning antes de relanzar.
 */
export async function withAlpacaBackoff<T>(fn: () => Promise<T>, label: string, maxRetries = 4): Promise<T> {
  let delayMs = 2000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const status = error?.response?.status;
      if (status !== 429 || attempt === maxRetries) throw error;
      console.warn(`[withAlpacaBackoff] 429 en '${label}' (intento ${attempt + 1}/${maxRetries + 1}) - reintentando en ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 30000);
    }
  }
  throw new Error(`withAlpacaBackoff: inalcanzable (${label})`);
}

export interface AlpacaAccountSummary {
  accountNumber: string;
  status: string;
  cash: number;
  buyingPower: number;
  equity: number;
}

export async function verifyAlpaca(client: AxiosInstance): Promise<AlpacaAccountSummary> {
  const { data: account } = await client.get('/v2/account');

  return {
    accountNumber: account.account_number,
    status: account.status,
    cash: parseFloat(account.cash),
    buyingPower: parseFloat(account.buying_power),
    equity: parseFloat(account.equity),
  };
}

export async function getAccount(client: AxiosInstance): Promise<AlpacaAccountSummary> {
  return verifyAlpaca(client);
}

export interface AlpacaPosition {
  symbol: string;
  qty: number;
  side: string;
  avgEntryPrice: number;
  marketValue: number;
  unrealizedPl: number;
  currentPrice: number;
}

export async function getPositions(client: AxiosInstance): Promise<AlpacaPosition[]> {
  const { data } = await client.get('/v2/positions');

  return (data as any[]).map((p) => ({
    symbol: p.symbol,
    qty: parseFloat(p.qty),
    side: p.side,
    avgEntryPrice: parseFloat(p.avg_entry_price),
    marketValue: parseFloat(p.market_value),
    unrealizedPl: parseFloat(p.unrealized_pl),
    currentPrice: parseFloat(p.current_price),
  }));
}

export interface AlpacaOrder {
  id: string;
  symbol: string;
  side: string;
  qty: number;
  status: string;
  type: string;
  orderClass: string;
  limitPrice: number | null;
  submittedAt: string | null;
}

function mapOrder(o: any): AlpacaOrder {
  return {
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    qty: parseFloat(o.qty),
    status: o.status,
    type: o.type,
    orderClass: o.order_class,
    limitPrice: o.limit_price !== null && o.limit_price !== undefined ? parseFloat(o.limit_price) : null,
    submittedAt: o.submitted_at ?? null,
  };
}

/**
 * Órdenes ABIERTAS/PENDIENTES (estados no terminales: new/accepted/pending_new/
 * partially_filled/held, entre otros - `status=open` de Alpaca los cubre todos).
 */
export async function getOpenOrders(client: AxiosInstance, symbol?: string): Promise<AlpacaOrder[]> {
  const { data } = await client.get('/v2/orders', {
    params: { status: 'open', symbols: symbol, nested: true, limit: 500 },
  });

  return (data as any[]).map(mapOrder);
}

/** Últimas `limit` órdenes ya resueltas (filled/canceled/expired/rejected) - para "órdenes ejecutadas" por cuenta. */
export async function getClosedOrders(client: AxiosInstance, limit = 20): Promise<AlpacaOrder[]> {
  const { data } = await client.get('/v2/orders', {
    params: { status: 'closed', limit, direction: 'desc', nested: true },
  });

  return (data as any[]).map(mapOrder);
}

export interface BuyOrderRequest {
  symbol: string;
  qty: number;
  limitPrice: number;
}

/**
 * Coloca una orden de compra límite simple (order_class=simple, sin take-profit/stop-loss).
 * Usada cuando `bot_settings.exit_mode = 'signal_only'` (Fase A.1): la posición se cierra
 * únicamente vía `closePosition` cuando la condición activa emite señal SELL.
 */
export async function placeBuyOrder(client: AxiosInstance, req: BuyOrderRequest) {
  const { data } = await client.post('/v2/orders', {
    symbol: req.symbol,
    qty: req.qty.toString(),
    side: 'buy',
    type: 'limit',
    limit_price: req.limitPrice.toFixed(2),
    time_in_force: 'day',
  });

  return data;
}

export interface SellOrderRequest {
  symbol: string;
  qty: number;
  limitPrice: number;
}

/**
 * Coloca una orden de venta límite simple. Usada por el botón manual "Vender al precio
 * estimado" (Operaciones, Fase multi-cuenta) - solo se envía cuando el usuario confirma
 * explícitamente, nunca automático.
 */
export async function placeSellOrder(client: AxiosInstance, req: SellOrderRequest) {
  const { data } = await client.post('/v2/orders', {
    symbol: req.symbol,
    qty: req.qty.toString(),
    side: 'sell',
    type: 'limit',
    limit_price: req.limitPrice.toFixed(2),
    time_in_force: 'day',
  });

  return data;
}

export interface BracketBuyOrderRequest {
  symbol: string;
  qty: number;
  limitPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
}

/** Coloca una orden de compra límite (al precio estimado de entrada) con take-profit y stop-loss adjuntos (order_class=bracket). */
export async function placeBracketBuyOrder(client: AxiosInstance, req: BracketBuyOrderRequest) {
  const { data } = await client.post('/v2/orders', {
    symbol: req.symbol,
    qty: req.qty.toString(),
    side: 'buy',
    type: 'limit',
    limit_price: req.limitPrice.toFixed(2),
    time_in_force: 'day',
    order_class: 'bracket',
    take_profit: { limit_price: req.takeProfitPrice.toFixed(2) },
    stop_loss: { stop_price: req.stopLossPrice.toFixed(2) },
  });

  return data;
}

export interface AlpacaMarketClock {
  isOpen: boolean;
  nextOpen: string;
  nextClose: string;
  timestamp: string;
}

/** Estado del mercado (abierto/cerrado) y próxima apertura/cierre, según el calendario de Alpaca. */
export async function getMarketClock(client: AxiosInstance): Promise<AlpacaMarketClock> {
  const { data } = await client.get('/v2/clock');

  return {
    isOpen: data.is_open,
    nextOpen: data.next_open,
    nextClose: data.next_close,
    timestamp: data.timestamp,
  };
}

export async function cancelOrder(client: AxiosInstance, orderId: string): Promise<void> {
  await client.delete(`/v2/orders/${orderId}`);
}

/** Cierra (liquida a mercado) la posición completa de un símbolo. */
export async function closePosition(client: AxiosInstance, symbol: string) {
  const { data } = await client.delete(`/v2/positions/${symbol}`);
  return data;
}

/**
 * Cierra (liquida a mercado) solo `qty` acciones de la posición de un símbolo, dejando
 * el resto intacto. Usado por el sistema paralelo (Tier 2, `strategy/hybridConfig.ts`)
 * para vender únicamente la cantidad trackeada en `parallel_positions` sin afectar la
 * posición 1D del mismo símbolo.
 */
export async function closePositionQty(client: AxiosInstance, symbol: string, qty: number) {
  const { data } = await client.delete(`/v2/positions/${symbol}`, {
    params: { qty: qty.toString() },
  });
  return data;
}
