import { loadEmailAlertConfig } from './config';
import { sendTradeAlertEmail, TradeAlertEntry } from './services/email';
import { OhlcBar } from './strategy/conditions';
import { SignalResult } from './strategy/signals';

function buildFakeBars(): OhlcBar[] {
  const bars: OhlcBar[] = [];
  let price = 100;
  const start = new Date('2026-03-01T00:00:00Z').getTime();
  for (let i = 0; i < 80; i++) {
    price += (Math.random() - 0.45) * 2;
    const open = price;
    const close = price + (Math.random() - 0.5) * 1.5;
    const high = Math.max(open, close) + Math.random();
    const low = Math.min(open, close) - Math.random();
    bars.push({
      ts: new Date(start + i * 24 * 60 * 60 * 1000).toISOString(),
      open,
      high,
      low,
      close,
    });
    price = close;
  }
  return bars;
}

function buildFakeSignal(bars: OhlcBar[]): SignalResult {
  const last = bars[bars.length - 1];
  return {
    symbol: 'TEST',
    price: last.close,
    smaFast: last.close * 0.99,
    smaSlow: last.close * 0.97,
    rsi: 62.5,
    momentum: 1.8,
    estimatedEntryPrice: last.close * 0.995,
    estimatedExitPrice: last.close * 1.06,
    signal: 'BUY',
    reason: 'BUY por "Cruce SMA10/SMA30 + RSI<70 + Momentum>0" (SMA10=101.20 SMA30=99.40 RSI=62.5 Momentum=1.8) - email de prueba',
    buyConditionId: 'sma_cross_10_30',
    buyConditionLabel: 'Cruce SMA10/SMA30 + RSI<70 + Momentum>0',
    sellConditionId: 'sma_cross_10_30',
    sellConditionLabel: 'Cruce SMA10/SMA30 + RSI<70 + Momentum>0',
  };
}

async function main() {
  const config = loadEmailAlertConfig();
  if (!config) {
    console.error('Falta configurar SMTP_HOST/SMTP_USER/SMTP_PASSWORD/ALERT_EMAIL_TO en secure/keys.env (ver .env.example).');
    process.exitCode = 1;
    return;
  }

  const bars = buildFakeBars();
  const signal = buildFakeSignal(bars);

  const entry: TradeAlertEntry = {
    type: 'BUY',
    symbol: 'TEST',
    qty: 1,
    price: signal.estimatedEntryPrice ?? signal.price,
    orderId: 'test-1234',
    accountGroup: 'aptos',
    signal,
    bars,
    ai: {
      recommendation: 'buy',
      score: 0.62,
      confidence: 0.8,
      rationale: 'Email de prueba: motivo de IA simulado para verificar el formato enriquecido.',
    },
  };

  await sendTradeAlertEmail(config, [entry]);
  console.log(`✅ Email de prueba enviado a ${config.to}`);
}

main().catch((error) => {
  console.error('❌ Error enviando el email de prueba:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
