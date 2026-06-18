import { Pool } from 'pg';
import { WATCHLIST } from '../watchlist';
import { AccountGroup } from './alpaca';

export type SymbolClassificationStatus = 'apto' | 'observar' | 'bloqueado';

export const SYMBOL_CLASSIFICATION_STATUSES: SymbolClassificationStatus[] = ['apto', 'observar', 'bloqueado'];

/**
 * Mapeo 1:1 clasificación -> grupo de cuenta Alpaca (`services/alpaca.ts#AccountGroup`).
 * Usado para ETIQUETAR `trading_signals`/`trading_orders.account_group` con el grupo que
 * "le correspondería" al símbolo según su clasificación ACTUAL - no implica ruteo real de
 * la orden a esa cuenta (eso sigue pendiente, ver entregable de esta fase).
 */
const CLASSIFICATION_TO_ACCOUNT_GROUP: Record<SymbolClassificationStatus, AccountGroup> = {
  apto: 'aptos',
  observar: 'observados',
  bloqueado: 'bloqueados',
};

export function classificationToAccountGroup(status: SymbolClassificationStatus): AccountGroup {
  return CLASSIFICATION_TO_ACCOUNT_GROUP[status];
}

// Defaults iniciales (2026-06-18), decididos manualmente sobre el watchlist de 27 símbolos
// vigente en ese momento. Solo se usan para sembrar la tabla si está vacía - una vez que
// hay clasificaciones guardadas, esta lista no vuelve a aplicarse.
const INITIAL_BLOQUEADO = ['SOXQ', 'AMZN', 'TSM', 'SCHG', 'SPMO', 'HD', 'MSFT', 'XMMO'];
const INITIAL_OBSERVAR = ['QQQM', 'MAIN', 'SPY', 'VUG'];

export async function setupSymbolClassificationSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS symbol_classifications (
      symbol TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('apto', 'observar', 'bloqueado')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT
    )
  `);

  const { rows } = await pool.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM symbol_classifications');
  if (rows[0].count > 0) return;

  for (const symbol of WATCHLIST) {
    const status: SymbolClassificationStatus = INITIAL_BLOQUEADO.includes(symbol)
      ? 'bloqueado'
      : INITIAL_OBSERVAR.includes(symbol)
        ? 'observar'
        : 'apto';

    await pool.query(
      `INSERT INTO symbol_classifications (symbol, status) VALUES ($1, $2) ON CONFLICT (symbol) DO NOTHING`,
      [symbol, status]
    );
  }
}

interface ClassificationCache {
  bySymbol: Map<string, SymbolClassificationStatus>;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
let cache: ClassificationCache | null = null;

async function loadAll(pool: Pool): Promise<Map<string, SymbolClassificationStatus>> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.bySymbol;
  }

  const result = await pool.query<{ symbol: string; status: SymbolClassificationStatus }>(
    'SELECT symbol, status FROM symbol_classifications'
  );

  const bySymbol = new Map(result.rows.map((row) => [row.symbol, row.status]));
  cache = { bySymbol, expiresAt: Date.now() + CACHE_TTL_MS };
  return bySymbol;
}

/** Todas las clasificaciones, `{symbol: status}`. Símbolos sin fila no aparecen (default implícito 'apto'). */
export async function getAllSymbolClassifications(pool: Pool): Promise<Record<string, SymbolClassificationStatus>> {
  const bySymbol = await loadAll(pool);
  return Object.fromEntries(bySymbol);
}

/** Clasificación de un símbolo puntual - 'apto' si no tiene fila todavía. */
export async function getSymbolClassification(pool: Pool, symbol: string): Promise<SymbolClassificationStatus> {
  const bySymbol = await loadAll(pool);
  return bySymbol.get(symbol) ?? 'apto';
}

/** Símbolos del watchlist cuya clasificación actual es `status` (sin fila = 'apto'). */
export async function getSymbolsByClassification(pool: Pool, status: SymbolClassificationStatus): Promise<string[]> {
  const bySymbol = await loadAll(pool);
  return WATCHLIST.filter((symbol) => (bySymbol.get(symbol) ?? 'apto') === status);
}

export async function setSymbolClassification(
  pool: Pool,
  symbol: string,
  status: SymbolClassificationStatus,
  updatedBy: string | null = null
): Promise<void> {
  await pool.query(
    `INSERT INTO symbol_classifications (symbol, status, updated_at, updated_by)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (symbol) DO UPDATE SET status = EXCLUDED.status, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [symbol, status, updatedBy]
  );

  // Invalida la caché en memoria para que la próxima lectura (este mismo proceso, dentro
  // del TTL) vea el cambio de inmediato - importante para el hard-block de tradingRunner.ts.
  cache = null;
}
