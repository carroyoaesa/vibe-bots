import { runTradingCycle } from './tradingRunner';

function describeAction(action: Awaited<ReturnType<typeof runTradingCycle>>['actions'][number]): string {
  switch (action.type) {
    case 'OPEN_POSITION': {
      const tpsl = action.takeProfitPrice !== null && action.stopLossPrice !== null
        ? `TP $${action.takeProfitPrice.toFixed(2)} / SL $${action.stopLossPrice.toFixed(2)}`
        : 'sin bracket TP/SL';
      return `🟢 BUY ${action.symbol}: ${action.qty} acciones (${tpsl}) - orden ${action.alpacaOrderId}`;
    }
    case 'CLOSE_POSITION':
      return `🔴 SELL ${action.symbol}: cierre de ${action.qty} acciones - orden ${action.alpacaOrderId ?? 'n/a'}`;
    case 'OPEN_PARALLEL_POSITION':
      return `🟢 BUY ${action.symbol} (paralelo): ${action.qty} acciones - orden ${action.alpacaOrderId}`;
    case 'CLOSE_PARALLEL_POSITION':
      return `🔴 SELL ${action.symbol} (paralelo): cierre de ${action.qty} acciones - orden ${action.alpacaOrderId ?? 'n/a'}`;
    case 'AI_BLOCKED':
      return `🤖🚫 ${action.symbol}: BUY vetado por IA (${action.reason})`;
    case 'TRADING_DISABLED':
      return `⏸️  ${action.symbol}${action.system === 'parallel' ? ' (paralelo)' : ''}: trading desactivado (interruptor ON/OFF)`;
    case 'SKIPPED':
      return `⏭️  ${action.symbol}${action.system === 'parallel' ? ' (paralelo)' : ''}: omitido (${action.reason})`;
    case 'ERROR':
      return `❌ ${action.symbol}${action.system && action.system !== 'main' ? ` (${action.system})` : ''}: error (${action.error})`;
    case 'NO_ACTION':
    default:
      return `⚪ ${action.symbol}${action.system && action.system !== 'main' ? ` (${action.system})` : ''}: sin acción (${action.reason})`;
  }
}

async function main() {
  console.log('🤖 Vibe Bots - Ciclo de trading (Fase 2, paper)\n');

  const result = await runTradingCycle();

  console.log(`Cuenta: equity $${result.account.equity.toFixed(2)} | cash $${result.account.cash.toFixed(2)} | buying power $${result.account.buyingPower.toFixed(2)}\n`);

  console.log('Señales:');
  result.signals.forEach((signal) => {
    const sma = signal.smaFast !== null && signal.smaSlow !== null
      ? `SMA10=${signal.smaFast.toFixed(2)} SMA30=${signal.smaSlow.toFixed(2)}`
      : 'SMA n/a';
    console.log(`  ${signal.symbol}: ${signal.signal} ($${signal.price.toFixed(2)}, ${sma}) - ${signal.reason}`);
  });

  if (result.hybridSignals.length > 0) {
    console.log('\nSeñales híbridas (1H, paralelo/sombra):');
    result.hybridSignals.forEach(({ symbol, system, signal }) => {
      console.log(`  ${symbol} (${system}): ${signal.signal} ($${signal.price.toFixed(2)}) - ${signal.reason}`);
    });
  }

  console.log('\nAcciones:');
  result.actions.forEach((action) => console.log(`  ${describeAction(action)}`));
}

main().catch((error) => {
  console.error('❌ Error en el ciclo de trading:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
