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
 *
 * El parámetro "limit" es el total de barras de TODA la respuesta (suma de todos los
 * símbolos), no por símbolo, y 10000 es el máximo permitido por Alpaca. Cuando
 * `symbols.length * días hábiles` supera ese máximo (p.ej. backfill de 1095 días),
 * la respuesta incluye `next_page_token` y hay que paginar para no truncar el
 * histórico de los símbolos que se devuelven al final.
 */
export async function getDailyBars(client: AxiosInstance, symbols: string[], days: number): Promise<DailyBar[]> {
  return fetchBars(client, symbols, days, '1Day');
}

/**
 * Igual que `getDailyBars` pero `timeframe='1Hour'` (Fase híbrido, `strategy/hybridConfig.ts`).
 * Mismo feed/adjustment (iex/split) que las velas diarias, para mantener consistencia
 * con el histórico cacheado usado en el experimento `phase1_full20` (`bots/backtests`).
 */
export async function getHourlyBars(client: AxiosInstance, symbols: string[], days: number): Promise<DailyBar[]> {
  return fetchBars(client, symbols, days, '1Hour');
}

async function fetchBars(client: AxiosInstance, symbols: string[], days: number, timeframe: '1Day' | '1Hour'): Promise<DailyBar[]> {
  const start = new Date();
  start.setDate(start.getDate() - days);

  const bars: DailyBar[] = [];
  let pageToken: string | undefined;

  do {
    const { data } = await client.get('/v2/stocks/bars', {
      params: {
        symbols: symbols.join(','),
        timeframe,
        start: start.toISOString().slice(0, 10),
        feed: 'iex',
        adjustment: 'split',
        limit: 10000,
        page_token: pageToken,
      },
    });

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

    pageToken = data.next_page_token || undefined;
  } while (pageToken);

  return bars;
}

/**
 * Cierre ajustado por splits Y dividendos (`adjustment=all`) del primer día de
 * mercado en o después de `date`, para cada símbolo. A diferencia de `getDailyBars`
 * (que usa `adjustment=split` para no introducir saltos de precio en los
 * indicadores de `market_bars`), esto es solo para comparar contra "Buy & Hold con
 * dividendos reinvertidos" sobre el período de un backtest (`/api/conditions`) -
 * no se persiste ni afecta `market_bars`/indicadores.
 */
export async function getAdjustedCloses(client: AxiosInstance, symbols: string[], date: string): Promise<Map<string, number>> {
  const end = new Date(`${date}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 5);

  const { data } = await client.get('/v2/stocks/bars', {
    params: {
      symbols: symbols.join(','),
      timeframe: '1Day',
      start: date,
      end: end.toISOString().slice(0, 10),
      feed: 'iex',
      adjustment: 'all',
      limit: 10000,
    },
  });

  const closes = new Map<string, number>();
  for (const [symbol, symbolBars] of Object.entries<any[]>(data.bars || {})) {
    if (symbolBars.length > 0) {
      closes.set(symbol, symbolBars[0].c);
    }
  }
  return closes;
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
