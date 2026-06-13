import Redis from 'ioredis';
import { RedisConfig } from '../config';

export function createRedisClient(config: RedisConfig) {
  return new Redis(config.url);
}

export async function verifyRedis(client: ReturnType<typeof createRedisClient>) {
  await client.set('vibe-bots:health-check', JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  const value = await client.get('vibe-bots:health-check');
  await client.quit();
  return value ? JSON.parse(value) : null;
}
