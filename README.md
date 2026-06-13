# Vibe Bots

Proyecto de bot trader en TypeScript diseñado para correr en una instancia LXD con servicios nativos.

## Arquitectura actual

- `src/` - código fuente TypeScript
- `package.json` - dependencias y scripts
- `tsconfig.json` - configuración TypeScript
- `AGENTS.md` - contexto y reglas para agentes IA
- `secure/` - directorio ignorado para claves y secretos locales
- `.env.example` - plantilla de variables de entorno

## Stack nativo

El proyecto está configurado para usar servicios nativos instalados en la misma instancia:

- PostgreSQL para almacenamiento relacional y datos históricos
- Redis para caché, colas o estado en memoria
- MinIO para almacenamiento S3 compatible de datos brutos y backups
- Alpaca API para trading, cotizaciones y noticias (Market Data API)
- Financial Modeling Prep (FMP) para fundamentales de empresas
- Finnhub para quotes en tiempo real
- Alpha Vantage para quotes y series alternativas (uso moderado, free tier limitado)
- FRED (Federal Reserve Economic Data) para series macroeconómicas
- Grafana para dashboards, leyendo directamente de PostgreSQL

> No se usa Docker en el entorno actual. Los archivos `Dockerfile`, `docker-compose.yml` y `docker/` ya no forman parte de la arquitectura activa.

## Comandos

- `npm install` - instalar dependencias Node
- `npm run build` - compilar TypeScript
- `npm start` - ejecutar el bot compilado
- `npm run dev` - ejecutar diagnóstico completo con `ts-node`
- `npm run ingest` - ejecutar la ingesta de datos de mercado (Fase 1)

## Configuración local

1. Crea `secure/keys.env` con las variables necesarias.
2. Si no usas `secure/keys.env`, pon las mismas variables en un `.env` local.
3. El proyecto cargará automáticamente estas variables.

## Variables requeridas

```env
ALPACA_API_KEY=tu_api_key_aqui
ALPACA_API_SECRET=tu_api_secret_aqui
ALPACA_BASE_URL=https://paper-api.alpaca.markets

POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=vibe
POSTGRES_USER=vibe_bot
POSTGRES_PASSWORD=tu_password_aqui

REDIS_URL=redis://localhost:6379

MINIO_ENDPOINT=localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=vibe-bots
MINIO_REGION=us-east-1

# Fundamentales, quotes, noticias/sentimiento y datos macro
FMP_API_KEY=
FINNHUB_API_KEY=
ALPHA_VANTAGE_API_KEY=
FRED_API_KEY=
```

## Diagnóstico (`npm run dev`)

`src/index.ts` ejecuta nueve verificaciones independientes mediante `src/check-runner.ts`. Cada una corre de forma aislada: si una falla, las demás igual se ejecutan, y al final se muestra un resumen con el estado de cada servicio.

1. `src/services/alpaca.ts` - cliente Alpaca (Trading API) y verificación de cuenta.
2. `src/services/db.ts` - pool de PostgreSQL y verificación (crea/lee una fila de prueba).
3. `src/services/cache.ts` - cliente Redis y verificación (set/get de prueba).
4. `src/services/storage.ts` - cliente MinIO y verificación (bucket + objeto de prueba).
5. `src/services/marketData.ts` - cliente Alpaca Market Data API, verifica bars históricas y noticias.
6. `src/services/fmp.ts` - cliente Financial Modeling Prep, verifica perfil de empresa (`/stable/profile`).
7. `src/services/finnhub.ts` - cliente Finnhub, verifica quote en tiempo real.
8. `src/services/alphaVantage.ts` - cliente Alpha Vantage, verifica `GLOBAL_QUOTE`.
9. `src/services/fred.ts` - cliente FRED, verifica última observación de `FEDFUNDS`.

## Ingesta de datos (`npm run ingest`) - Fase 1

`src/ingest.ts` corre la ingesta inicial de datos de mercado para un watchlist fijo (`AAPL, MSFT, SPY, QQQ, NVDA`, definido en el propio archivo) y la guarda en PostgreSQL (`src/services/marketStore.ts` crea las tablas si no existen):

- **`market_bars`**: bars diarias (últimos 30 días) desde Alpaca Market Data API (feed IEX).
- **`news_items`**: noticias del watchlist desde Alpaca News API (Benzinga).
- **`fundamentals_snapshots`**: perfil/fundamentales por símbolo desde FMP (`JSONB`, un snapshot por corrida).
- **`macro_series`**: observaciones de FRED para `FEDFUNDS`, `CPIAUCSL`, `UNRATE`.

Además cachea en Redis el último quote de Finnhub por símbolo (`quote:<SYMBOL>`, TTL 5 min) para consumo rápido por el bot.

> ⚠️ Alpha Vantage tiene un free tier muy limitado (~25 requests/día). Su cliente (`src/services/alphaVantage.ts`) está disponible y se prueba en el diagnóstico, pero **no** se usa en la ingesta recurrente para no agotar la cuota.

## Grafana

Grafana corre como servicio nativo (`systemctl status grafana-server`) en `http://localhost:3000`.

- Datasource "PostgreSQL - vibe" provisionado en `/etc/grafana/provisioning/datasources/vibe-postgres.yaml`, apuntando a la misma base `vibe` y usuario (`vibe_bot`) que usa el bot.
- Login inicial: `admin` / `admin` (Grafana pide cambiarla en el primer ingreso).
- Aún sin dashboards: ahora que `npm run ingest` ya escribe en `market_bars`, `news_items`, `fundamentals_snapshots` y `macro_series`, se pueden crear paneles sobre esas tablas.

## Arquitectura para futuros agentes de código

Estado de las fases:

1. ✅ **Ingestión de datos en PostgreSQL** (Fase 1, `src/ingest.ts`): bars, noticias, fundamentales y series macro.
2. ✅ uso de Redis para caché de quotes (Finnhub) - pendiente extender a estado/colas de órdenes.
3. ⬜ almacenamiento de archivos y snapshots en MinIO (aún solo health-check).
4. ⬜ ejecución de órdenes vía Alpaca (señales + gestión de riesgo + bracket orders).
5. ⬜ backtesting y capa de IA (Claude) combinando indicadores técnicos + fundamentales (FMP) + sentimiento (noticias/Alpha Vantage) + contexto macro (FRED), visualizado en Grafana.
