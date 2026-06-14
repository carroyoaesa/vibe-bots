# CLAUDE.md - contexto denso para Claude Code

Este archivo se carga automáticamente en cada sesión. Objetivo: que tras una auto-compactación no se pierdan reglas operativas críticas ni el estado actual del proyecto. Para detalle completo ver `README.md` (usuarios) y `AGENTS.md` (agentes IA en general).

## Qué es este proyecto

Bot de trading en TypeScript/Node.js (CommonJS, ES2020, `strict: true`) corriendo en una instancia LXD con servicios **nativos** (no Docker): PostgreSQL, Redis, MinIO, Grafana, todos vía systemd con autostart. Directorio de trabajo: `/root/bots/vibe-bots`. Repo: `github.com/carroyoaesa/vibe-bots`, branch `main`.

Fases: 1 (ingesta ✅), 1.5 (dashboard web ✅), 2 (estrategia + ejecución paper ✅), 3 (snapshots MinIO ✅), 4 (backtesting ✅ + capa de IA con Claude ✅ activa desde 2026-06-14, `ANTHROPIC_API_KEY` configurada), 5 (configuración dinámica: perfil de riesgo + modelo Claude + precios IA-verificados, vía `bot_settings` ✅).

## Reglas operativas críticas (NO romper sin pedir confirmación explícita)

1. **`src/server.ts` (dashboard web) NUNCA va como servicio systemd.** Se gestiona solo con `./scripts/start-web.sh`, `./scripts/stop-web.sh`, `./scripts/status.sh` (nohup + PID en `run/web.pid`, logs en `logs/web.log`). Decisión deliberada del usuario, repetida más de una vez.
2. **`runTradingCycle()` (`npm run trade`, `POST /api/trading/run`, botón "Ejecutar ciclo de trading") coloca/cierra órdenes REALES en la cuenta PAPER de Alpaca.** No hay modo dry-run separado, aunque desde 2026-06-14 el interruptor ON/OFF del dashboard (`bot_settings.trading_enabled`, default `true`) se le acerca: en `false`, bloquea TODAS las compras/ventas (`TRADING_DISABLED`) sin afectar el cálculo de señales/evaluaciones de IA - ver "Configuración dinámica (Fase 5)". Cualquier cambio a `tradingRunner.ts`, `strategy/config.ts`, `strategy/signals.ts` o `bot_settings` (Fase 5) es un cambio de comportamiento de trading real (en paper). **Desde 2026-06-14 corre automáticamente vía cron** (`npm run trade:cron`, ver "Automatización (cron)" más abajo) cada hora durante el horario de mercado - no es necesario ejecutarlo manualmente salvo pedido explícito. **Desde Fase 4**, `runTradingCycle()` también corre una fase de evaluación con Claude que puede vetar señales BUY (`AI_BLOCKED`) y, desde Fase 5, puede ajustar `estimatedEntryPrice`/`estimatedExitPrice` (acotado a ±10%) - ver "Capa de IA (Claude, Fase 4/5)" y "Configuración dinámica (Fase 5)" más abajo. `ANTHROPIC_API_KEY` está configurada (desde 2026-06-14): la fase de IA corre normalmente. Sigue siendo **fail-open**: si la llamada a Claude falla por cualquier motivo, esa fase se omite (warning logueado) y el ciclo continúa con el perfil de riesgo/modelo de `bot_settings` y los precios algorítmicos.
3. **Push a `main` en GitHub requiere confirmación explícita del usuario en cada ocasión** (no asumir autorización previa).
4. **No instalar paquetes apt a nivel de sistema** (p.ej. `playwright install-deps`) sin pedido explícito - se considera modificación significativa de infraestructura compartida.
5. Secretos en `secure/keys.env` (o `.env` local), nunca en el repo. Credenciales de Git van vía `~/.git-credentials` (credential helper), no en `secure/keys.env` ni en la URL del remoto.
6. Si se edita `/etc/grafana/grafana.ini` (fuera del repo), restaurar `chown root:grafana` y `chmod 640` después.

## Mapa del repo

- `src/index.ts`, `src/check-runner.ts`, `src/diagnostics.ts` - 10 health checks (`npm run dev`, `GET /api/health`), incluyendo `anthropic` (Fase 4, ✅ desde que se configuró `ANTHROPIC_API_KEY`).
- `src/ingest.ts`, `src/ingestRunner.ts` - ingesta Fase 1 (`npm run ingest`, `POST /api/ingest`).
- `src/watchlist.ts` - **fuente única de verdad**: `WATCHLIST` (20 símbolos), `ETF_SYMBOLS` (11, subconjunto de WATCHLIST), `MACRO_SERIES`, `BARS_LOOKBACK_DAYS=220`.
- `src/strategy/` - lógica pura, sin I/O:
  - `indicators.ts`: `sma`, `rsi`, `momentum`, `smaSeries`, `rsiSeries`, `estimateEntryPrice`.
  - `signals.ts`: `computeSignal(symbol, closes, riskProfile = RISK_PROFILE) -> SignalResult`.
  - `config.ts`: `STRATEGY_PARAMS` (SMA 10/30, RSI14, umbral 70, momentum 10), `RiskProfile` (tipo), `RISK_PROFILE` (perfil "moderado": 10% equity/posición, SL -3%/TP +6%, máx 5 posiciones) y `RISK_PROFILE_PRESETS` (conservador/moderado/agresivo) - **desde Fase 5, solo defaults/semillas**; la fuente de verdad en runtime es `bot_settings`.
  - `chart.ts`: `buildChartSeries(bars)` para `/api/trading/chart/:symbol`.
- `src/services/` - I/O: `alpaca.ts`, `marketData.ts`, `marketStore.ts`, `tradingStore.ts`, `backtestStore.ts`, `settingsStore.ts` (Fase 5, `bot_settings`), `claude.ts`, `db.ts`, `cache.ts`, `storage.ts`, `fmp.ts`, `finnhub.ts`, `alphaVantage.ts`, `fred.ts`.
- `src/strategy/backtest.ts` - `runBacktest(symbol, bars) -> BacktestResult`, lógica pura (Fase 4).
- `src/backtestRunner.ts`, `src/backtest.ts` - `runBacktestForWatchlist(pool)` + CLI (`npm run backtest`, Fase 4).
- `src/backfillHistory.ts` - CLI opcional (`npm run backfill-history`, Fase 4, no corrido aún).
- `src/tradingRunner.ts` - `runTradingCycle()`, lógica compartida CLI/web. Desde Fase 4 incluye la fase de evaluación IA (Claude) que puede vetar BUYs.
- `src/server.ts` - Express, puerto `WEB_PORT` (4000). Sirve `public/` + `/api/*`.
- `public/` - frontend estático (`index.html`, `app.js`, `styles.css`), Chart.js v4 vía CDN.
- `grafana/dashboards/*.json` - dashboards provisionados vía API (`admin:admin`).
- `scripts/` - `start-web.sh`, `stop-web.sh`, `status.sh`.

## Watchlist (20 símbolos, `src/watchlist.ts`)

- **ETFs (11)**: `SPY, SCHE, SCHF, XLP, XLU, XMMO, VUG, SCHD, SPMO, QQQM, SOXQ`.
- **Acciones (9)**: `AAPL, MSFT, NVDA, REG, TOL, AMZN, TSM, GOOGL, MS`.
- El dashboard agrupa cada símbolo (señal, gráfico, evaluación de IA y backtest) en la sección "Resumen por símbolo", con sub-secciones ETFs/Acciones ordenadas por `attractivenessScore` (en `public/app.js`).
- Reducido desde 28 símbolos (2026-06-14) tras un análisis de backtests/correlación/liquidez: se quitaron `NECB, DBEZ, PPA, AVGO, MU, AGM` por baja probabilidad de retorno con la estrategia actual (sin señales, micro-caps ilíquidos, o volatilidad diaria que supera el SL fijo del 3%); luego `QQQ` (duplicado casi perfecto de `QQQM`, r=0.999, comisión más alta: 0.20% vs 0.15%) y `SCHG` (duplicado casi perfecto de `VUG`, r=0.993, comisión más alta: 0.04% vs 0.03%).

## Modelo de precios de la estrategia (estado actual)

- `estimatedEntryPrice` (`SignalResult`): nivel de cierre que haría que SMA10 (próxima sesión) alcance la SMA30 actual. `null` si histórico insuficiente.
- `estimatedExitPrice` (`SignalResult`): `estimatedEntryPrice * (1 + riskProfile.takeProfitPct)` (`riskProfile` = `bot_settings`, Fase 5; default `RISK_PROFILE`). `null` si `estimatedEntryPrice` es `null`.
- **Fase 5**: en `runTradingCycle`, antes de `saveSignal`, si la fase de IA propuso `adjustedEntryPrice`/`adjustedExitPrice` y ambos quedan dentro de ±10% del valor algorítmico (y `adjustedExit > adjustedEntry`), se sobrescriben `signal.estimatedEntryPrice`/`estimatedExitPrice` con esos valores (`applyPriceAdjustment` en `tradingRunner.ts`). Si no, se mantienen los algorítmicos.
- En `runTradingCycle`, BUY coloca una **bracket order LÍMITE** (`type: 'limit'`, `limit_price = estimatedEntryPrice`), con `take_profit.limit_price = estimatedExitPrice` y `stop_loss.stop_price = estimatedEntryPrice * (1 - riskProfile.stopLossPct)` - ya reflejando el ajuste de IA si aplicó. La cantidad (`qty`) se sigue calculando sobre `equity * riskProfile.positionSizePct / signal.price` (precio de mercado actual).
- Ambos precios se muestran en las tablas del dashboard ("Precio est. entrada" / "Precio est. salida") y como líneas horizontales punteadas en los gráficos por símbolo (amarillo = entrada, violeta = salida). `GET /api/trading/status` muestra el último valor persistido en `trading_signals` (= verificado/ajustado por IA en el ciclo más reciente), con fallback al recién calculado si no hay fila aún.

## DB - columnas relevantes en `trading_signals`

`symbol, ts, price, sma_fast, sma_slow, rsi, momentum, estimated_entry_price, estimated_exit_price, signal, reason`. Migraciones vía `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` en `setupTradingSchema` (`tradingStore.ts`), ejecutado al inicio de `runTradingCycle()` pero NO por `GET /api/trading/status` - si agregás una columna nueva, asegurate de que ya exista en la DB (correr `npm run trade` una vez, o `ALTER TABLE` manual) antes de que ese endpoint la consulte.

## `/api/trading/status` (importante para no romper)

Recalcula señales **frescas** (no cacheadas) para los 20 símbolos vía `getCloses` + `computeSignal`, etiquetando cada una con `type: 'ETF' | 'STOCK'` según `ETF_SYMBOLS`. `getLatestSignals` (`tradingStore.ts`) existe pero ya no se usa desde aquí (queda como helper histórico).

`account`/`positions` vienen de Redis vía `getCachedOrFetch` (`alpaca:account` TTL 45s, `alpaca:positions` TTL 30s, `src/services/cache.ts`) - si no hay caché, se piden a Alpaca y se cachean. `openOrdersCount`/`openOrdersAt` se leen **solo** de `alpaca:open-orders` (TTL ~70min, sin fetch propio); valen `null` si `runTradingCycle()` no corrió desde el último reinicio de Redis. Esto es puramente para no repetir llamadas a Alpaca en el polling de 60s del dashboard - **nunca** se usa para decisiones de trading (`runTradingCycle()` siempre pide datos frescos).

## Caché en Redis (2026-06-14)

`src/services/cache.ts`: `getCachedJson`/`setCachedJson`/`getCachedOrFetch` (JSON + `cachedAt`, TTL vía `EX`). Usos:
- `quote:<SYMBOL>` (TTL 5min, `npm run ingest`, sin cambios).
- `health:<id>` para los checks de `runDiagnostics()` que llaman APIs externas (`market-data`/`finnhub` 5min, `fmp` 10min, `fred` 30min, `anthropic` 10min, **`alpha-vantage` 2h** - su free tier es 25 req/día y sin esto el polling de 60s de `/api/health` lo agotaba en ~25min). Si hay hit, NO se llama a la API y el resultado trae `cached: true`/`cachedAt`; los fallos no se cachean (se reintenta en el próximo poll). `postgres`/`redis`/`minio` nunca se cachean.
- `alpaca:account`/`alpaca:positions`/`alpaca:open-orders` - ver bullet de `/api/trading/status` arriba. `alpaca:account` se comparte entre el check `alpaca` de `/api/health` y `/api/trading/status` (misma clave/TTL).

## Backtesting (Fase 4)

- `src/strategy/backtest.ts` (`runBacktest(symbol, bars)`, lógica pura): simula la estrategia real - misma regla de entrada límite `min(estimatedEntryPrice, price)`, TP +6%/SL -3%, fill al día siguiente vía `low <= entryPrice` - sobre el histórico de `market_bars` de un símbolo, en % de retorno (sin equity/cash compartido ni cap de 5 posiciones - eso sería v2).
- `src/backtestRunner.ts` (`runBacktestForWatchlist(pool)`) + `src/backtest.ts` (CLI, `npm run backtest`): corre el backtest para los 20 símbolos, agrega métricas de portafolio (nº trades, retorno promedio, win rate promedio, mejor/peor símbolo) y persiste en `backtest_runs`/`backtest_trades` vía `src/services/backtestStore.ts`.
- `backtest_runs` (`id, run_at, symbols, start_date, end_date, params JSONB, summary JSONB`) y `backtest_trades` (`id, run_id` FK -> `backtest_runs`, `symbol, entry_date, entry_price, exit_date, exit_price, exit_reason, pnl_pct`).
- `POST /api/backtesting/run` (ejecuta y persiste) / `GET /api/backtesting/results` (última corrida con trades). Integrado en la sección "Resumen por símbolo" del dashboard (botón "Ejecutar backtest", período cubierto, resumen de portafolio y, por símbolo, bloque "Backtest" con trades/win rate/retorno/drawdown).
- `npm run backfill-history` (opcional, no corrido aún): `src/backfillHistory.ts` extiende `market_bars` de ~150 a `BACKFILL_DAYS=1095` velas vía `getDailyBars`+`saveDailyBars` (upsert), para backtests con más historia. No toca `BARS_LOOKBACK_DAYS=220` de la ingesta diaria.

## Capa de IA (Claude, Fase 4/5)

- `ANTHROPIC_API_KEY` (requerida) + `ANTHROPIC_MODEL` (opcional, default `claude-haiku-4-5-20251001`) en `secure/keys.env` - `loadAnthropicConfig()` (`src/config.ts`), lanza si falta la key. **Configurada desde 2026-06-14**: el check `anthropic` (#10) está ✅ y la fase de IA corre en cada ciclo.
- `src/services/claude.ts`: `createAnthropicClient(config)` (axios, `https://api.anthropic.com`, headers `x-api-key` + `anthropic-version: 2023-06-01`). `assessWatchlist(client, model, contexts, macro)` - UNA llamada a `/v1/messages` por ciclo, `tool_choice` forzado a `record_assessments`, cubre los 20 símbolos. `model` viene de `bot_settings.claude_model` (Fase 5, si no es `NULL`) o de `loadAnthropicConfig().model` (default Haiku 4.5). `contexts` (`SymbolAssessmentContext[]`) incluye `estimatedEntryPrice`/`estimatedExitPrice` algorítmicos (Fase 5). Devuelve `SymbolAssessment[]`: `{symbol, score (-1..1), recommendation: 'buy'|'hold'|'avoid', confidence (0..1), rationale, adjustedEntryPrice, adjustedExitPrice}` (los dos últimos opcionales, Fase 5). `verifyAnthropic(client, model)` = ping mínimo, usado por el check `anthropic` (#10) en `src/diagnostics.ts` (sigue usando `loadAnthropicConfig().model`, no el override de `bot_settings`). `CLAUDE_MODEL_OPTIONS` = lista curada de 3 modelos para el selector del dashboard (Haiku 4.5 / Sonnet 4.6 / Opus 4.8).
- **Gate en `runTradingCycle()`** (`src/tradingRunner.ts`, dos pasadas + fase IA intermedia): la IA **solo puede vetar** una señal BUY que ya pasó los chequeos de posición/orden pendiente/máx. posiciones. Si `assessment.recommendation === 'avoid'`, la acción es `{ type: 'AI_BLOCKED', symbol, reason: rationale }` (`src/trade.ts` la imprime como `🤖🚫`) en vez de `placeBracketBuyOrder`. Nunca crea compras ni toca SELL/HOLD.
- **Ajuste de precios (Fase 5)**: ver "Configuración dinámica (Fase 5)" más abajo - `applyPriceAdjustment` (`tradingRunner.ts`) acota `adjustedEntryPrice`/`adjustedExitPrice` a ±10% del valor algorítmico antes de aplicarlos a `signal.estimatedEntryPrice`/`estimatedExitPrice`.
- **Fail-open**: la fase IA está envuelta en try/catch; si `loadAnthropicConfig()` lanza o falla la llamada a Claude, se loguea `Fase de IA (Claude) omitida en este ciclo: ...` y `assessments = new Map()` - el ciclo sigue con el perfil de riesgo/modelo de `bot_settings` y los precios algorítmicos (sin `ai_assessments`, sin `AI_BLOCKED`, sin ajuste de precios).
- `ai_assessments` (tabla independiente, sin FK): `symbol, ts, score, recommendation, confidence, rationale, model, adjusted_entry_price, adjusted_exit_price` (las dos últimas, Fase 5, son las propuestas *crudas* de Claude antes del recorte ±10%). `getLatestAssessments(pool)` (`DISTINCT ON (symbol)`) alimenta `GET /api/assessments`, integrado en la sección "Resumen por símbolo" del dashboard (bloque "Evaluación de IA" por símbolo: score/recomendación/confianza/"Ajuste entrada"/"Ajuste salida"/justificación, refresco cada 60s). El snapshot `trading/<ts>.json` en MinIO ahora incluye `assessments`.

## Configuración dinámica (Fase 5)

- `bot_settings` (tabla singleton, `id=1`, `CHECK (id = 1)`): `risk_preset, position_size_pct, stop_loss_pct, take_profit_pct, max_positions, claude_model, trading_enabled, updated_at`. `src/services/settingsStore.ts`: `setupSettingsSchema(pool)` (crea + siembra con los valores "moderado" de `RISK_PROFILE` - 10/3/6/5 -, `claude_model = NULL`, y agrega `trading_enabled BOOLEAN NOT NULL DEFAULT TRUE` vía `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), `getSettings(pool) -> BotSettings` (incluye `tradingEnabled`), `saveSettings(pool, settings)` (no toca `trading_enabled`), `setTradingEnabled(pool, enabled)`. Leída **sin caché** al inicio de `runTradingCycle()`, `runBacktestForWatchlist()`, `GET /api/trading/status` y `GET /api/settings`.
- **Interruptor ON/OFF de órdenes a Alpaca** (header del dashboard, `POST /api/settings/trading-enabled` con `{ enabled: boolean }`): en `false`, `tradingRunner.ts` reemplaza la rama BUY/SELL por `{ type: 'TRADING_DISABLED', symbol }` para cualquier señal no-HOLD (bloquea compra y venta), pero pasada 1 (señales) y la fase de IA/`saveSignal`/`saveAssessment` corren igual - el dashboard sigue actualizado. Default `true` (= comportamiento histórico sin cambios).
- `RISK_PROFILE_PRESETS` (`strategy/config.ts`, posición%/SL%/TP%/máx. posiciones): **Conservador** 5/2/4/3, **Moderado** 10/3/6/5 (= default histórico, sin cambios), **Agresivo** 15/5/10/8. "Personalizado" = los 4 campos editados a mano en el dashboard, sin atarse a un preset.
- Selector de modelo Claude: `CLAUDE_MODEL_OPTIONS` (`src/services/claude.ts`) - **lista curada sin texto libre**: `claude-haiku-4-5-20251001` (Haiku 4.5), `claude-sonnet-4-6` (Sonnet 4.6), `claude-opus-4-8` (Opus 4.8). `bot_settings.claude_model = NULL` → usa el default de `loadAnthropicConfig()` (Haiku 4.5); una vez guardado desde el dashboard siempre queda en uno de los 3 IDs curados.
- Límite de ajuste de precios IA: **±10%** del valor algorítmico (`applyPriceAdjustment` en `tradingRunner.ts`). Si Claude propone `adjustedEntryPrice`/`adjustedExitPrice` fuera de ese rango (o no propone nada), se descarta y se usa el valor algorítmico; si ambos ajustes son válidos y `adjustedExit > adjustedEntry`, se aplican a `signal.estimatedEntryPrice`/`estimatedExitPrice` **antes** de `saveSignal` (afecta también la bracket order BUY).
- `GET /api/settings` → `{ ok, settings: BotSettings, presets: RISK_PROFILE_PRESETS, models: CLAUDE_MODEL_OPTIONS }`. `POST /api/settings` valida `riskPreset` (∈ `conservador|moderado|agresivo|personalizado`), `riskProfile` (`positionSizePct` ∈ (0,1], `stopLossPct` ∈ (0,1), `takeProfitPct` ∈ (0,2), `maxPositions` entero ∈ [1,20]) y `claudeModel` (∈ `CLAUDE_MODEL_OPTIONS` o `null`); `400` con mensaje en español si algo no valida, si no `saveSettings` + `{ ok: true, savedAt }`.
- Dashboard: sección "Configuración" (entre "Ingesta de datos" y "Resumen por símbolo"), con preset de riesgo + 4 campos numéricos editables (editar cualquiera cambia el preset a "Personalizado") y selector de modelo Claude. Cambios aplican desde el próximo ciclo de trading/backtest, sin reiniciar el dashboard ni el bot (nunca systemd, regla 1). El interruptor ON/OFF de órdenes a Alpaca vive aparte, en el header (aplica de inmediato, no requiere "Guardar").
- ⚠️ Cambia comportamiento de trading real (regla 2): el perfil de riesgo activo, el modelo de IA y los precios de entrada/TP de las bracket orders BUY ya no son constantes de compilación - se leen de `bot_settings` en cada ciclo.

## Snapshots en MinIO (Fase 3)

- `src/services/storage.ts`: además del health-check, expone `putJsonSnapshot`, `listSnapshots`, `getSnapshotStream`.
- `runIngest()` y `runTradingCycle()` suben, al final de cada corrida, un snapshot JSON **best-effort** (no rompe la corrida si MinIO falla, ver `snapshotKey: string | null` en `IngestSummary`/`TradingCycleResult`): `ingest/<ts>.json` (`{generatedAt, watchlist, macroSeries, bars, news, fundamentals, macroObservations, quotes}`) y `trading/<ts>.json` (`{generatedAt, account, signals, actions}`). `<ts> = new Date().toISOString().replace(/[:.]/g, '-')`.
- `server.ts` expone `GET /api/snapshots` (lista hasta 30, ingesta+trading mezclados) y `GET /api/snapshots/download?key=...` (valida `^(ingest|trading)/[A-Za-z0-9_\-:.]+\.json$` contra path traversal). Sección "Snapshots (MinIO)" en `public/` (tabla con descarga).
- Backup de PostgreSQL a MinIO (`pg_dump`) queda diferido - requiere su propia decisión de scheduling (cron), fuera de esta fase.

## Comandos

`npm run build` (tsc) · `npm run dev` (diagnóstico) · `npm run ingest` · `npm run trade` · `npm run trade:cron` (wrapper cron-safe, ver abajo) · `npm run backtest` (Fase 4) · `npm run backfill-history` (opcional, Fase 4, no corrido aún) · `npm run web:start` / `web:stop` / `status` (dashboard, scripts/, NUNCA systemd).

## Automatización (cron, desde 2026-06-14)

- `src/cronTrade.ts` (`npm run trade:cron`) llama a `getMarketClock` (`GET /v2/clock` de Alpaca, `src/services/alpaca.ts`) y solo ejecuta `runTradingCycle()` si `isOpen`; si el mercado está cerrado, loguea `nextOpen` y sale 0 (no-op, seguro para cron).
- **Crontab de `root`** (fuera del repo, no versionado - revisar con `crontab -l` tras una auto-compactación):
  - Ciclo de trading: `0 13-21 * * 1-5 cd /root/bots/vibe-bots && /usr/bin/npm run trade:cron >> logs/trade-cron.log 2>&1` (cada hora en punto, 13-21 UTC = cubre 9:30-16:00 ET en EST y EDT; `/v2/clock` filtra fuera de sesión/feriados/fines de semana).
  - Ingesta diaria: `0 22 * * 1-5 cd /root/bots/vibe-bots && /usr/bin/npm run ingest >> logs/ingest-cron.log 2>&1` (22:00 UTC, después del cierre en EST y EDT).
- Cadencia horaria es deliberada: la estrategia opera sobre cierres **diarios** (`market_bars`, refrescados 1x/día por la ingesta), así que las señales no cambian intra-día; las corridas horarias re-sincronizan posiciones/órdenes y re-evalúan SELL con equity actualizado. Para más frecuencia, cambiar `0 13-21` por `*/30 13-21` en el crontab.
- Logs en `logs/trade-cron.log` / `logs/ingest-cron.log` (gitignored).

## Pendientes conocidos / diferidos

- Grafana: paneles `timeseries` con `fieldConfig.defaults.custom` (v2, ambos dashboards) siguen sin mostrar datos visualmente. El iframe de "Vibe Bots - Overview" se quitó del dashboard web (2026-06-14); Grafana en sí sigue corriendo igual, se revisará en un punto futuro - no es bloqueante.
- Orden de compra LÍMITE puede no ejecutarse si el precio nunca toca `estimatedEntryPrice` en la sesión (`time_in_force: 'day'`).
- Fase 4 - capa de IA (Claude): activa desde 2026-06-14 (`ANTHROPIC_API_KEY` en `secure/keys.env`, ver "Capa de IA (Claude, Fase 4/5)"). Verificar periódicamente que el check `anthropic` siga ✅ y que `ai_assessments`/`AI_BLOCKED` sigan apareciendo cuando corresponda.
- `npm run backfill-history` (Fase 4) está disponible pero no se ha corrido - `npm run backtest` usa por ahora solo el histórico de ~150 velas de la ingesta normal.
