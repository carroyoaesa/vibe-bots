import axios, { AxiosInstance } from 'axios';
import { AlphaVantageConfig } from '../config';

const ALPHA_VANTAGE_BASE_URL = 'https://www.alphavantage.co';

export function createAlphaVantageClient(config: AlphaVantageConfig): AxiosInstance {
  return axios.create({
    baseURL: ALPHA_VANTAGE_BASE_URL,
    params: { apikey: config.apiKey },
  });
}

export interface GlobalQuote {
  symbol: string;
  price: number;
  previousClose: number;
  changePercent: string;
}

/**
 * Free tier de Alpha Vantage es ~25 requests/día: usar con moderación
 * (no llamar en loops sobre el watchlist completo).
 */
export async function getGlobalQuote(client: AxiosInstance, symbol: string): Promise<GlobalQuote> {
  const { data } = await client.get('/query', {
    params: { function: 'GLOBAL_QUOTE', symbol },
  });

  const quote = data['Global Quote'];
  if (!quote || !quote['05. price']) {
    throw new Error(`Alpha Vantage no devolvió datos para ${symbol}: ${JSON.stringify(data)}`);
  }

  return {
    symbol: quote['01. symbol'],
    price: parseFloat(quote['05. price']),
    previousClose: parseFloat(quote['08. previous close']),
    changePercent: quote['10. change percent'],
  };
}

export async function verifyAlphaVantage(client: AxiosInstance): Promise<GlobalQuote> {
  return getGlobalQuote(client, 'AAPL');
}
