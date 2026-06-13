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
