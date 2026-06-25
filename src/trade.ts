import { runTradingCycle } from './tradingRunner';

function describeAction(action: Awaited<ReturnType<typeof runTradingCycle>>['actions'][number]): string {
  switch (action.type) {
    case 'OPEN_POSITION': {
      const tpsl = action.takeProfitPrice !== null && action.stopLossPrice !== null
        ? `TP $${action.takeProfitPrice.toFixed(2)} / SL $${action.stopLossPrice.toFixed(2)}`
        : 'sin bracket TP/SL';
      return `🟢 BUY ${action.symbol} (cuenta: ${action.accountGroup}): ${action.qty} acciones (${tpsl}) - orden ${action.alpacaOrderId}`;
    }
    case 'CLOSE_POSITION':
      return `🔴 SELL ${action.symbol} (cuenta: ${action.accountGroup}): cierre de ${action.qty} acciones - orden ${action.alpacaOrderId ?? 'n/a'}`;
    case 'AI_BLOCKED':
      return `🤖🚫 ${action.symbol}: BUY vetado por IA (${action.reason})`;
    case 'AI_BLOCKED_SELL':
      return `🤖🚫 ${action.symbol}: SELL vetado por IA, posición se mantiene abierta (${action.reason})`;
    case 'TRADING_DISABLED':
      return `⏸️  ${action.symbol}: trading desactivado (interruptor ON/OFF)`;
    case 'SKIPPED':
      return `⏭️  ${action.symbol}: omitido (${action.reason})`;
    case 'ERROR':
      return `❌ ${action.symbol}: error (${action.error})`;
    case 'NO_ACTION':
    default:
      return `⚪ ${action.symbol}: sin acción (${action.reason})`;
  }
}

async function main() {
  console.log('🤖 Vibe Bots - Ciclo de trading (Fase 2, paper)\n');

  const result = await runTradingCycle();

  for (const [group, account] of Object.entries(result.accountsByGroup)) {
    if (!account) {
      console.log(`Cuenta ${group}: sin credenciales configuradas`);
      continue;
    }
    console.log(`Cuenta ${group}: equity $${account.equity.toFixed(2)} | cash $${account.cash.toFixed(2)} | buying power $${account.buyingPower.toFixed(2)}`);
  }
  console.log('');

  console.log('Señales:');
  result.signals.forEach((signal) => {
    const sma = signal.smaFast !== null && signal.smaSlow !== null
      ? `SMA10=${signal.smaFast.toFixed(2)} SMA30=${signal.smaSlow.toFixed(2)}`
      : 'SMA n/a';
    console.log(`  ${signal.symbol}: ${signal.signal} ($${signal.price.toFixed(2)}, ${sma}) - ${signal.reason}`);
  });

  console.log('\nAcciones:');
  result.actions.forEach((action) => console.log(`  ${describeAction(action)}`));
}

main().catch((error) => {
  console.error('❌ Error en el ciclo de trading:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
