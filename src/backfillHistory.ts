import { loadAlpacaConfig, loadPostgresConfig } from './config';
import { createPostgresPool } from './services/db';
import { createMarketDataClient, getDailyBars } from './services/marketData';
import { setupIngestSchema, saveDailyBars } from './services/marketStore';
import { WATCHLIST } from './watchlist';

// 5.8 años de historial (límite real de Alpaca IEX free, verificado 2026-06-16).
// Suficiente para 10-25 operaciones por símbolo en el combo-matrix de 144 condiciones.
const BACKFILL_DAYS = 2100;

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
