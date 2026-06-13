# Instrucciones para agentes IA

Este proyecto contiene un bot inicial construido en TypeScript.

## Qué debe saber el asistente

- Proyecto de bot para uso con GitHub Copilot y Anthropic Claude.
- Stack: Node.js + TypeScript.
- El código principal está en `src/index.ts`.
- Usa `npm install`, `npm run build`, `npm start`, `npm run dev`, `npm run ingest`.

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
