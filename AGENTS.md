# Instrucciones para agentes IA

Este proyecto contiene un bot inicial construido en TypeScript.

> Si estás usando Claude Code, ver también `CLAUDE.md` (contexto denso auto-cargado, reglas operativas críticas y estado actual de la estrategia/precios).

## Qué debe saber el asistente

- Proyecto de bot para uso con GitHub Copilot y Anthropic Claude.
- Stack: Node.js + TypeScript.
- El código principal está en `src/index.ts`.
- Usa `npm install`, `npm run build`, `npm start`, `npm run dev`, `npm run ingest`, `npm run trade`, `npm run web`.

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
- `src/server.ts`: servidor Express (`npm run web`, puerto `WEB_PORT`/4000) que sirve `public/` (frontend estático) y expone `/api/health`, `/api/config`, `/api/ingest`, `/api/trading/status`, `/api/trading/chart/:symbol`, `/api/trading/run`.
- `public/`: frontend estático (HTML/CSS/JS sin build step, Chart.js v4 vía CDN) - tarjetas de salud, botón de ingesta, sección de trading (sub-secciones ETFs/Acciones con tablas + gráficos por símbolo ordenados por `attractivenessScore`) e iframe de Grafana.
- El iframe de Grafana usa `GRAFANA_PUBLIC_URL` (Public Dashboard de Grafana, ver README). No depende de cookies de sesión de Grafana.
- Cambios en `/etc/grafana/grafana.ini` (p.ej. `allow_embedding`) son a nivel de sistema y NO están en este repo. Si se edita ese archivo, restaurar `chown root:grafana` y `chmod 640` después, o `grafana-server` no podrá leerlo.
- El dashboard web **no** corre como servicio systemd (decisión deliberada del usuario, ver README "Levantar/parar el dashboard web"). Se gestiona con `npm run web:start` / `npm run web:stop` / `npm run status` (scripts en `scripts/`, nohup + PID file). No crear una unidad systemd para `src/server.ts` sin pedirlo explícitamente de nuevo.

## Trading automatizado (Fase 2, paper)

- `src/watchlist.ts`: fuente única de verdad para `WATCHLIST` (28 símbolos: 15 ETFs en `ETF_SYMBOLS` + 13 acciones), `MACRO_SERIES` y `BARS_LOOKBACK_DAYS` (220 días, para tener suficiente histórico para SMA30+RSI14). Usado por `src/ingestRunner.ts`, la estrategia y `/api/trading/status` (clasifica cada símbolo como `ETF`/`STOCK`).
- `src/strategy/`: lógica pura (sin I/O) de la estrategia.
  - `indicators.ts`: `sma()`, `rsi()`, `momentum()`, `smaSeries()`, `rsiSeries()`, `estimateEntryPrice()`.
  - `signals.ts`: `computeSignal(symbol, closes)` -> `SignalResult` con `BUY`/`SELL`/`HOLD` (cruce SMA10/SMA30 confirmado con RSI<70 y momentum>0 para BUY), más `estimatedEntryPrice` y `estimatedExitPrice` (= `estimatedEntryPrice * (1 + RISK_PROFILE.takeProfitPct)`).
  - `config.ts`: `STRATEGY_PARAMS` (periodos de SMA/RSI/momentum) y `RISK_PROFILE` (perfil moderado: 10% equity por posición, SL -3%/TP +6%, máx. 5 posiciones).
  - `chart.ts`: `buildChartSeries(bars)` - serie de cierre + SMA10/SMA30/RSI para `/api/trading/chart/:symbol`.
- `src/services/tradingStore.ts`: tablas `trading_signals` (incluye `estimated_entry_price`, `estimated_exit_price`) y `trading_orders` (creadas/migradas por `setupTradingSchema` vía `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), helpers `saveSignal`, `saveOrder`, `getRecentOrders`. `getLatestSignals` sigue existiendo pero ya no la usa `server.ts` (que ahora recalcula señales frescas para todo el watchlist).
- `src/services/alpaca.ts`: además de `verifyAlpaca`/`getAccount`, expone `getPositions`, `getOpenOrders`, `placeBracketBuyOrder` (orden **límite** con `limitPrice`, `takeProfitPrice`, `stopLossPrice`), `cancelOrder`, `closePosition`.
- `src/tradingRunner.ts`: `runTradingCycle()` - orquesta señales + riesgo + ejecución para todo el watchlist. Es la lógica compartida entre `src/trade.ts` (CLI, `npm run trade`) y `POST /api/trading/run`. En BUY, coloca la bracket order límite al `estimatedEntryPrice` (con fallback a `signal.price` si es `null`), con TP/SL relativos a ese precio.
- ⚠️ **`runTradingCycle()` coloca/cierra órdenes reales (bracket orders) en la cuenta PAPER de Alpaca.** No hay un modo "dry-run" separado en esta fase - el entorno paper de Alpaca ya cumple ese rol. Cualquier cambio a `tradingRunner.ts`, `strategy/config.ts` (perfil de riesgo) o `strategy/signals.ts` debe tenerse en cuenta como un cambio de comportamiento de trading real (en paper).
- `grafana/dashboards/vibe-trading.json` (uid `vibe-bots-trading`): historial de señales, precio/RSI por símbolo y órdenes recientes. Se publica igual que `vibe-overview.json` (`POST /api/dashboards/db` con `admin:admin`). Los paneles `timeseries` tienen `fieldConfig.defaults.custom` (v2) pero la verificación visual queda pendiente (diferido a pedido del usuario).
