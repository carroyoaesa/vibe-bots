import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

export interface AlpacaConfig {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
}

export interface PostgresConfig {
  host: string;
  port: number;
  db: string;
  user: string;
  password: string;
}

export interface RedisConfig {
  url: string;
}

export interface MinioConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
}

export interface FmpConfig {
  apiKey: string;
}

export interface FinnhubConfig {
  apiKey: string;
}

export interface AlphaVantageConfig {
  apiKey: string;
}

export interface FredConfig {
  apiKey: string;
}

export interface AnthropicConfig {
  apiKey: string;
  model: string;
}

export interface WebConfig {
  port: number;
  grafanaPublicUrl?: string;
}

const secureEnvPath = path.resolve(process.cwd(), 'secure', 'keys.env');

if (fs.existsSync(secureEnvPath)) {
  dotenv.config({ path: secureEnvPath });
} else {
  dotenv.config();
}

export function loadAlpacaConfig(): AlpacaConfig {
  const apiKey = process.env.ALPACA_API_KEY;
  const apiSecret = process.env.ALPACA_API_SECRET;
  const baseUrl = process.env.ALPACA_BASE_URL;

  if (!apiKey || !apiSecret || !baseUrl) {
    throw new Error(
      'Faltan variables de Alpaca. Crea secure/keys.env con ALPACA_API_KEY, ALPACA_API_SECRET y ALPACA_BASE_URL.'
    );
  }

  return { apiKey, apiSecret, baseUrl };
}

export function loadPostgresConfig(): PostgresConfig {
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = Number(process.env.POSTGRES_PORT || '5432');
  const db = process.env.POSTGRES_DB || 'vibe';
  const user = process.env.POSTGRES_USER || 'postgres';
  const password = process.env.POSTGRES_PASSWORD || 'postgres';

  if (!host || !db || !user || !password) {
    throw new Error('Faltan variables de PostgreSQL. Revisa .env o secure/keys.env.');
  }

  return { host, port, db, user, password };
}

export function loadRedisConfig(): RedisConfig {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';

  if (!url) {
    throw new Error('Falta la variable REDIS_URL. Revisa .env o secure/keys.env.');
  }

  return { url };
}

export function loadMinioConfig(): MinioConfig {
  const endpoint = process.env.MINIO_ENDPOINT || 'localhost:9000';
  const accessKey = process.env.MINIO_ACCESS_KEY || 'minioadmin';
  const secretKey = process.env.MINIO_SECRET_KEY || 'minioadmin';
  const bucket = process.env.MINIO_BUCKET || 'vibe-bots';
  const region = process.env.MINIO_REGION || 'us-east-1';

  if (!endpoint || !accessKey || !secretKey || !bucket) {
    throw new Error('Faltan variables de MinIO. Revisa .env o secure/keys.env.');
  }

  return { endpoint, accessKey, secretKey, bucket, region };
}

export function loadFmpConfig(): FmpConfig {
  const apiKey = process.env.FMP_API_KEY;

  if (!apiKey) {
    throw new Error('Falta FMP_API_KEY. Revisa .env o secure/keys.env.');
  }

  return { apiKey };
}

export function loadFinnhubConfig(): FinnhubConfig {
  const apiKey = process.env.FINNHUB_API_KEY;

  if (!apiKey) {
    throw new Error('Falta FINNHUB_API_KEY. Revisa .env o secure/keys.env.');
  }

  return { apiKey };
}

export function loadAlphaVantageConfig(): AlphaVantageConfig {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;

  if (!apiKey) {
    throw new Error('Falta ALPHA_VANTAGE_API_KEY. Revisa .env o secure/keys.env.');
  }

  return { apiKey };
}

export function loadFredConfig(): FredConfig {
  const apiKey = process.env.FRED_API_KEY;

  if (!apiKey) {
    throw new Error('Falta FRED_API_KEY. Revisa .env o secure/keys.env.');
  }

  return { apiKey };
}

export function loadAnthropicConfig(): AnthropicConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('Falta ANTHROPIC_API_KEY. Revisa .env o secure/keys.env.');
  }

  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

  return { apiKey, model };
}

export function loadWebConfig(): WebConfig {
  const port = Number(process.env.WEB_PORT || '4000');
  const grafanaPublicUrl = process.env.GRAFANA_PUBLIC_URL || undefined;

  return { port, grafanaPublicUrl };
}
