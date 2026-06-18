import { Pool, PoolClient } from 'pg';
import {
  AccountGroup,
  ACCOUNT_GROUPS,
  AlpacaAccountSummary,
  AlpacaOrder,
  AlpacaPosition,
  getAccount,
  getAlpacaClient,
  getClosedOrders,
  getOpenOrders,
  getPositions,
  withAlpacaBackoff,
} from './alpaca';

const EXECUTED_ORDERS_PER_SYNC = 30;

export async function setupOperationsSyncSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_state (
      account_group TEXT PRIMARY KEY,
      equity NUMERIC,
      cash NUMERIC,
      buying_power NUMERIC,
      positions_count INTEGER,
      pending_orders_count INTEGER,
      last_sync_at TIMESTAMPTZ,
      last_sync_ok BOOLEAN NOT NULL DEFAULT TRUE,
      last_error TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS positions_snapshot (
      account_group TEXT NOT NULL,
      symbol TEXT NOT NULL,
      qty NUMERIC NOT NULL,
      avg_entry_price NUMERIC,
      current_price NUMERIC,
      market_value NUMERIC,
      unrealized_pl NUMERIC,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (account_group, symbol)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_orders_snapshot (
      account_group TEXT NOT NULL,
      alpaca_order_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      qty NUMERIC NOT NULL,
      order_type TEXT,
      limit_price NUMERIC,
      status TEXT NOT NULL,
      submitted_at TIMESTAMPTZ,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (account_group, alpaca_order_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS executed_orders_snapshot (
      account_group TEXT NOT NULL,
      alpaca_order_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      qty NUMERIC NOT NULL,
      order_type TEXT,
      limit_price NUMERIC,
      status TEXT NOT NULL,
      submitted_at TIMESTAMPTZ,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (account_group, alpaca_order_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_discrepancies (
      id SERIAL PRIMARY KEY,
      account_group TEXT NOT NULL,
      symbol TEXT NOT NULL,
      type TEXT NOT NULL,
      db_state JSONB,
      alpaca_state JSONB,
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_log (
      id SERIAL PRIMARY KEY,
      account_group TEXT NOT NULL,
      sync_type TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ,
      positions_count INTEGER,
      orders_count INTEGER,
      errors TEXT
    )
  `);
}

export type SyncType = 'poller' | 'manual' | 'post_order';

export interface SyncResult {
  group: AccountGroup;
  skipped: boolean;
  positionsCount: number;
  pendingOrdersCount: number;
  discrepancies: number;
  error: string | null;
}

async function recordDiscrepancy(
  client: PoolClient,
  group: AccountGroup,
  symbol: string,
  type: string,
  dbState: unknown,
  alpacaState: unknown
): Promise<void> {
  console.warn(`[operationsSync] Discrepancia DB vs Alpaca [${group}/${symbol}] tipo=${type}`);
  await client.query(
    `INSERT INTO sync_discrepancies (account_group, symbol, type, db_state, alpaca_state) VALUES ($1, $2, $3, $4, $5)`,
    [group, symbol, type, dbState !== null ? JSON.stringify(dbState) : null, alpacaState !== null ? JSON.stringify(alpacaState) : null]
  );
}

/**
 * Sincroniza un grupo de cuenta (aptos/observados/bloqueados) con Alpaca: cuenta
 * (equity/cash/buying_power), posiciones abiertas y órdenes pendientes/ejecutadas
 * recientes. Detecta discrepancias DB vs Alpaca ANTES de sobrescribir (Alpaca queda
 * como verdad) y deja todo en `sync_log` para trazabilidad. Nunca lanza - los errores
 * quedan en `SyncResult.error` y en `sync_log.errors`, para que `syncAllAccounts`
 * (`Promise.allSettled`) y el poller de 60s nunca se caigan por un grupo fallido.
 */
export async function syncAccountState(pool: Pool, group: AccountGroup, syncType: SyncType = 'manual'): Promise<SyncResult> {
  const startedAt = new Date();
  const client = getAlpacaClient(group);

  if (!client) {
    await pool.query(
      `INSERT INTO sync_log (account_group, sync_type, started_at, finished_at, positions_count, orders_count, errors)
       VALUES ($1, $2, $3, NOW(), 0, 0, $4)`,
      [group, syncType, startedAt, 'Sin credenciales configuradas (ALPACA_<GRUPO>_KEY/_SECRET/_ENDPOINT) - sync omitida']
    );
    return { group, skipped: true, positionsCount: 0, pendingOrdersCount: 0, discrepancies: 0, error: 'Sin credenciales' };
  }

  let account: AlpacaAccountSummary;
  let positions: AlpacaPosition[];
  let openOrders: AlpacaOrder[];
  let closedOrders: AlpacaOrder[];

  try {
    [account, positions, openOrders, closedOrders] = await Promise.all([
      withAlpacaBackoff(() => getAccount(client), `getAccount(${group})`),
      withAlpacaBackoff(() => getPositions(client), `getPositions(${group})`),
      withAlpacaBackoff(() => getOpenOrders(client), `getOpenOrders(${group})`),
      withAlpacaBackoff(() => getClosedOrders(client, EXECUTED_ORDERS_PER_SYNC), `getClosedOrders(${group})`),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[operationsSync] Falló sync de '${group}':`, message);
    await pool.query(
      `INSERT INTO sync_log (account_group, sync_type, started_at, finished_at, positions_count, orders_count, errors)
       VALUES ($1, $2, $3, NOW(), 0, 0, $4)`,
      [group, syncType, startedAt, message]
    );
    await pool.query(
      `UPDATE account_state SET last_sync_ok = FALSE, last_error = $2, last_sync_at = NOW() WHERE account_group = $1`,
      [group, message]
    );
    return { group, skipped: false, positionsCount: 0, pendingOrdersCount: 0, discrepancies: 0, error: message };
  }

  const dbClient = await pool.connect();
  let discrepancies = 0;

  try {
    await dbClient.query('BEGIN');

    const { rows: dbPositions } = await dbClient.query<{ symbol: string; qty: string; avg_entry_price: string }>(
      `SELECT symbol, qty, avg_entry_price FROM positions_snapshot WHERE account_group = $1`,
      [group]
    );
    const { rows: dbOrders } = await dbClient.query<{ alpaca_order_id: string; symbol: string; status: string }>(
      `SELECT alpaca_order_id, symbol, status FROM pending_orders_snapshot WHERE account_group = $1`,
      [group]
    );

    const alpacaPositionsBySymbol = new Map(positions.map((p) => [p.symbol, p]));
    const dbPositionsBySymbol = new Map(dbPositions.map((p) => [p.symbol, p]));
    const alpacaOrdersById = new Map(openOrders.map((o) => [o.id, o]));
    const dbOrdersById = new Map(dbOrders.map((o) => [o.alpaca_order_id, o]));

    for (const [symbol, row] of dbPositionsBySymbol) {
      if (!alpacaPositionsBySymbol.has(symbol)) {
        await recordDiscrepancy(dbClient, group, symbol, 'position_missing_in_alpaca', row, null);
        discrepancies++;
      }
    }
    for (const [symbol, position] of alpacaPositionsBySymbol) {
      if (!dbPositionsBySymbol.has(symbol)) {
        await recordDiscrepancy(dbClient, group, symbol, 'position_missing_in_db', null, position);
        discrepancies++;
      }
    }
    for (const [orderId, row] of dbOrdersById) {
      if (!alpacaOrdersById.has(orderId)) {
        await recordDiscrepancy(dbClient, group, row.symbol, 'pending_order_missing_in_alpaca', row, null);
        discrepancies++;
      }
    }
    for (const [orderId, order] of alpacaOrdersById) {
      if (!dbOrdersById.has(orderId)) {
        await recordDiscrepancy(dbClient, group, order.symbol, 'pending_order_missing_in_db', null, order);
        discrepancies++;
      }
    }

    // Alpaca queda como verdad: se reemplaza el snapshot completo de posiciones/órdenes
    // pendientes de este grupo (las discrepancias ya quedaron registradas arriba).
    await dbClient.query(`DELETE FROM positions_snapshot WHERE account_group = $1`, [group]);
    for (const p of positions) {
      await dbClient.query(
        `INSERT INTO positions_snapshot (account_group, symbol, qty, avg_entry_price, current_price, market_value, unrealized_pl, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [group, p.symbol, p.qty, p.avgEntryPrice, p.currentPrice, p.marketValue, p.unrealizedPl]
      );
    }

    await dbClient.query(`DELETE FROM pending_orders_snapshot WHERE account_group = $1`, [group]);
    for (const o of openOrders) {
      await dbClient.query(
        `INSERT INTO pending_orders_snapshot (account_group, alpaca_order_id, symbol, side, qty, order_type, limit_price, status, submitted_at, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        [group, o.id, o.symbol, o.side, o.qty, o.type, o.limitPrice, o.status, o.submittedAt]
      );
    }

    for (const o of closedOrders) {
      await dbClient.query(
        `INSERT INTO executed_orders_snapshot (account_group, alpaca_order_id, symbol, side, qty, order_type, limit_price, status, submitted_at, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (account_group, alpaca_order_id) DO UPDATE SET status = EXCLUDED.status, synced_at = NOW()`,
        [group, o.id, o.symbol, o.side, o.qty, o.type, o.limitPrice, o.status, o.submittedAt]
      );
    }

    await dbClient.query(
      `INSERT INTO account_state (account_group, equity, cash, buying_power, positions_count, pending_orders_count, last_sync_at, last_sync_ok, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), TRUE, NULL)
       ON CONFLICT (account_group) DO UPDATE SET
         equity = EXCLUDED.equity, cash = EXCLUDED.cash, buying_power = EXCLUDED.buying_power,
         positions_count = EXCLUDED.positions_count, pending_orders_count = EXCLUDED.pending_orders_count,
         last_sync_at = NOW(), last_sync_ok = TRUE, last_error = NULL`,
      [group, account.equity, account.cash, account.buyingPower, positions.length, openOrders.length]
    );

    await dbClient.query(
      `INSERT INTO sync_log (account_group, sync_type, started_at, finished_at, positions_count, orders_count, errors)
       VALUES ($1, $2, $3, NOW(), $4, $5, NULL)`,
      [group, syncType, startedAt, positions.length, openOrders.length]
    );

    await dbClient.query('COMMIT');
  } catch (error) {
    await dbClient.query('ROLLBACK');
    throw error;
  } finally {
    dbClient.release();
  }

  return { group, skipped: false, positionsCount: positions.length, pendingOrdersCount: openOrders.length, discrepancies, error: null };
}

/** Corre `syncAccountState` para los 3 grupos en paralelo - un grupo fallido no afecta a los demás. */
export async function syncAllAccounts(pool: Pool, syncType: SyncType = 'manual'): Promise<Record<AccountGroup, SyncResult>> {
  const settled = await Promise.allSettled(ACCOUNT_GROUPS.map((group) => syncAccountState(pool, group, syncType)));

  const results = {} as Record<AccountGroup, SyncResult>;
  ACCOUNT_GROUPS.forEach((group, index) => {
    const outcome = settled[index];
    results[group] = outcome.status === 'fulfilled'
      ? outcome.value
      : { group, skipped: false, positionsCount: 0, pendingOrdersCount: 0, discrepancies: 0, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) };
  });

  return results;
}
