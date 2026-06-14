# Instrucciones para agentes IA

Este proyecto contiene un bot inicial construido en TypeScript.

## Qué debe saber el asistente

- Proyecto de bot para uso con GitHub Copilot y Anthropic Claude.
- Stack: Node.js + TypeScript.
- El código principal está en `src/index.ts`.
- Usa `npm install`, `npm run build`, `npm start`, `npm run dev`, `npm run ingest`, `npm run web`.

## Convenciones

- Mantener `src/` como fuente principal del código.
- Guardar las claves de la app (Alpaca, PostgreSQL, Redis, MinIO, FMP, Finnhub, Alpha Vantage, FRED) en `secure/keys.env` o en variables de entorno, nunca en el repositorio.
- Las credenciales de Git/GitHub NO van en `secure/keys.env` ni en la URL del remoto: usar el credential helper de git (`~/.git-credentials`, configurado con `git config --global credential.helper store`).
- Evitar dependencias innecesarias fuera de `devDependencies` para comenzar.
- Documentar cualquier API externa o clave en `README.md`.

## Desarrollo asistido

- Generar funciones de bot en `src/` con comentarios claros.
- Crear tests y casos de uso antes de agregar nuevas funciones.
- Añadir cada nueva integración de API con `README.md` y `AGENTS.md`.

## Integraciones de API externas (datos para decisiones de trading)

Además de Alpaca (trading + market data), el proyecto integra:

- **Financial Modeling Prep (FMP)** (`src/services/fmp.ts`): fundamentales/perfil de empresa vía `/stable/profile`. El endpoint legacy `/api/v3/profile` está deprecado para keys nuevas (post agosto 2025).
- **Finnhub** (`src/services/finnhub.ts`): quotes en tiempo real (`/quote`), usado en `npm run ingest` para cachear precios en Redis.
- **Alpha Vantage** (`src/services/alphaVantage.ts`): `GLOBAL_QUOTE` y potencialmente noticias/sentimiento. Free tier ~25 requests/día: **no usar en loops sobre el watchlist ni en jobs recurrentes**, solo en diagnóstico o consultas puntuales.
- **FRED** (`src/services/fred.ts`): series macroeconómicas (`FEDFUNDS`, `CPIAUCSL`, `UNRATE`), sin límites prácticos.

Cada cliente tiene una función `verifyX()` que se ejecuta en `npm run dev` (`src/index.ts`) como chequeo de salud. La ingesta de datos para el watchlist vive en `src/ingest.ts` y persiste en PostgreSQL vía `src/services/marketStore.ts`.

## Dashboard web (Fase 1.5)

- `src/diagnostics.ts`: lista compartida de health checks (`DIAGNOSTIC_CHECKS` + `runDiagnostics()`). Es la fuente única de verdad para `npm run dev` (`src/index.ts`) y para `GET /api/health`. Si se agrega una nueva integración, su `verifyX()` debe registrarse aquí, no directamente en `index.ts`.
- `src/ingestRunner.ts`: lógica de `runIngest()` (antes en `src/ingest.ts`). `src/ingest.ts` es ahora un wrapper CLI delgado; `POST /api/ingest` llama a la misma función.
- `src/server.ts`: servidor Express (`npm run web`, puerto `WEB_PORT`/4000) que sirve `public/` (frontend estático) y expone `/api/health`, `/api/config`, `/api/ingest`.
- `public/`: frontend estático (HTML/CSS/JS sin build step) - tarjetas de salud, botón de ingesta e iframe de Grafana.
- El iframe de Grafana usa `GRAFANA_PUBLIC_URL` (Public Dashboard de Grafana, ver README). No depende de cookies de sesión de Grafana.
- Cambios en `/etc/grafana/grafana.ini` (p.ej. `allow_embedding`) son a nivel de sistema y NO están en este repo. Si se edita ese archivo, restaurar `chown root:grafana` y `chmod 640` después, o `grafana-server` no podrá leerlo.
