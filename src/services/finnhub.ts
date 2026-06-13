import axios, { AxiosInstance } from 'axios';
import { FinnhubConfig } from '../config';

const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';

export function createFinnhubClient(config: FinnhubConfig): AxiosInstance {
  return axios.create({
    baseURL: FINNHUB_BASE_URL,
    params: { token: config.apiKey },
  });
}

export interface Quote {
  symbol: string;
  current: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
}

export async function getQuote(client: AxiosInstance, symbol: string): Promise<Quote> {
  const { data } = await client.get('/quote', { params: { symbol } });

  return {
    symbol,
    current: data.c,
    open: data.o,
    high: data.h,
    low: data.l,
    previousClose: data.pc,
  };
}

export async function verifyFinnhub(client: AxiosInstance): Promise<Quote> {
  const quote = await getQuote(client, 'AAPL');

  if (!quote.current) {
    throw new Error('Finnhub no devolvió un quote válido para AAPL');
  }

  return quote;
}
