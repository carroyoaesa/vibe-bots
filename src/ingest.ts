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

const WATCHLIST = ['AAPL', 'MSFT', 'SPY', 'QQQ', 'NVDA'];
const MACRO_SERIES = ['FEDFUNDS', 'CPIAUCSL', 'UNRATE'];
const BARS_LOOKBACK_DAYS = 30;
const QUOTE_CACHE_TTL_SECONDS = 300;

async function main() {
  console.log('📥 Vibe Bots - Ingesta de datos (Fase 1)\n');

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
    console.log('✅ Esquema de ingesta verificado (market_bars, news_items, fundamentals_snapshots, macro_series)\n');

    // 1. Bars diarias (Alpaca Market Data)
    const marketDataClient = createMarketDataClient(alpacaConfig);
    const bars = await getDailyBars(marketDataClient, WATCHLIST, BARS_LOOKBACK_DAYS);
    await saveDailyBars(pool, bars);
    console.log(`📊 Bars guardadas: ${bars.length} (watchlist: ${WATCHLIST.join(', ')})`);

    // 2. Noticias (Alpaca News API / Benzinga)
    const news = await getNews(marketDataClient, WATCHLIST, 20);
    await saveNews(pool, news);
    console.log(`📰 Noticias guardadas: ${news.length}`);

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
    console.log(`🏢 Snapshots de fundamentales guardados: ${fundamentalsCount}`);

    // 4. Series macro (FRED)
    const fredClient = createFredClient(fredConfig);
    let macroCount = 0;
    for (const seriesId of MACRO_SERIES) {
      const observations = await getSeriesObservations(fredClient, seriesId, 6);
      await saveMacroObservations(pool, observations);
      macroCount += observations.length;
    }
    console.log(`🏛️  Observaciones macro guardadas: ${macroCount} (series: ${MACRO_SERIES.join(', ')})`);

    // 5. Quotes en vivo (Finnhub) cacheados en Redis para consumo rápido del bot
    const finnhubClient = createFinnhubClient(finnhubConfig);
    let quoteCount = 0;
    for (const symbol of WATCHLIST) {
      const quote = await getQuote(finnhubClient, symbol);
      await redis.set(`quote:${symbol}`, JSON.stringify(quote), 'EX', QUOTE_CACHE_TTL_SECONDS);
      quoteCount++;
    }
    console.log(`📡 Quotes cacheados en Redis: ${quoteCount} (TTL ${QUOTE_CACHE_TTL_SECONDS}s)\n`);

    console.log('✅ Ingesta completada con éxito');
  } finally {
    await redis.quit();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('❌ Error en la ingesta:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
