import {
  loadAlpacaConfig,
  loadFmpConfig,
  loadFredConfig,
  loadFinnhubConfig,
  loadPostgresConfig,
  loadRedisConfig,
} from './config';
import { createMarketDataClient, getDailyBars, getNews } from './services/marketData';
import { createFmpClient, getCompanyProfile } from './services/fmp';
import { createFinnhubClient, getQuote } from './services/finnhub';
import { createFredClient, getSeriesObservations } from './services/fred';
import { createPostgresPool } from './services/db';
import { createRedisClient } from './services/cache';
import { setupIngestSchema, saveDailyBars, saveNews, saveFundamentalsSnapshot, saveMacroObservations } from './services/marketStore';

export const WATCHLIST = ['AAPL', 'MSFT', 'SPY', 'QQQ', 'NVDA'];
export const MACRO_SERIES = ['FEDFUNDS', 'CPIAUCSL', 'UNRATE'];
export const BARS_LOOKBACK_DAYS = 30;
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
    let fundamentalsCount = 0;
    for (const symbol of WATCHLIST) {
      const profile = await getCompanyProfile(fmpClient, symbol);
      if (profile) {
        await saveFundamentalsSnapshot(pool, symbol, 'fmp', profile);
        fundamentalsCount++;
      }
    }

    // 4. Series macro (FRED)
    const fredClient = createFredClient(fredConfig);
    let macroCount = 0;
    for (const seriesId of MACRO_SERIES) {
      const observations = await getSeriesObservations(fredClient, seriesId, 6);
      await saveMacroObservations(pool, observations);
      macroCount += observations.length;
    }

    // 5. Quotes en vivo (Finnhub) cacheados en Redis para consumo rápido del bot
    const finnhubClient = createFinnhubClient(finnhubConfig);
    let quoteCount = 0;
    for (const symbol of WATCHLIST) {
      const quote = await getQuote(finnhubClient, symbol);
      await redis.set(`quote:${symbol}`, JSON.stringify(quote), 'EX', QUOTE_CACHE_TTL_SECONDS);
      quoteCount++;
    }

    return {
      watchlist: WATCHLIST,
      macroSeries: MACRO_SERIES,
      bars: bars.length,
      news: news.length,
      fundamentals: fundamentalsCount,
      macroObservations: macroCount,
      quotes: quoteCount,
      quoteCacheTtlSeconds: QUOTE_CACHE_TTL_SECONDS,
    };
  } finally {
    await redis.quit();
    await pool.end();
  }
}
