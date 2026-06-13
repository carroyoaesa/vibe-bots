import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

export interface AlpacaConfig {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
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
