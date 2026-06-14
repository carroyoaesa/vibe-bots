import { runIngest } from './ingestRunner';

async function main() {
  console.log('📥 Vibe Bots - Ingesta de datos (Fase 1)\n');

  const summary = await runIngest();

  console.log('✅ Esquema de ingesta verificado (market_bars, news_items, fundamentals_snapshots, macro_series)\n');
  console.log(`📊 Bars guardadas: ${summary.bars} (watchlist: ${summary.watchlist.join(', ')})`);
  console.log(`📰 Noticias guardadas: ${summary.news}`);
  console.log(`🏢 Snapshots de fundamentales guardados: ${summary.fundamentals}`);
  console.log(`🏛️  Observaciones macro guardadas: ${summary.macroObservations} (series: ${summary.macroSeries.join(', ')})`);
  console.log(`📡 Quotes cacheados en Redis: ${summary.quotes} (TTL ${summary.quoteCacheTtlSeconds}s)\n`);
  console.log('✅ Ingesta completada con éxito');
}

main().catch((error) => {
  console.error('❌ Error en la ingesta:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
