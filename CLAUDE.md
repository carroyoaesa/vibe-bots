# CLAUDE.md - contexto denso para Claude Code

Este archivo se carga automáticamente en cada sesión. Objetivo: que tras una auto-compactación no se pierdan reglas operativas críticas ni el estado actual del proyecto. Para detalle completo ver `README.md` (usuarios) y `AGENTS.md` (agentes IA en general).

## Qué es este proyecto

Bot de trading en TypeScript/Node.js (CommonJS, ES2020, `strict: true`) corriendo en una instancia LXD con servicios **nativos** (no Docker): PostgreSQL, Redis, MinIO, Grafana, todos vía systemd con autostart. Directorio de trabajo: `/root/bots/vibe-bots`. Repo: `github.com/carroyoaesa/vibe-bots`, branch `main`.

Fases: 1 (ingesta ✅), 1.5 (dashboard web ✅), 2 (estrategia + ejecución paper ✅), 3 (snapshots MinIO ✅), 4 (backtesting/IA ⬜).

## Reglas operativas críticas (NO romper sin pedir confirmación explícita)

1. **`src/server.ts` (dashboard web) NUNCA va como servicio systemd.** Se gestiona solo con `./scripts/start-web.sh`, `./scripts/stop-web.sh`, `./scripts/status.sh` (nohup + PID en `run/web.pid`, logs en `logs/web.log`). Decisión deliberada del usuario, repetida más de una vez.
2. **`runTradingCycle()` (`npm run trade`, `POST /api/trading/run`, botón "Ejecutar ciclo de trading") coloca/cierra órdenes REALES en la cuenta PAPER de Alpaca.** No hay modo dry-run separado. Cualquier cambio a `tradingRunner.ts`, `strategy/config.ts` o `strategy/signals.ts` es un cambio de comportamiento de trading real (en paper). No ejecutar este ciclo proactivamente sin que el usuario lo pida.
3. **Push a `main` en GitHub requiere confirmación explícita del usuario en cada ocasión** (no asumir autorización previa).
4. **No instalar paquetes apt a nivel de sistema** (p.ej. `playwright install-deps`) sin pedido explícito - se considera modificación significativa de infraestructura compartida.
5. Secretos en `secure/keys.env` (o `.env` local), nunca en el repo. Credenciales de Git van vía `~/.git-credentials` (credential helper), no en `secure/keys.env` ni en la URL del remoto.
6. Si se edita `/etc/grafana/grafana.ini` (fuera del repo), restaurar `chown root:grafana` y `chmod 640` después.

## Mapa del repo

- `src/index.ts`, `src/check-runner.ts`, `src/diagnostics.ts` - 9 health checks (`npm run dev`, `GET /api/health`).
- `src/ingest.ts`, `src/ingestRunner.ts` - ingesta Fase 1 (`npm run ingest`, `POST /api/ingest`).
- `src/watchlist.ts` - **fuente única de verdad**: `WATCHLIST` (20 símbolos), `ETF_SYMBOLS` (11, subconjunto de WATCHLIST), `MACRO_SERIES`, `BARS_LOOKBACK_DAYS=220`.
- `src/strategy/` - lógica pura, sin I/O:
  - `indicators.ts`: `sma`, `rsi`, `momentum`, `smaSeries`, `rsiSeries`, `estimateEntryPrice`.
  - `signals.ts`: `computeSignal(symbol, closes) -> SignalResult`.
  - `config.ts`: `STRATEGY_PARAMS` (SMA 10/30, RSI14, umbral 70, momentum 10) y `RISK_PROFILE` (10% equity/posición, SL -3%/TP +6%, máx 5 posiciones).
  - `chart.ts`: `buildChartSeries(bars)` para `/api/trading/chart/:symbol`.
- `src/services/` - I/O: `alpaca.ts`, `marketData.ts`, `marketStore.ts`, `tradingStore.ts`, `db.ts`, `cache.ts`, `storage.ts`, `fmp.ts`, `finnhub.ts`, `alphaVantage.ts`, `fred.ts`.
- `src/tradingRunner.ts` - `runTradingCycle()`, lógica compartida CLI/web.
- `src/server.ts` - Express, puerto `WEB_PORT` (4000). Sirve `public/` + `/api/*`.
- `public/` - frontend estático (`index.html`, `app.js`, `styles.css`), Chart.js v4 vía CDN.
- `grafana/dashboards/*.json` - dashboards provisionados vía API (`admin:admin`).
- `scripts/` - `start-web.sh`, `stop-web.sh`, `status.sh`.

## Watchlist (20 símbolos, `src/watchlist.ts`)

- **ETFs (11)**: `SPY, SCHE, SCHF, XLP, XLU, XMMO, VUG, SCHD, SPMO, QQQM, SOXQ`.
- **Acciones (9)**: `AAPL, MSFT, NVDA, REG, TOL, AMZN, TSM, GOOGL, MS`.
- El dashboard divide "Trading (Fase 2 - paper)" en sub-secciones ETFs/Acciones, ordenadas por `attractivenessScore` (en `public/app.js`).
- Reducido desde 28 símbolos (2026-06-14) tras un análisis de backtests/correlación/liquidez: se quitaron `NECB, DBEZ, PPA, AVGO, MU, AGM` por baja probabilidad de retorno con la estrategia actual (sin señales, micro-caps ilíquidos, o volatilidad diaria que supera el SL fijo del 3%); luego `QQQ` (duplicado casi perfecto de `QQQM`, r=0.999, comisión más alta: 0.20% vs 0.15%) y `SCHG` (duplicado casi perfecto de `VUG`, r=0.993, comisión más alta: 0.04% vs 0.03%).

## Modelo de precios de la estrategia (estado actual)

- `estimatedEntryPrice` (`SignalResult`): nivel de cierre que haría que SMA10 (próxima sesión) alcance la SMA30 actual. `null` si histórico insuficiente.
- `estimatedExitPrice` (`SignalResult`): `estimatedEntryPrice * (1 + RISK_PROFILE.takeProfitPct)`. `null` si `estimatedEntryPrice` es `null`.
- En `runTradingCycle`, BUY coloca una **bracket order LÍMITE** (`type: 'limit'`, `limit_price = estimatedEntryPrice`), con `take_profit.limit_price = estimatedExitPrice` y `stop_loss.stop_price = estimatedEntryPrice * (1 - stopLossPct)`. La cantidad (`qty`) se sigue calculando sobre `equity * 10% / signal.price` (precio de mercado actual).
- Ambos precios se muestran en las tablas del dashboard ("Precio est. entrada" / "Precio est. salida") y como líneas horizontales punteadas en los gráficos por símbolo (amarillo = entrada, violeta = salida).

## DB - columnas relevantes en `trading_signals`

`symbol, ts, price, sma_fast, sma_slow, rsi, momentum, estimated_entry_price, estimated_exit_price, signal, reason`. Migraciones vía `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` en `setupTradingSchema` (`tradingStore.ts`), ejecutado al inicio de `runTradingCycle()` pero NO por `GET /api/trading/status` - si agregás una columna nueva, asegurate de que ya exista en la DB (correr `npm run trade` una vez, o `ALTER TABLE` manual) antes de que ese endpoint la consulte.

## `/api/trading/status` (importante para no romper)

Recalcula señales **frescas** (no cacheadas) para los 20 símbolos vía `getCloses` + `computeSignal`, etiquetando cada una con `type: 'ETF' | 'STOCK'` según `ETF_SYMBOLS`. `getLatestSignals` (`tradingStore.ts`) existe pero ya no se usa desde aquí (queda como helper histórico).

## Snapshots en MinIO (Fase 3)

- `src/services/storage.ts`: además del health-check, expone `putJsonSnapshot`, `listSnapshots`, `getSnapshotStream`.
- `runIngest()` y `runTradingCycle()` suben, al final de cada corrida, un snapshot JSON **best-effort** (no rompe la corrida si MinIO falla, ver `snapshotKey: string | null` en `IngestSummary`/`TradingCycleResult`): `ingest/<ts>.json` (`{generatedAt, watchlist, macroSeries, bars, news, fundamentals, macroObservations, quotes}`) y `trading/<ts>.json` (`{generatedAt, account, signals, actions}`). `<ts> = new Date().toISOString().replace(/[:.]/g, '-')`.
- `server.ts` expone `GET /api/snapshots` (lista hasta 30, ingesta+trading mezclados) y `GET /api/snapshots/download?key=...` (valida `^(ingest|trading)/[A-Za-z0-9_\-:.]+\.json$` contra path traversal). Sección "Snapshots (MinIO)" en `public/` (tabla con descarga).
- Backup de PostgreSQL a MinIO (`pg_dump`) queda diferido - requiere su propia decisión de scheduling (cron), fuera de esta fase.

## Comandos

`npm run build` (tsc) · `npm run dev` (diagnóstico) · `npm run ingest` · `npm run trade` · `npm run web:start` / `web:stop` / `status` (dashboard, scripts/, NUNCA systemd).

## Pendientes conocidos / diferidos

- Grafana: paneles `timeseries` con `fieldConfig.defaults.custom` (v2, ambos dashboards) siguen sin mostrar datos visualmente en el iframe embebido. El usuario lo marcó como "para un punto futuro" - no es bloqueante.
- Orden de compra LÍMITE puede no ejecutarse si el precio nunca toca `estimatedEntryPrice` en la sesión (`time_in_force: 'day'`).
