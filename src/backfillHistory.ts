import { loadAlpacaConfig, loadPostgresConfig } from './config';
import { createPostgresPool } from './services/db';
import { createMarketDataClient, getDailyBars } from './services/marketData';
import { setupIngestSchema, saveDailyBars } from './services/marketStore';
import { WATCHLIST } from './watchlist';

// ~3 años de historial, para tener suficientes operaciones en el backtest (más allá
// de los ~220 días que mantiene la ingesta diaria normal para SMA30+RSI14).
const BACKFILL_DAYS = 1095;

async function main() {
  console.log(`🤖 Vibe Bots - Backfill histórico (${BACKFILL_DAYS} días, ${WATCHLIST.length} símbolos)\n`);

  const client = createMarketDataClient(loadAlpacaConfig());
  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupIngestSchema(pool);

    const bars = await getDailyBars(client, WATCHLIST, BACKFILL_DAYS);
    await saveDailyBars(pool, bars);

    console.log(`Guardadas/actualizadas ${bars.length} velas diarias.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('❌ Error en el backfill histórico:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
