import {
  loadAlpacaConfig,
  loadFmpConfig,
  loadFredConfig,
  loadFinnhubConfig,
  loadPostgresConfig,
  loadRedisConfig,
  loadMinioConfig,
} from './config';
import { createMarketDataClient, getDailyBars, getNews } from './services/marketData';
import { createFmpClient, getCompanyProfile, CompanyProfile } from './services/fmp';
import { createFinnhubClient, getQuote, Quote } from './services/finnhub';
import { createFredClient, getSeriesObservations, MacroObservation } from './services/fred';
import { createPostgresPool } from './services/db';
import { createRedisClient } from './services/cache';
import { createMinioClient, putJsonSnapshot } from './services/storage';
import { setupIngestSchema, saveDailyBars, saveNews, saveFundamentalsSnapshot, saveMacroObservations } from './services/marketStore';
import { WATCHLIST, MACRO_SERIES, BARS_LOOKBACK_DAYS } from './watchlist';

export { WATCHLIST, MACRO_SERIES, BARS_LOOKBACK_DAYS };
export const QUOTE_CACHE_TTL_SECONDS = 300;

export interface IngestSummary {
  watchlist: string[];
  macroSeries: string[];
  bars: number;
  news: number;
  fundamentals: number;
  macroObservations: number;
  quotes: number;
  quoteCacheTtlSeconds: number;
  snapshotKey: string | null;
}

export async function runIngest(): Promise<IngestSummary> {
  const alpacaConfig = loadAlpacaConfig();
  const fmpConfig = loadFmpConfig();
  const finnhubConfig = loadFinnhubConfig();
  const fredConfig = loadFredConfig();
  const postgresConfig = loadPostgresConfig();
  const redisConfig = loadRedisConfig();

  const pool = createPostgresPool(postgresConfig);
  const redis = createRedisClient(redisConfig);

  try {
    await setupIngestSchema(pool);

    // 1. Bars diarias (Alpaca Market Data)
    const marketDataClient = createMarketDataClient(alpacaConfig);
    const bars = await getDailyBars(marketDataClient, WATCHLIST, BARS_LOOKBACK_DAYS);
    await saveDailyBars(pool, bars);

    // 2. Noticias (Alpaca News API / Benzinga)
    const news = await getNews(marketDataClient, WATCHLIST, 20);
    await saveNews(pool, news);

    // 3. Fundamentales (Financial Modeling Prep)
    const fmpClient = createFmpClient(fmpConfig);
    const fundamentals: { symbol: string; profile: CompanyProfile }[] = [];
    for (const symbol of WATCHLIST) {
      const profile = await getCompanyProfile(fmpClient, symbol);
      if (profile) {
        await saveFundamentalsSnapshot(pool, symbol, 'fmp', profile);
        fundamentals.push({ symbol, profile });
      }
    }

    // 4. Series macro (FRED)
    const fredClient = createFredClient(fredConfig);
    const macroObservations: MacroObservation[] = [];
    for (const seriesId of MACRO_SERIES) {
      const observations = await getSeriesObservations(fredClient, seriesId, 6);
      await saveMacroObservations(pool, observations);
      macroObservations.push(...observations);
    }

    // 5. Quotes en vivo (Finnhub) cacheados en Redis para consumo rápido del bot
    const finnhubClient = createFinnhubClient(finnhubConfig);
    const quotes: { symbol: string; quote: Quote }[] = [];
    for (const symbol of WATCHLIST) {
      const quote = await getQuote(finnhubClient, symbol);
      await redis.set(`quote:${symbol}`, JSON.stringify(quote), 'EX', QUOTE_CACHE_TTL_SECONDS);
      quotes.push({ symbol, quote });
    }

    // 6. Snapshot crudo de la corrida en MinIO (Fase 3) - no debe romper la ingesta si falla.
    let snapshotKey: string | null = null;
    try {
      const minioConfig = loadMinioConfig();
      const minioClient = createMinioClient(minioConfig);
      const key = `ingest/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      const snapshot = await putJsonSnapshot(minioClient, minioConfig, key, {
        generatedAt: new Date().toISOString(),
        watchlist: WATCHLIST,
        macroSeries: MACRO_SERIES,
        bars,
        news,
        fundamentals,
        macroObservations,
        quotes,
      });
      snapshotKey = snapshot.key;
    } catch (error) {
      console.error('No se pudo guardar el snapshot de ingesta en MinIO:', error);
    }

    return {
      watchlist: WATCHLIST,
      macroSeries: MACRO_SERIES,
      bars: bars.length,
      news: news.length,
      fundamentals: fundamentals.length,
      macroObservations: macroObservations.length,
      quotes: quotes.length,
      quoteCacheTtlSeconds: QUOTE_CACHE_TTL_SECONDS,
      snapshotKey,
    };
  } finally {
    await redis.quit();
    await pool.end();
  }
}
