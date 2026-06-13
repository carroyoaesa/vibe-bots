import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import axios from 'axios';

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

export function createAlpacaClient() {
  const config = loadAlpacaConfig();

  return axios.create({
    baseURL: config.baseUrl,
    headers: {
      'APCA-API-KEY-ID': config.apiKey,
      'APCA-API-SECRET-KEY': config.apiSecret,
    },
  });
}
