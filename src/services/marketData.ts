import axios, { AxiosInstance } from 'axios';
import { AlpacaConfig } from '../config';

const MARKET_DATA_BASE_URL = 'https://data.alpaca.markets';

export function createMarketDataClient(config: AlpacaConfig): AxiosInstance {
  return axios.create({
    baseURL: MARKET_DATA_BASE_URL,
    headers: {
      'APCA-API-KEY-ID': config.apiKey,
      'APCA-API-SECRET-KEY': config.apiSecret,
    },
  });
}

export interface DailyBar {
  symbol: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
  vwap: number;
}

/**
 * Bars diarias por símbolo. El plan free de Alpaca solo da acceso al feed IEX,
 * por eso se fija explícitamente feed=iex. `adjustment=split` evita discontinuidades
 * de precio (y por lo tanto señales falsas en SMA/RSI/momentum) cuando un símbolo
 * tiene un split dentro de la ventana de lookback.
 */
export async function getDailyBars(client: AxiosInstance, symbols: string[], days: number): Promise<DailyBar[]> {
  const start = new Date();
  start.setDate(start.getDate() - days);

  // El parámetro "limit" es el total de barras de TODA la respuesta (suma de todos los
  // símbolos), no por símbolo. Se usa el máximo permitido por Alpaca para evitar que
  // el watchlist se trunque alfabéticamente cuando hay muchos símbolos.
  const { data } = await client.get('/v2/stocks/bars', {
    params: {
      symbols: symbols.join(','),
      timeframe: '1Day',
      start: start.toISOString().slice(0, 10),
      feed: 'iex',
      adjustment: 'split',
      limit: 10000,
    },
  });

  const bars: DailyBar[] = [];
  for (const [symbol, symbolBars] of Object.entries<any[]>(data.bars || {})) {
    for (const bar of symbolBars) {
      bars.push({
        symbol,
        timestamp: bar.t,
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
        volume: bar.v,
        tradeCount: bar.n,
        vwap: bar.vw,
      });
    }
  }
  return bars;
}

export interface NewsItem {
  id: number;
  headline: string;
  summary: string;
  source: string;
  url: string;
  symbols: string[];
  publishedAt: string;
}

export async function getNews(client: AxiosInstance, symbols: string[], limit: number): Promise<NewsItem[]> {
  const { data } = await client.get('/v1beta1/news', {
    params: { symbols: symbols.join(','), limit },
  });

  return (data.news || []).map((item: any) => ({
    id: item.id,
    headline: item.headline,
    summary: item.summary,
    source: item.source,
    url: item.url,
    symbols: item.symbols || [],
    publishedAt: item.created_at,
  }));
}

export async function verifyMarketData(client: AxiosInstance): Promise<{ bars: number; news: number }> {
  const [bars, news] = await Promise.all([
    getDailyBars(client, ['AAPL'], 5),
    getNews(client, ['AAPL'], 1),
  ]);

  return { bars: bars.length, news: news.length };
}
