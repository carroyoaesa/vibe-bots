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
}

export async function getOpenOrders(client: AxiosInstance, symbol?: string): Promise<AlpacaOrder[]> {
  const { data } = await client.get('/v2/orders', {
    params: { status: 'open', symbols: symbol, nested: true },
  });

  return (data as any[]).map((o) => ({
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    qty: parseFloat(o.qty),
    status: o.status,
    type: o.type,
    orderClass: o.order_class,
  }));
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

export async function cancelOrder(client: AxiosInstance, orderId: string): Promise<void> {
  await client.delete(`/v2/orders/${orderId}`);
}

/** Cierra (liquida a mercado) la posición completa de un símbolo. */
export async function closePosition(client: AxiosInstance, symbol: string) {
  const { data } = await client.delete(`/v2/positions/${symbol}`);
  return data;
}
