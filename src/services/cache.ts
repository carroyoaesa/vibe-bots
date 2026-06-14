import Redis from 'ioredis';
import { RedisConfig } from '../config';

export function createRedisClient(config: RedisConfig) {
  return new Redis(config.url);
}

export async function verifyRedis(client: ReturnType<typeof createRedisClient>) {
  try {
    await client.set('vibe-bots:health-check', JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    const value = await client.get('vibe-bots:health-check');
    return value ? JSON.parse(value) : null;
  } finally {
    await client.quit();
  }
}

export interface CachedValue<T> {
  value: T;
  cachedAt: string;
}

/** Lee un valor JSON cacheado (con su timestamp de guardado), o `null` si no existe/expiró. */
export async function getCachedJson<T>(client: ReturnType<typeof createRedisClient>, key: string): Promise<CachedValue<T> | null> {
  const raw = await client.get(key);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as CachedValue<T>;
  } catch {
    return null;
  }
}

/** Guarda un valor JSON en caché con TTL, junto al timestamp en que se generó. */
export async function setCachedJson<T>(
  client: ReturnType<typeof createRedisClient>,
  key: string,
  value: T,
  ttlSeconds: number
): Promise<CachedValue<T>> {
  const cached: CachedValue<T> = { value, cachedAt: new Date().toISOString() };
  await client.set(key, JSON.stringify(cached), 'EX', ttlSeconds);
  return cached;
}

/** Devuelve el valor cacheado si existe, o lo calcula con `fetcher`, lo cachea y lo devuelve. */
export async function getCachedOrFetch<T>(
  client: ReturnType<typeof createRedisClient>,
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const hit = await getCachedJson<T>(client, key);
  if (hit) return hit.value;

  const value = await fetcher();
  await setCachedJson(client, key, value, ttlSeconds);
  return value;
}

// Claves/TTLs de caché de estado de Alpaca, compartidas entre /api/health, /api/trading/status
// y runTradingCycle() para reducir llamadas repetidas a Alpaca por el polling del dashboard.
export const ALPACA_ACCOUNT_CACHE_KEY = 'alpaca:account';
export const ALPACA_ACCOUNT_CACHE_TTL_SECONDS = 45;
export const ALPACA_POSITIONS_CACHE_KEY = 'alpaca:positions';
export const ALPACA_POSITIONS_CACHE_TTL_SECONDS = 30;
// Las órdenes abiertas solo se refrescan en runTradingCycle() (ya las necesita para decidir);
// /api/trading/status las lee de caché sin disparar una llamada extra a Alpaca. TTL ~70 min
// para cubrir el intervalo entre corridas del cron horario.
export const ALPACA_OPEN_ORDERS_CACHE_KEY = 'alpaca:open-orders';
export const ALPACA_OPEN_ORDERS_CACHE_TTL_SECONDS = 4200;
