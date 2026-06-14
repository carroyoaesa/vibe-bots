import { Pool } from 'pg';
import { DailyBar, NewsItem } from './marketData';
import { MacroObservation } from './fred';

export async function setupIngestSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_bars (
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL,
      open NUMERIC NOT NULL,
      high NUMERIC NOT NULL,
      low NUMERIC NOT NULL,
      close NUMERIC NOT NULL,
      volume BIGINT NOT NULL,
      trade_count BIGINT,
      vwap NUMERIC,
      PRIMARY KEY (symbol, timeframe, ts)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS news_items (
      id BIGINT PRIMARY KEY,
      headline TEXT NOT NULL,
      summary TEXT,
      source TEXT,
      url TEXT,
      symbols TEXT[],
      published_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fundamentals_snapshots (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      source TEXT NOT NULL,
      data JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS macro_series (
      series_id TEXT NOT NULL,
      obs_date DATE NOT NULL,
      value NUMERIC,
      PRIMARY KEY (series_id, obs_date)
    )
  `);
}

export async function saveDailyBars(pool: Pool, bars: DailyBar[]): Promise<void> {
  for (const bar of bars) {
    await pool.query(
      `INSERT INTO market_bars (symbol, timeframe, ts, open, high, low, close, volume, trade_count, vwap)
       VALUES ($1, '1Day', $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (symbol, timeframe, ts) DO UPDATE SET
         open = EXCLUDED.open,
         high = EXCLUDED.high,
         low = EXCLUDED.low,
         close = EXCLUDED.close,
         volume = EXCLUDED.volume,
         trade_count = EXCLUDED.trade_count,
         vwap = EXCLUDED.vwap`,
      [bar.symbol, bar.timestamp, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.tradeCount, bar.vwap]
    );
  }
}

export async function saveNews(pool: Pool, news: NewsItem[]): Promise<void> {
  for (const item of news) {
    await pool.query(
      `INSERT INTO news_items (id, headline, summary, source, url, symbols, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         headline = EXCLUDED.headline,
         summary = EXCLUDED.summary,
         source = EXCLUDED.source,
         url = EXCLUDED.url,
         symbols = EXCLUDED.symbols,
         published_at = EXCLUDED.published_at`,
      [item.id, item.headline, item.summary, item.source, item.url, item.symbols, item.publishedAt]
    );
  }
}

export async function saveFundamentalsSnapshot(
  pool: Pool,
  symbol: string,
  source: string,
  data: unknown
): Promise<void> {
  await pool.query(
    `INSERT INTO fundamentals_snapshots (symbol, source, data) VALUES ($1, $2, $3)`,
    [symbol, source, JSON.stringify(data)]
  );
}

/** Cierres diarios de un símbolo, en orden ascendente por fecha (los más recientes al final). */
export async function getCloses(pool: Pool, symbol: string, limit: number): Promise<number[]> {
  const result = await pool.query<{ close: string }>(
    `SELECT close FROM market_bars
     WHERE symbol = $1 AND timeframe = '1Day'
     ORDER BY ts DESC
     LIMIT $2`,
    [symbol, limit]
  );

  return result.rows.map((row) => Number(row.close)).reverse();
}

export async function saveMacroObservations(pool: Pool, observations: MacroObservation[]): Promise<void> {
  for (const obs of observations) {
    await pool.query(
      `INSERT INTO macro_series (series_id, obs_date, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (series_id, obs_date) DO UPDATE SET value = EXCLUDED.value`,
      [obs.seriesId, obs.date, obs.value]
    );
  }
}
