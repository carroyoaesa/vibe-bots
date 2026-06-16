import { loadAlpacaConfig, loadPostgresConfig } from './config';
import { createPostgresPool } from './services/db';
import { createMarketDataClient, getHourlyBars } from './services/marketData';
import { setupIngestSchema, saveHourlyBars } from './services/marketStore';
import { HYBRID_SYMBOLS } from './strategy/hybridConfig';

// Mismo horizonte que el backfill 1D (`backfillHistory.ts`): ~3 años.
// Los 5 símbolos híbridos solo tenían ~6.5 meses de velas 1H, haciendo que el
// backtest 1H cubriera un período demasiado corto respecto al backtest 1D.
const BACKFILL_DAYS = 1095;

async function main() {
  console.log(`🤖 Vibe Bots - Backfill histórico 1H (${BACKFILL_DAYS} días, ${HYBRID_SYMBOLS.length} símbolos híbridos: ${HYBRID_SYMBOLS.join(', ')})\n`);

  const client = createMarketDataClient(loadAlpacaConfig());
  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupIngestSchema(pool);

    const bars = await getHourlyBars(client, HYBRID_SYMBOLS, BACKFILL_DAYS);
    await saveHourlyBars(pool, bars);

    console.log(`Guardadas/actualizadas ${bars.length} velas 1H.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('❌ Error en el backfill histórico 1H:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
