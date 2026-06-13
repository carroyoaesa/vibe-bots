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
