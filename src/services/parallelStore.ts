import { Pool } from 'pg';

/**
 * Posiciones del sistema paralelo (Tier 2, `strategy/hybridConfig.ts`: MS, QQQM) -
 * trackeadas por separado de las posiciones 1D normales porque Alpaca agrega todo
 * en una sola posición por símbolo. Cada fila es la porción de la posición de Alpaca
 * que pertenece al sistema paralelo: `qty`/`entryPrice` se usan para vender
 * exactamente esa cantidad (`closePositionQty`, `services/alpaca.ts`) sin tocar la
 * posición 1D del mismo símbolo.
 */
export async function setupParallelSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS parallel_positions (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      qty NUMERIC NOT NULL,
      entry_price NUMERIC NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      exit_price NUMERIC,
      open_order_id TEXT,
      close_order_id TEXT
    )
  `);
}

export interface ParallelPosition {
  id: number;
  symbol: string;
  qty: number;
  entryPrice: number;
  status: 'open' | 'closed';
  openedAt: string;
  closedAt: string | null;
  exitPrice: number | null;
}

function mapRow(row: any): ParallelPosition {
  return {
    id: row.id,
    symbol: row.symbol,
    qty: Number(row.qty),
    entryPrice: Number(row.entry_price),
    status: row.status,
    openedAt: new Date(row.opened_at).toISOString(),
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
    exitPrice: row.exit_price !== null ? Number(row.exit_price) : null,
  };
}

/** Posiciones paralelas abiertas (1 como máximo por símbolo, ver `PARALLEL_RISK_PROFILE.maxPositions`). */
export async function getOpenParallelPositions(pool: Pool): Promise<ParallelPosition[]> {
  const result = await pool.query(`SELECT * FROM parallel_positions WHERE status = 'open' ORDER BY opened_at ASC`);
  return result.rows.map(mapRow);
}

/** Registra la apertura de una posición paralela (BUY del combo 1H, Tier 2). Devuelve el `id` de la fila. */
export async function openParallelPosition(
  pool: Pool,
  params: { symbol: string; qty: number; entryPrice: number; openOrderId: string }
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO parallel_positions (symbol, qty, entry_price, status, open_order_id)
     VALUES ($1, $2, $3, 'open', $4)
     RETURNING id`,
    [params.symbol, params.qty, params.entryPrice, params.openOrderId]
  );
  return result.rows[0].id;
}

/** Marca una posición paralela como cerrada (SELL del combo 1H, Tier 2). */
export async function closeParallelPosition(
  pool: Pool,
  id: number,
  params: { exitPrice: number; closeOrderId: string }
): Promise<void> {
  await pool.query(
    `UPDATE parallel_positions SET status = 'closed', closed_at = NOW(), exit_price = $2, close_order_id = $3 WHERE id = $1`,
    [id, params.exitPrice, params.closeOrderId]
  );
}

/** Últimas posiciones paralelas (abiertas y cerradas), para el dashboard. */
export async function getRecentParallelPositions(pool: Pool, limit: number): Promise<ParallelPosition[]> {
  const result = await pool.query(`SELECT * FROM parallel_positions ORDER BY opened_at DESC LIMIT $1`, [limit]);
  return result.rows.map(mapRow);
}
