import { loadAlpacaConfig, loadMinioConfig, loadPostgresConfig, loadRedisConfig } from './config';
import { createAlpacaClient, verifyAlpaca } from './services/alpaca';
import { createPostgresPool, verifyPostgres } from './services/db';
import { createRedisClient, verifyRedis } from './services/cache';
import { createMinioClient, verifyStorage } from './services/storage';
import { runCheck } from './check-runner';

async function main() {
  console.log('🚀 Vibe Bots iniciando...\n');

  const alpacaConfig = loadAlpacaConfig();
  const postgresConfig = loadPostgresConfig();
  const redisConfig = loadRedisConfig();
  const minioConfig = loadMinioConfig();

  console.log('✅ Configuración cargada');
  console.log(`   Alpaca: ${alpacaConfig.baseUrl}`);
  console.log(`   PostgreSQL: ${postgresConfig.host}:${postgresConfig.port}/${postgresConfig.db}`);
  console.log(`   Redis: ${redisConfig.url}`);
  console.log(`   MinIO: ${minioConfig.endpoint}\n`);

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
