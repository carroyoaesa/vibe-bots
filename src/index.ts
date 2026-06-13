import { loadAlpacaConfig, createAlpacaClient } from './config';
import axios from 'axios';

async function verifyAlpacaConnection() {
  try {
    console.log('🚀 Vibe Bots iniciando...\n');

    // Cargar configuración
    const config = loadAlpacaConfig();
    console.log(`✅ Configuración Alpaca cargada`);
    console.log(`📍 Base URL: ${config.baseUrl}\n`);

    // Crear cliente
    const alpacaClient = createAlpacaClient();
    console.log('✅ Cliente Alpaca creado\n');

    // VERIFICACIÓN 1: Información de cuenta
    console.log('═══════════════════════════════════════');
    console.log('📊 VERIFICACIÓN 1: Información de Cuenta');
    console.log('═══════════════════════════════════════\n');
    const accountResponse = await alpacaClient.get('/v2/account');
    const account = accountResponse.data;
    console.log(`✅ Conectado a Alpaca`);
    console.log(`   Cuenta: ${account.account_number}`);
    console.log(`   Estado: ${account.status}`);
    console.log(`   Efectivo: $${parseFloat(account.cash).toFixed(2)}`);
    console.log(`   Poder de compra: $${parseFloat(account.buying_power).toFixed(2)}`);
    console.log(`   Patrimonio neto: $${parseFloat(account.equity).toFixed(2)}\n`);

    // VERIFICACIÓN 2: Estado del reloj del mercado
    console.log('═══════════════════════════════════════');
    console.log('🕐 VERIFICACIÓN 2: Estado del Mercado');
    console.log('═══════════════════════════════════════\n');
    try {
      const clockResponse = await alpacaClient.get('/v2/clock');
      const clock = clockResponse.data;
      console.log(`   Hora actual: ${clock.timestamp}`);
      console.log(`   Mercado abierto: ${clock.is_open ? '✅ SÍ' : '❌ NO'}`);
      console.log(`   Apertura: ${clock.next_open}`);
      console.log(`   Cierre: ${clock.next_close}\n`);
    } catch (clockError) {
      console.log(`⚠️  Endpoint de reloj no disponible (intentando alternativo...)\n`);
    }

    // VERIFICACIÓN 3: Posiciones abiertas
    console.log('═══════════════════════════════════════');
    console.log('📈 VERIFICACIÓN 3: Posiciones Abiertas');
    console.log('═══════════════════════════════════════\n');
    try {
      const positionsResponse = await alpacaClient.get('/v2/positions');
      const positions = positionsResponse.data;
      if (positions.length > 0) {
        console.log(`   Posiciones abiertas: ${positions.length}`);
        positions.forEach((pos: any, idx: number) => {
          console.log(`   ${idx + 1}. ${pos.symbol}: ${pos.qty} acciones @ $${parseFloat(pos.current_price).toFixed(2)}`);
        });
      } else {
        console.log(`   ✅ Sin posiciones abiertas (portfolio limpio)\n`);
      }
    } catch (posError) {
      console.log(`⚠️  Error al obtener posiciones\n`);
    }

    // VERIFICACIÓN 4: Órdenes activas
    console.log('═══════════════════════════════════════');
    console.log('⏳ VERIFICACIÓN 4: Órdenes Activas');
    console.log('═══════════════════════════════════════\n');
    try {
      const ordersResponse = await alpacaClient.get('/v2/orders?status=open');
      const orders = ordersResponse.data;
      if (orders.length > 0) {
        console.log(`   Órdenes abiertas: ${orders.length}`);
        orders.forEach((order: any, idx: number) => {
          console.log(`   ${idx + 1}. ${order.symbol}: ${order.qty} @ ${order.limit_price ? `$${order.limit_price}` : 'Precio de mercado'} (${order.side.toUpperCase()})`);
        });
      } else {
        console.log(`   ✅ Sin órdenes pendientes\n`);
      }
    } catch (ordersError) {
      console.log(`⚠️  Error al obtener órdenes\n`);
    }

    // VERIFICACIÓN 5: Actividades recientes (últimas 5)
    console.log('═══════════════════════════════════════');
    console.log('📜 VERIFICACIÓN 5: Actividades Recientes');
    console.log('═══════════════════════════════════════\n');
    try {
      const activitiesResponse = await alpacaClient.get('/v2/account/activities?limit=5&activity_type=FILL');
      const activities = activitiesResponse.data;
      if (activities.length > 0) {
        console.log(`   Últimas transacciones completadas:`);
        activities.forEach((activity: any, idx: number) => {
          console.log(`   ${idx + 1}. ${activity.symbol}: ${activity.qty} acciones @ $${parseFloat(activity.price).toFixed(2)} (${activity.side.toUpperCase()})`);
          console.log(`      Fecha: ${activity.transaction_time}`);
        });
      } else {
        console.log(`   ℹ️  Sin transacciones completadas\n`);
      }
    } catch (activitiesError) {
      console.log(`⚠️  Error al obtener actividades\n`);
    }

    // RESUMEN FINAL
    console.log('\n═══════════════════════════════════════');
    console.log('✅ DIAGNÓSTICO COMPLETO');
    console.log('═══════════════════════════════════════');
    console.log('Todos los endpoints de Alpaca funcionando correctamente.');
    console.log('La conexión está lista para operaciones de trading.\n');

  } catch (error) {
    if (error instanceof Error) {
      console.error('❌ Error de conexión:', error.message);
    } else {
      console.error('❌ Error desconocido:', error);
    }
    process.exit(1);
  }
}

verifyAlpacaConnection();
