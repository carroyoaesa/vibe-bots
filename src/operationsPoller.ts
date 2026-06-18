import { Pool } from 'pg';
import { syncAllAccounts } from './services/operationsSync';

export const POLLER_INTERVAL_SECONDS = 60;

/** Igual ventana que el cron de trading (`0 13-21 * * 1-5`, ver CLAUDE.md "Automatización") - evita pedirle a Alpaca fuera de horario. */
function isMarketHoursUtc(now = new Date()): boolean {
  const day = now.getUTCDay(); // 0=domingo, 6=sábado
  const hour = now.getUTCHours();
  return day >= 1 && day <= 5 && hour >= 13 && hour <= 21;
}

/**
 * Poller de sincronización multi-cuenta (Fase Operaciones, 2026-06-18): corre cada 60s
 * mientras el dashboard esté arriba, independiente del ciclo de trading por cron. Solo
 * sincroniza en horario de mercado (gate local, sin pedirle el clock a Alpaca) - 3 grupos x
 * 4 llamadas (account/positions/open orders/closed orders) cada 60s = 12 req/min, bien por
 * debajo del límite de 200 req/min de Alpaca paper y del target de <30 req/min pedido.
 * Nunca lanza al loop principal - `syncAllAccounts` ya atrapa errores por grupo.
 */
export function startOperationsPoller(pool: Pool): NodeJS.Timeout {
  const tick = async () => {
    if (!isMarketHoursUtc()) return;

    try {
      const results = await syncAllAccounts(pool, 'poller');
      const summary = Object.values(results)
        .map((r) => (r.skipped ? `${r.group}=sin-credenciales` : r.error ? `${r.group}=ERROR(${r.error})` : `${r.group}=ok(${r.positionsCount}pos/${r.pendingOrdersCount}ord)`))
        .join(' ');
      console.log(`[operationsPoller] sync: ${summary}`);
    } catch (error) {
      console.error('[operationsPoller] Error inesperado en el poller (no debería pasar, syncAllAccounts atrapa por grupo):', error);
    }
  };

  void tick();
  return setInterval(tick, POLLER_INTERVAL_SECONDS * 1000);
}
