import { Pool } from 'pg';
import { DailyBar, NewsItem } from './marketData';
import { MacroObservation } from './fred';
import { CompanyProfile } from './fmp';

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
  return saveBars(pool, bars, '1Day');
}

/** Igual que `saveDailyBars` pero `timeframe='1Hour'` (Fase híbrido, `strategy/hybridConfig.ts`). */
export async function saveHourlyBars(pool: Pool, bars: DailyBar[]): Promise<void> {
  return saveBars(pool, bars, '1Hour');
}

async function saveBars(pool: Pool, bars: DailyBar[], timeframe: '1Day' | '1Hour'): Promise<void> {
  for (const bar of bars) {
    await pool.query(
      `INSERT INTO market_bars (symbol, timeframe, ts, open, high, low, close, volume, trade_count, vwap)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (symbol, timeframe, ts) DO UPDATE SET
         open = EXCLUDED.open,
         high = EXCLUDED.high,
         low = EXCLUDED.low,
         close = EXCLUDED.close,
         volume = EXCLUDED.volume,
         trade_count = EXCLUDED.trade_count,
         vwap = EXCLUDED.vwap`,
      [bar.symbol, timeframe, bar.timestamp, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.tradeCount, bar.vwap]
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

export interface RecentBar {
  ts: string;
  close: number;
}

/** Bars diarias (fecha + cierre) de un símbolo, en orden ascendente por fecha. */
export async function getRecentBars(pool: Pool, symbol: string, limit: number): Promise<RecentBar[]> {
  const result = await pool.query<{ ts: string; close: string }>(
    `SELECT ts, close FROM market_bars
     WHERE symbol = $1 AND timeframe = '1Day'
     ORDER BY ts DESC
     LIMIT $2`,
    [symbol, limit]
  );

  return result.rows.map((row) => ({ ts: row.ts, close: Number(row.close) })).reverse();
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

/** Último perfil fundamental (FMP) guardado para un símbolo, o `null` si no hay ninguno. */
export async function getLatestFundamentals(pool: Pool, symbol: string): Promise<CompanyProfile | null> {
  const result = await pool.query<{ data: CompanyProfile }>(
    `SELECT data FROM fundamentals_snapshots
     WHERE symbol = $1 AND source = 'fmp'
     ORDER BY fetched_at DESC
     LIMIT 1`,
    [symbol]
  );

  if (result.rows.length === 0) return null;
  return result.rows[0].data;
}

/** Noticias más recientes que mencionan a `symbol`, ordenadas por fecha de publicación descendente. */
export async function getRecentNewsForSymbol(pool: Pool, symbol: string, limit: number): Promise<NewsItem[]> {
  const result = await pool.query(
    `SELECT id, headline, summary, source, url, symbols, published_at
     FROM news_items
     WHERE $1 = ANY(symbols)
     ORDER BY published_at DESC
     LIMIT $2`,
    [symbol, limit]
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    headline: row.headline,
    summary: row.summary,
    source: row.source,
    url: row.url,
    symbols: row.symbols,
    publishedAt: new Date(row.published_at).toISOString(),
  }));
}

/** Última observación guardada por cada serie macro solicitada. */
export async function getLatestMacroObservations(pool: Pool, seriesIds: string[]): Promise<MacroObservation[]> {
  const result = await pool.query(
    `SELECT DISTINCT ON (series_id) series_id, obs_date, value
     FROM macro_series
     WHERE series_id = ANY($1)
     ORDER BY series_id, obs_date DESC`,
    [seriesIds]
  );

  return result.rows.map((row) => ({
    seriesId: row.series_id,
    date: new Date(row.obs_date).toISOString().slice(0, 10),
    value: row.value !== null ? Number(row.value) : null,
  }));
}

export interface OhlcBar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Historial completo de velas diarias (OHLC) de un símbolo, en orden ascendente por fecha. */
export async function getAllBars(pool: Pool, symbol: string): Promise<OhlcBar[]> {
  const result = await pool.query(
    `SELECT ts, open, high, low, close FROM market_bars
     WHERE symbol = $1 AND timeframe = '1Day'
     ORDER BY ts ASC`,
    [symbol]
  );

  return result.rows.map((row) => ({
    ts: new Date(row.ts).toISOString(),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
  }));
}

/** Últimas `limit` velas diarias (OHLC) de un símbolo, en orden ascendente por fecha (Fase 6, multi-condicional). */
export async function getRecentOhlcBars(pool: Pool, symbol: string, limit: number): Promise<OhlcBar[]> {
  return getRecentOhlcBarsByTimeframe(pool, symbol, '1Day', limit);
}

/** Igual que `getRecentOhlcBars` pero `timeframe='1Hour'` (Fase híbrido, `strategy/hybridConfig.ts`). */
export async function getRecentOhlcBars1H(pool: Pool, symbol: string, limit: number): Promise<OhlcBar[]> {
  return getRecentOhlcBarsByTimeframe(pool, symbol, '1Hour', limit);
}

async function getRecentOhlcBarsByTimeframe(pool: Pool, symbol: string, timeframe: '1Day' | '1Hour', limit: number): Promise<OhlcBar[]> {
  const result = await pool.query(
    `SELECT ts, open, high, low, close FROM market_bars
     WHERE symbol = $1 AND timeframe = $2
     ORDER BY ts DESC
     LIMIT $3`,
    [symbol, timeframe, limit]
  );

  return result.rows
    .map((row) => ({
      ts: new Date(row.ts).toISOString(),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
    }))
    .reverse();
}
