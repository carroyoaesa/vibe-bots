import axios, { AxiosInstance } from 'axios';
import { FmpConfig } from '../config';

const FMP_BASE_URL = 'https://financialmodelingprep.com/stable';

export function createFmpClient(config: FmpConfig): AxiosInstance {
  return axios.create({
    baseURL: FMP_BASE_URL,
    params: { apikey: config.apiKey },
  });
}

export interface CompanyProfile {
  symbol: string;
  companyName: string;
  sector: string | null;
  industry: string | null;
  exchange: string;
  marketCap: number;
  price: number;
  beta: number;
}

export async function getCompanyProfile(client: AxiosInstance, symbol: string): Promise<CompanyProfile | null> {
  const { data } = await client.get('/profile', { params: { symbol } });

  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  const p = data[0];
  return {
    symbol: p.symbol,
    companyName: p.companyName,
    sector: p.sector ?? null,
    industry: p.industry ?? null,
    exchange: p.exchange,
    marketCap: p.marketCap,
    price: p.price,
    beta: p.beta,
  };
}

export async function verifyFmp(client: AxiosInstance): Promise<CompanyProfile> {
  const profile = await getCompanyProfile(client, 'AAPL');

  if (!profile) {
    throw new Error('FMP no devolvió datos para AAPL');
  }

  return profile;
}
