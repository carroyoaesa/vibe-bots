import {
  loadAlpacaConfig,
  loadMinioConfig,
  loadPostgresConfig,
  loadRedisConfig,
  loadFmpConfig,
  loadFinnhubConfig,
  loadAlphaVantageConfig,
  loadFredConfig,
  loadAnthropicConfig,
} from './config';
import { createAlpacaClient, verifyAlpaca } from './services/alpaca';
import { createPostgresPool, verifyPostgres } from './services/db';
import { createRedisClient, verifyRedis } from './services/cache';
import { createMinioClient, verifyStorage } from './services/storage';
import { createMarketDataClient, verifyMarketData } from './services/marketData';
import { createFmpClient, verifyFmp } from './services/fmp';
import { createFinnhubClient, verifyFinnhub } from './services/finnhub';
import { createAlphaVantageClient, verifyAlphaVantage } from './services/alphaVantage';
import { createFredClient, verifyFred } from './services/fred';
import { createAnthropicClient, verifyAnthropic } from './services/claude';

export interface DiagnosticCheck<T = unknown> {
  id: string;
  name: string;
  emoji: string;
  run: () => Promise<T>;
  summarize: (result: T) => string[];
}

export interface DiagnosticResult {
  id: string;
  name: string;
  emoji: string;
  ok: boolean;
  summary: string[];
  error?: string;
  durationMs: number;
}

export const DIAGNOSTIC_CHECKS: DiagnosticCheck<any>[] = [
  {
    id: 'alpaca',
    name: 'Alpaca',
    emoji: '📊',
    run: async () => {
      const client = createAlpacaClient(loadAlpacaConfig());
      return verifyAlpaca(client);
    },
    summarize: (account) => [
      `Cuenta: ${account.accountNumber}`,
      `Estado: ${account.status}`,
      `Efectivo: $${account.cash.toFixed(2)}`,
      `Poder de compra: $${account.buyingPower.toFixed(2)}`,
      `Patrimonio neto: $${account.equity.toFixed(2)}`,
    ],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    emoji: '🗄️',
    run: async () => {
      const pool = createPostgresPool(loadPostgresConfig());
      try {
        return await verifyPostgres(pool);
      } finally {
        await pool.end();
      }
    },
    summarize: (result) => [`PostgreSQL OK: ${JSON.stringify(result)}`],
  },
  {
    id: 'redis',
    name: 'Redis',
    emoji: '🧠',
    run: async () => {
      const client = createRedisClient(loadRedisConfig());
      return verifyRedis(client);
    },
    summarize: (result) => [`Redis OK: ${JSON.stringify(result)}`],
  },
  {
    id: 'minio',
    name: 'MinIO',
    emoji: '📦',
    run: async () => {
      const config = loadMinioConfig();
      const client = createMinioClient(config);
      return verifyStorage(client, config);
    },
    summarize: (result) => [`MinIO OK: ${result}`],
  },
  {
    id: 'market-data',
    name: 'Alpaca Market Data',
    emoji: '📈',
    run: async () => {
      const client = createMarketDataClient(loadAlpacaConfig());
      return verifyMarketData(client);
    },
    summarize: (result) => [
      `Bars (AAPL, 5 días): ${result.bars}`,
      `Noticias (AAPL): ${result.news}`,
    ],
  },
  {
    id: 'fmp',
    name: 'Financial Modeling Prep',
    emoji: '🏢',
    run: async () => {
      const client = createFmpClient(loadFmpConfig());
      return verifyFmp(client);
    },
    summarize: (profile) => [
      `${profile.symbol}: ${profile.companyName} (${profile.sector ?? 'sin sector'})`,
      `Market cap: $${profile.marketCap.toLocaleString()}`,
    ],
  },
  {
    id: 'finnhub',
    name: 'Finnhub',
    emoji: '📡',
    run: async () => {
      const client = createFinnhubClient(loadFinnhubConfig());
      return verifyFinnhub(client);
    },
    summarize: (quote) => [
      `${quote.symbol} precio actual: $${quote.current}`,
      `Cierre anterior: $${quote.previousClose}`,
    ],
  },
  {
    id: 'alpha-vantage',
    name: 'Alpha Vantage',
    emoji: '📉',
    run: async () => {
      const client = createAlphaVantageClient(loadAlphaVantageConfig());
      return verifyAlphaVantage(client);
    },
    summarize: (quote) => [`${quote.symbol} precio: $${quote.price} (${quote.changePercent})`],
  },
  {
    id: 'fred',
    name: 'FRED',
    emoji: '🏛️',
    run: async () => {
      const client = createFredClient(loadFredConfig());
      return verifyFred(client);
    },
    summarize: (observations) => {
      const [latest] = observations;
      return [`FEDFUNDS (${latest.date}): ${latest.value}`];
    },
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    emoji: '🧠',
    run: async () => {
      const config = loadAnthropicConfig();
      const client = createAnthropicClient(config);
      return verifyAnthropic(client, config.model);
    },
    summarize: (result) => [`Modelo: ${result.model}`, `Respuesta: ${result.reply}`],
  },
];

export async function runDiagnostics(): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];

  for (const check of DIAGNOSTIC_CHECKS) {
    const start = Date.now();
    try {
      const result = await check.run();
      results.push({
        id: check.id,
        name: check.name,
        emoji: check.emoji,
        ok: true,
        summary: check.summarize(result),
        durationMs: Date.now() - start,
      });
    } catch (error) {
      results.push({
        id: check.id,
        name: check.name,
        emoji: check.emoji,
        ok: false,
        summary: [],
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - start,
      });
    }
  }

  return results;
}
