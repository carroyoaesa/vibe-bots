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
- Alpaca API para trading y cotizaciones
- Grafana para dashboards, leyendo directamente de PostgreSQL

> No se usa Docker en el entorno actual. Los archivos `Dockerfile`, `docker-compose.yml` y `docker/` ya no forman parte de la arquitectura activa.

## Comandos

- `npm install` - instalar dependencias Node
- `npm run build` - compilar TypeScript
- `npm start` - ejecutar el bot compilado
- `npm run dev` - ejecutar con `ts-node`

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
```

## Diagnóstico (`npm run dev`)

`src/index.ts` ejecuta cuatro verificaciones independientes (Alpaca, PostgreSQL, Redis, MinIO) mediante `src/check-runner.ts`. Cada una corre de forma aislada: si una falla, las demás igual se ejecutan, y al final se muestra un resumen con el estado de cada servicio.

- `src/services/alpaca.ts` - cliente Alpaca y verificación de cuenta.
- `src/services/db.ts` - pool de PostgreSQL y verificación (crea/lee una fila de prueba).
- `src/services/cache.ts` - cliente Redis y verificación (set/get de prueba).
- `src/services/storage.ts` - cliente MinIO y verificación (bucket + objeto de prueba).

## Grafana

Grafana corre como servicio nativo (`systemctl status grafana-server`) en `http://localhost:3000`.

- Datasource "PostgreSQL - vibe" provisionado en `/etc/grafana/provisioning/datasources/vibe-postgres.yaml`, apuntando a la misma base `vibe` y usuario (`vibe_bot`) que usa el bot.
- Login inicial: `admin` / `admin` (Grafana pide cambiarla en el primer ingreso).
- Aún sin dashboards: se crearán cuando el bot empiece a escribir datos de trading en `vibe_data` / tablas futuras.

## Arquitectura para futuros agentes de código

Este proyecto ya está preparado para evolucionar hacia:

1. ingestión de datos en PostgreSQL
2. uso de Redis para estado y colas
3. almacenamiento de archivos y snapshots en MinIO
4. ejecución de órdenes vía Alpaca
5. backtesting y servicios de IA, visualizados en los dashboards de Grafana ya configurados
