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
import { createRedisClient, verifyRedis, getCachedJson, setCachedJson, ALPACA_ACCOUNT_CACHE_KEY, ALPACA_ACCOUNT_CACHE_TTL_SECONDS } from './services/cache';
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
  /** Si se define junto a cacheTtlSeconds, el resultado se cachea en Redis para no llamar a la API externa en cada poll de /api/health. */
  cacheKey?: string;
  cacheTtlSeconds?: number;
}

export interface DiagnosticResult {
  id: string;
  name: string;
  emoji: string;
  ok: boolean;
  summary: string[];
  error?: string;
  durationMs: number;
  cached: boolean;
  cachedAt?: string;
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
    // Mismo dato (cuenta de Alpaca) y misma clave que usa /api/trading/status, así ambos
    // pollers de 60s del dashboard comparten una sola llamada a GET /v2/account.
    cacheKey: ALPACA_ACCOUNT_CACHE_KEY,
    cacheTtlSeconds: ALPACA_ACCOUNT_CACHE_TTL_SECONDS,
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
    cacheKey: 'health:market-data',
    cacheTtlSeconds: 300,
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
    cacheKey: 'health:fmp',
    cacheTtlSeconds: 600,
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
    cacheKey: 'health:finnhub',
    cacheTtlSeconds: 300,
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
    // Alpha Vantage free tier: 25 requests/día. Con polling de /api/health cada 60s, sin
    // caché esto agota el límite diario en ~25 minutos. TTL de 2h => máx. ~12 llamadas/día.
    cacheKey: 'health:alpha-vantage',
    cacheTtlSeconds: 7200,
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
    cacheKey: 'health:fred',
    cacheTtlSeconds: 1800,
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
    cacheKey: 'health:anthropic',
    cacheTtlSeconds: 600,
    summarize: (result) => [`Modelo: ${result.model}`, `Respuesta: ${result.reply}`],
  },
];

export async function runDiagnostics(): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];
  const redis = createRedisClient(loadRedisConfig());

  try {
    for (const check of DIAGNOSTIC_CHECKS) {
      const start = Date.now();
      try {
        const hit = check.cacheKey ? await getCachedJson<unknown>(redis, check.cacheKey) : null;

        let result: unknown;
        let cached = false;
        let cachedAt: string | undefined;

        if (hit) {
          result = hit.value;
          cached = true;
          cachedAt = hit.cachedAt;
        } else {
          result = await check.run();
          if (check.cacheKey && check.cacheTtlSeconds) {
            cachedAt = (await setCachedJson(redis, check.cacheKey, result, check.cacheTtlSeconds)).cachedAt;
          }
        }

        results.push({
          id: check.id,
          name: check.name,
          emoji: check.emoji,
          ok: true,
          summary: check.summarize(result),
          durationMs: Date.now() - start,
          cached,
          cachedAt,
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
          cached: false,
        });
      }
    }
  } finally {
    await redis.quit();
  }

  return results;
}
