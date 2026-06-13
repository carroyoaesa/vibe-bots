import axios, { AxiosInstance } from 'axios';
import { FredConfig } from '../config';

const FRED_BASE_URL = 'https://api.stlouisfed.org/fred';

export function createFredClient(config: FredConfig): AxiosInstance {
  return axios.create({
    baseURL: FRED_BASE_URL,
    params: { api_key: config.apiKey, file_type: 'json' },
  });
}

export interface MacroObservation {
  seriesId: string;
  date: string;
  value: number | null;
}

export async function getSeriesObservations(
  client: AxiosInstance,
  seriesId: string,
  limit: number
): Promise<MacroObservation[]> {
  const { data } = await client.get('/series/observations', {
    params: { series_id: seriesId, sort_order: 'desc', limit },
  });

  return (data.observations || []).map((obs: any) => ({
    seriesId,
    date: obs.date,
    value: obs.value === '.' ? null : parseFloat(obs.value),
  }));
}

export async function verifyFred(client: AxiosInstance): Promise<MacroObservation[]> {
  const observations = await getSeriesObservations(client, 'FEDFUNDS', 1);

  if (observations.length === 0) {
    throw new Error('FRED no devolvió observaciones para FEDFUNDS');
  }

  return observations;
}
