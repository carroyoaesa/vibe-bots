import { loadAlpacaConfig, loadMinioConfig, loadPostgresConfig, loadRedisConfig } from './config';
import { runDiagnostics, DiagnosticResult } from './diagnostics';

const SEPARATOR = '═══════════════════════════════════════';

function printResult(index: number, result: DiagnosticResult) {
  console.log(SEPARATOR);
  console.log(`${result.emoji} VERIFICACIÓN ${index + 1}: ${result.name}`);
  console.log(`${SEPARATOR}\n`);

  if (result.ok) {
    result.summary.forEach((line) => console.log(`   ${line}`));
    console.log('');
  } else {
    console.log(`❌ Error: ${result.error}\n`);
  }
}

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
  console.log(`   MinIO: ${minioConfig.endpoint}`);
  console.log(`   FMP, Finnhub, Alpha Vantage y FRED: API keys cargadas\n`);

  const results = await runDiagnostics();
  results.forEach((result, index) => printResult(index, result));

  const allOk = results.every((r) => r.ok);

  console.log(SEPARATOR);
  console.log(allOk ? '✅ DIAGNÓSTICO COMPLETO' : '⚠️  DIAGNÓSTICO CON ERRORES');
  console.log(`${SEPARATOR}\n`);
  results.forEach((r) => console.log(`   ${r.ok ? '✅' : '❌'} ${r.name}`));

  if (!allOk) {
    process.exitCode = 1;
  }
}

main();
