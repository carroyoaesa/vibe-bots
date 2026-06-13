import { loadAlpacaConfig, createAlpacaClient } from './config';
import axios from 'axios';

async function main() {
  try {
    console.log('🚀 Vibe Bots iniciando...\n');

    // Cargar configuración
    const config = loadAlpacaConfig();
    console.log(`✅ Configuración Alpaca cargada`);
    console.log(`📍 Base URL: ${config.baseUrl}\n`);

    // Crear cliente
    const alpacaClient = createAlpacaClient();
    console.log('✅ Cliente Alpaca creado\n');

    // Obtener información de cuenta
    console.log('📊 Obteniendo información de cuenta...');
    const accountResponse = await alpacaClient.get('/v2/account');
    const account = accountResponse.data;
    console.log(`✅ Conectado a Alpaca`);
    console.log(`   Cuenta: ${account.account_number}`);
    console.log(`   Estado: ${account.status}`);
    console.log(`   Efectivo: $${parseFloat(account.cash).toFixed(2)}\n`);

    // Obtener precio de un ETF usando Data API
    const etfSymbol = 'SPY';
    console.log(`💰 Obteniendo precio de ${etfSymbol}...\n`);

    try {
      // Usar Data API de Alpaca
      const dataClient = axios.create({
        baseURL: 'https://data.alpaca.markets',
        headers: {
          'APCA-API-KEY-ID': config.apiKey,
        },
      });

      const latestQuoteResponse = await dataClient.get(`/v1beta2/stocks/${etfSymbol}/quotes/latest`);
      const quote = latestQuoteResponse.data.quote;

      console.log(`📈 ${etfSymbol} - Última cotización:`);
      console.log(`   Precio de Compra: $${quote.ap}`);
      console.log(`   Precio de Venta: $${quote.bp}`);
      console.log(`   Precio Medio: $${((quote.ap + quote.bp) / 2).toFixed(2)}`);
      console.log(`   Tiempo: ${quote.t}\n`);
    } catch (dataError) {
      console.log(`ℹ️  Datos de mercado en tiempo real no disponibles\n`);
      console.log(`   Nota: Se requiere suscripción a datos de mercado en Alpaca\n`);
    }

    console.log('✅ Verificación completada exitosamente');
  } catch (error) {
    if (error instanceof Error) {
      console.error('❌ Error:', error.message);
    } else {
      console.error('❌ Error desconocido:', error);
    }
    process.exit(1);
  }
}

main();
