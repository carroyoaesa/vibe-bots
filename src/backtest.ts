import { loadPostgresConfig } from './config';
import { createPostgresPool } from './services/db';
import { setupBacktestSchema } from './services/backtestStore';
import { runBacktestForWatchlist } from './backtestRunner';

async function main() {
  console.log('🤖 Vibe Bots - Backtest (Fase 4)\n');

  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupBacktestSchema(pool);
    const result = await runBacktestForWatchlist(pool);

    console.log(`Periodo: ${result.startDate ?? 'n/a'} -> ${result.endDate ?? 'n/a'}\n`);

    console.log('Resumen por símbolo:');
    result.symbolSummaries.forEach((s) => {
      const winRate = s.winRate !== null ? `${s.winRate.toFixed(1)}%` : 'n/a';
      const avg = s.avgReturnPct !== null ? `${s.avgReturnPct.toFixed(2)}%` : 'n/a';
      console.log(
        `  ${s.symbol.padEnd(6)} trades=${s.trades} winRate=${winRate} retorno=${s.totalReturnPct.toFixed(2)}% avg=${avg} maxDD=${s.maxDrawdownPct.toFixed(2)}%`
      );
    });

    const p = result.portfolio;
    console.log('\nPortafolio:');
    console.log(`  Símbolos: ${p.symbols}`);
    console.log(`  Trades totales: ${p.totalTrades}`);
    console.log(`  Retorno promedio: ${p.avgReturnPct !== null ? p.avgReturnPct.toFixed(2) + '%' : 'n/a'}`);
    console.log(`  Win rate promedio: ${p.avgWinRatePct !== null ? p.avgWinRatePct.toFixed(1) + '%' : 'n/a'}`);
    console.log(`  Mejor símbolo: ${p.bestSymbol ?? 'n/a'}`);
    console.log(`  Peor símbolo: ${p.worstSymbol ?? 'n/a'}`);

    console.log(`\nRun guardado con id ${result.runId}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('❌ Error en el backtest:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
