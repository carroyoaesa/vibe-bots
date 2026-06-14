import { loadAlpacaConfig } from './config';
import { createAlpacaClient, getMarketClock } from './services/alpaca';
import { runTradingCycle } from './tradingRunner';

/**
 * Wrapper para cron: solo ejecuta el ciclo de trading si el mercado está
 * abierto según el calendario de Alpaca (evita depender de horarios fijos
 * en UTC, que cambian con el horario de verano de EE.UU.).
 */
async function main() {
  const alpacaClient = createAlpacaClient(loadAlpacaConfig());
  const clock = await getMarketClock(alpacaClient);

  if (!clock.isOpen) {
    console.log(`[${new Date().toISOString()}] Mercado cerrado (próxima apertura: ${clock.nextOpen}). Sin acción.`);
    return;
  }

  console.log(`[${new Date().toISOString()}] Mercado abierto (cierra: ${clock.nextClose}). Ejecutando ciclo de trading...`);

  const result = await runTradingCycle();

  console.log(`Cuenta: equity $${result.account.equity.toFixed(2)} | cash $${result.account.cash.toFixed(2)}`);
  result.actions
    .filter((action) => action.type !== 'NO_ACTION')
    .forEach((action) => console.log(`  ${JSON.stringify(action)}`));
}

main().catch((error) => {
  console.error('❌ Error en el ciclo de trading (cron):', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
