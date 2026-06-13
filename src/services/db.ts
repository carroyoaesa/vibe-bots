import { Pool } from 'pg';
import { PostgresConfig } from '../config';

export function createPostgresPool(config: PostgresConfig): Pool {
  return new Pool({
    host: config.host,
    port: config.port,
    database: config.db,
    user: config.user,
    password: config.password,
  });
}

export async function verifyPostgres(pool: Pool) {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS vibe_data (
        id SERIAL PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        value JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(
      `INSERT INTO vibe_data (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, created_at = NOW()`,
      ['health-check', { status: 'ok', timestamp: new Date().toISOString() }]
    );

    const result = await client.query('SELECT key, value FROM vibe_data WHERE key = $1', ['health-check']);
    return result.rows[0];
  } finally {
    client.release();
  }
}
