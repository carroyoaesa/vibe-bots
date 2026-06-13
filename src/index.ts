import { createAlpacaClient, loadAlpacaConfig, loadMinioConfig, loadPostgresConfig, loadRedisConfig } from './config';
import axios from 'axios';
import { createPostgresPool, verifyPostgres } from './services/db';
import { createRedisClient, verifyRedis } from './services/cache';
import { createMinioClient, verifyStorage } from './services/storage';

async function verifyServices() {
  try {
    console.log('🚀 Vibe Bots iniciando...\n');

    // Cargar configuración
    const alpacaConfig = loadAlpacaConfig();
    const postgresConfig = loadPostgresConfig();
    const redisConfig = loadRedisConfig();
    const minioConfig = loadMinioConfig();

    console.log(`✅ Configuración cargada`);
    console.log(`   Alpaca: ${alpacaConfig.baseUrl}`);
    console.log(`   PostgreSQL: ${postgresConfig.host}:${postgresConfig.port}/${postgresConfig.db}`);
    console.log(`   Redis: ${redisConfig.url}`);
    console.log(`   MinIO: ${minioConfig.endpoint}`);
    console.log('');

    // Verificar Alpaca
    console.log('═══════════════════════════════════════');
    console.log('📊 VERIFICACIÓN 1: Alpaca');
    console.log('═══════════════════════════════════════\n');
    const alpacaClient = createAlpacaClient();
    const accountResponse = await alpacaClient.get('/v2/account');
    const account = accountResponse.data;
    console.log(`   Cuenta: ${account.account_number}`);
    console.log(`   Estado: ${account.status}`);
    console.log(`   Efectivo: $${parseFloat(account.cash).toFixed(2)}`);
    console.log(`   Poder de compra: $${parseFloat(account.buying_power).toFixed(2)}`);
    console.log(`   Patrimonio neto: $${parseFloat(account.equity).toFixed(2)}\n`);

    // Verificar PostgreSQL
    console.log('═══════════════════════════════════════');
    console.log('🗄️  VERIFICACIÓN 2: PostgreSQL');
    console.log('═══════════════════════════════════════\n');
    const pool = createPostgresPool(postgresConfig);
    const postgresResult = await verifyPostgres(pool);
    console.log(`   PostgreSQL OK: ${JSON.stringify(postgresResult)}`);
    await pool.end();
    console.log('');

    // Verificar Redis
    console.log('═══════════════════════════════════════');
    console.log('🧠 VERIFICACIÓN 3: Redis');
    console.log('═══════════════════════════════════════\n');
    const redisClient = createRedisClient(redisConfig);
    const redisResult = await verifyRedis(redisClient);
    console.log(`   Redis OK: ${JSON.stringify(redisResult)}`);
    console.log('');

    // Verificar MinIO
    console.log('═══════════════════════════════════════');
    console.log('📦 VERIFICACIÓN 4: MinIO');
    console.log('═══════════════════════════════════════\n');
    const minioClient = createMinioClient(minioConfig);
    const minioResult = await verifyStorage(minioClient, minioConfig);
    console.log(`   MinIO OK: ${minioResult}`);
    console.log('');

    console.log('═══════════════════════════════════════');
    console.log('✅ DIAGNÓSTICO COMPLETO');
    console.log('═══════════════════════════════════════\n');
    console.log('El entorno nativo PostgreSQL / Redis / MinIO está listo.');
  } catch (error) {
    if (error instanceof Error) {
      console.error('❌ Error de verificación:', error.message);
    } else {
      console.error('❌ Error desconocido:', error);
    }
    process.exit(1);
  }
}

verifyServices();
