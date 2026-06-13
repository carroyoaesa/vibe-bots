import {
  loadAlpacaConfig,
  loadMinioConfig,
  loadPostgresConfig,
  loadRedisConfig,
  loadFmpConfig,
  loadFinnhubConfig,
  loadAlphaVantageConfig,
  loadFredConfig,
} from './config';
import { createAlpacaClient, verifyAlpaca } from './services/alpaca';
import { createPostgresPool, verifyPostgres } from './services/db';
import { createRedisClient, verifyRedis } from './services/cache';
import { createMinioClient, verifyStorage } from './services/storage';
import { createMarketDataClient, verifyMarketData } from './services/marketData';
import { createFmpClient, verifyFmp } from './services/fmp';
import { createFinnhubClient, verifyFinnhub } from './services/finnhub';
import { createAlphaVantageClient, verifyAlphaVantage } from './services/alphaVantage';
import { createFredClient, verifyFred } from './services/fred';
import { runCheck } from './check-runner';

async function main() {
  console.log('🚀 Vibe Bots iniciando...\n');

  const alpacaConfig = loadAlpacaConfig();
  const postgresConfig = loadPostgresConfig();
  const redisConfig = loadRedisConfig();
  const minioConfig = loadMinioConfig();
  const fmpConfig = loadFmpConfig();
  const finnhubConfig = loadFinnhubConfig();
  const alphaVantageConfig = loadAlphaVantageConfig();
  const fredConfig = loadFredConfig();

  console.log('✅ Configuración cargada');
  console.log(`   Alpaca: ${alpacaConfig.baseUrl}`);
  console.log(`   PostgreSQL: ${postgresConfig.host}:${postgresConfig.port}/${postgresConfig.db}`);
  console.log(`   Redis: ${redisConfig.url}`);
  console.log(`   MinIO: ${minioConfig.endpoint}`);
  console.log(`   FMP, Finnhub, Alpha Vantage y FRED: API keys cargadas\n`);

  const results = [];

  results.push(
    await runCheck('VERIFICACIÓN 1: Alpaca', '📊', async () => {
      const client = createAlpacaClient(alpacaConfig);
      return verifyAlpaca(client);
    }, (account) => {
      console.log(`   Cuenta: ${account.accountNumber}`);
      console.log(`   Estado: ${account.status}`);
      console.log(`   Efectivo: $${account.cash.toFixed(2)}`);
      console.log(`   Poder de compra: $${account.buyingPower.toFixed(2)}`);
      console.log(`   Patrimonio neto: $${account.equity.toFixed(2)}\n`);
    })
  );

  results.push(
    await runCheck('VERIFICACIÓN 2: PostgreSQL', '🗄️', async () => {
      const pool = createPostgresPool(postgresConfig);
      try {
        return await verifyPostgres(pool);
      } finally {
        await pool.end();
      }
    }, (result) => {
      console.log(`   PostgreSQL OK: ${JSON.stringify(result)}\n`);
    })
  );

  results.push(
    await runCheck('VERIFICACIÓN 3: Redis', '🧠', async () => {
      const client = createRedisClient(redisConfig);
      return verifyRedis(client);
    }, (result) => {
      console.log(`   Redis OK: ${JSON.stringify(result)}\n`);
    })
  );

  results.push(
    await runCheck('VERIFICACIÓN 4: MinIO', '📦', async () => {
      const client = createMinioClient(minioConfig);
      return verifyStorage(client, minioConfig);
    }, (result) => {
      console.log(`   MinIO OK: ${result}\n`);
    })
  );

  results.push(
    await runCheck('VERIFICACIÓN 5: Alpaca Market Data', '📈', async () => {
      const client = createMarketDataClient(alpacaConfig);
      return verifyMarketData(client);
    }, (result) => {
      console.log(`   Bars (AAPL, 5 días): ${result.bars}`);
      console.log(`   Noticias (AAPL): ${result.news}\n`);
    })
  );

  results.push(
    await runCheck('VERIFICACIÓN 6: Financial Modeling Prep', '🏢', async () => {
      const client = createFmpClient(fmpConfig);
      return verifyFmp(client);
    }, (profile) => {
      console.log(`   ${profile.symbol}: ${profile.companyName} (${profile.sector ?? 'sin sector'})`);
      console.log(`   Market cap: $${profile.marketCap.toLocaleString()}\n`);
    })
  );

  results.push(
    await runCheck('VERIFICACIÓN 7: Finnhub', '📡', async () => {
      const client = createFinnhubClient(finnhubConfig);
      return verifyFinnhub(client);
    }, (quote) => {
      console.log(`   ${quote.symbol} precio actual: $${quote.current}`);
      console.log(`   Cierre anterior: $${quote.previousClose}\n`);
    })
  );

  results.push(
    await runCheck('VERIFICACIÓN 8: Alpha Vantage', '📉', async () => {
      const client = createAlphaVantageClient(alphaVantageConfig);
      return verifyAlphaVantage(client);
    }, (quote) => {
      console.log(`   ${quote.symbol} precio: $${quote.price} (${quote.changePercent})\n`);
    })
  );

  results.push(
    await runCheck('VERIFICACIÓN 9: FRED', '🏛️', async () => {
      const client = createFredClient(fredConfig);
      return verifyFred(client);
    }, (observations) => {
      const [latest] = observations;
      console.log(`   FEDFUNDS (${latest.date}): ${latest.value}\n`);
    })
  );

  const allOk = results.every((r) => r.ok);

  console.log('═══════════════════════════════════════');
  console.log(allOk ? '✅ DIAGNÓSTICO COMPLETO' : '⚠️  DIAGNÓSTICO CON ERRORES');
  console.log('═══════════════════════════════════════\n');
  results.forEach((r) => console.log(`   ${r.ok ? '✅' : '❌'} ${r.name}`));

  if (!allOk) {
    process.exitCode = 1;
  }
}

main();
