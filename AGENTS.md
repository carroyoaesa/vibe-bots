# Instrucciones para agentes IA

Este proyecto contiene un bot inicial construido en TypeScript.

> Si estás usando Claude Code, ver también `CLAUDE.md` (contexto denso auto-cargado, reglas operativas críticas y estado actual de la estrategia/precios).

## Qué debe saber el asistente

- Proyecto de bot para uso con GitHub Copilot y Anthropic Claude.
- Stack: Node.js + TypeScript.
- El código principal está en `src/index.ts`.
- Usa `npm install`, `npm run build`, `npm start`, `npm run dev`, `npm run ingest`, `npm run trade`, `npm run trade:cron`, `npm run web`, `npm run backtest`, `npm run backfill-history`.

## Convenciones

- Mantener `src/` como fuente principal del código.
- Guardar las claves de la app (Alpaca, PostgreSQL, Redis, MinIO, FMP, Finnhub, Alpha Vantage, FRED) en `secure/keys.env` o en variables de entorno, nunca en el repositorio.
- Las credenciales de Git/GitHub NO van en `secure/keys.env` ni en la URL del remoto: usar el credential helper de git (`~/.git-credentials`, configurado con `git config --global credential.helper store`).
- `ANTHROPIC_API_KEY` (requerida, configurada desde 2026-06-14) y `ANTHROPIC_MODEL` (opcional, default `claude-haiku-4-5-20251001`) habilitan la capa de IA (Fase 4/5, ver más abajo). Si la llamada a Claude falla por cualquier motivo, esa fase se omite sola (fail-open) sin romper nada. Desde Fase 5, `bot_settings.claude_model` puede sobrescribir el modelo usado en `assessWatchlist()` (lista curada, `CLAUDE_MODEL_OPTIONS`).
- Evitar dependencias innecesarias fuera de `devDependencies` para comenzar.
- Documentar cualquier API externa o clave en `README.md`.

## Desarrollo asistido

- Generar funciones de bot en `src/` con comentarios claros.
- Crear tests y casos de uso antes de agregar nuevas funciones.
- Añadir cada nueva integración de API con `README.md` y `AGENTS.md`.

## Integraciones de API externas (datos para decisiones de trading)

Además de Alpaca (trading + market data), el proyecto integra:

- **Financial Modeling Prep (FMP)** (`src/services/fmp.ts`): fundamentales/perfil de empresa vía `/stable/profile`. El endpoint legacy `/api/v3/profile` está deprecado para keys nuevas (post agosto 2025).
- **Finnhub** (`src/services/finnhub.ts`): quotes en tiempo real (`/quote`), usado en `npm run ingest` para cachear precios en Redis (ver "Caché en Redis").
- **Alpha Vantage** (`src/services/alphaVantage.ts`): `GLOBAL_QUOTE` y potencialmente noticias/sentimiento. Free tier ~25 requests/día: **no usar en loops sobre el watchlist ni en jobs recurrentes**, solo en diagnóstico o consultas puntuales.
- **FRED** (`src/services/fred.ts`): series macroeconómicas (`FEDFUNDS`, `CPIAUCSL`, `UNRATE`), sin límites prácticos.

Cada cliente tiene una función `verifyX()` que se ejecuta en `npm run dev` (`src/index.ts`) como chequeo de salud. La ingesta de datos para el watchlist vive en `src/ingest.ts` y persiste en PostgreSQL vía `src/services/marketStore.ts`.

## Dashboard web (Fase 1.5)

- `src/diagnostics.ts`: lista compartida de health checks (`DIAGNOSTIC_CHECKS` + `runDiagnostics()`). Es la fuente única de verdad para `npm run dev` (`src/index.ts`) y para `GET /api/health`. Si se agrega una nueva integración, su `verifyX()` debe registrarse aquí, no directamente en `index.ts`. Los checks que llaman APIs externas (`alpaca`, `market-data`, `fmp`, `finnhub`, `alpha-vantage`, `fred`, `anthropic`) declaran `cacheKey`/`cacheTtlSeconds` y `runDiagnostics()` los sirve desde Redis si hay hit (ver "Caché en Redis") - si agregás un check nuevo que llame una API externa con cuota limitada, dale `cacheKey`/`cacheTtlSeconds` siguiendo el mismo patrón.
- `src/ingestRunner.ts`: lógica de `runIngest()` (antes en `src/ingest.ts`). `src/ingest.ts` es ahora un wrapper CLI delgado; `POST /api/ingest` llama a la misma función.
- `src/server.ts`: servidor Express (`npm run web`, puerto `WEB_PORT`/4000) que sirve `public/` (frontend estático) y expone `/api/health`, `/api/config`, `/api/ingest`, `/api/trading/status`, `/api/trading/chart/:symbol`, `/api/trading/run`, `/api/backtesting/run`, `/api/backtesting/results`, `/api/assessments`, `/api/settings` (Fase 5, GET/POST), `/api/settings/trading-enabled` (POST), `/api/snapshots`, `/api/snapshots/download`.
- `public/`: frontend estático (HTML/CSS/JS sin build step, Chart.js v4 vía CDN) - tarjetas de salud, interruptor ON/OFF de órdenes a Alpaca (header), botón de ingesta, sección "Configuración" y sección "Resumen por símbolo" (sub-secciones ETFs/Acciones, una tarjeta por símbolo con señal + gráfico + evaluación de IA + backtest, ordenadas por `attractivenessScore`, terminando con posiciones abiertas y órdenes ejecutadas).
- Grafana ya no está embebido en el dashboard web (iframe quitado del frontend, 2026-06-14); Grafana en sí sigue corriendo igual (ver README sección "Grafana"). `GRAFANA_PUBLIC_URL` queda configurado pero sin uso desde `public/`.
- Cambios en `/etc/grafana/grafana.ini` (p.ej. `allow_embedding`) son a nivel de sistema y NO están en este repo. Si se edita ese archivo, restaurar `chown root:grafana` y `chmod 640` después, o `grafana-server` no podrá leerlo.
- El dashboard web **no** corre como servicio systemd (decisión deliberada del usuario, ver README "Levantar/parar el dashboard web"). Se gestiona con `npm run web:start` / `npm run web:stop` / `npm run status` (scripts en `scripts/`, nohup + PID file). No crear una unidad systemd para `src/server.ts` sin pedirlo explícitamente de nuevo.

## Caché en Redis (2026-06-14)

`src/services/cache.ts`: `getCachedJson<T>`/`setCachedJson<T>`/`getCachedOrFetch<T>` - JSON + `cachedAt` (timestamp ISO) con TTL vía `EX`. Tres usos:

1. **Quotes de Finnhub** (`quote:<SYMBOL>`, TTL 5min): sin cambios, escritas por `runIngest()`.
2. **Health checks externos** (`health:market-data`/`health:finnhub` TTL 5min, `health:fmp` 10min, `health:fred` 30min, `health:anthropic` 10min, `health:alpha-vantage` **2h**): ver bullet de `runDiagnostics()` arriba. La clave del check `alpaca` es `ALPACA_ACCOUNT_CACHE_KEY` (= `alpaca:account`), compartida con (3).
3. **Estado de Alpaca** (`ALPACA_ACCOUNT_CACHE_KEY`/`alpaca:account` TTL 45s, `ALPACA_POSITIONS_CACHE_KEY`/`alpaca:positions` TTL 30s, `ALPACA_OPEN_ORDERS_CACHE_KEY`/`alpaca:open-orders` TTL ~70min, constantes en `cache.ts`): `GET /api/trading/status` usa `getCachedOrFetch` para cuenta/posiciones (pide a Alpaca solo si no hay caché) y lee `alpaca:open-orders` solo de caché (sin fetch propio) para `openOrdersCount`/`openOrdersAt` (`null` si nunca corrió `runTradingCycle()`). `runTradingCycle()` SIEMPRE pide los tres a Alpaca frescos para decidir (la caché no se lee ahí) y los reescribe en Redis al final del fetch, vía `Promise.all(...).catch(...)` (best-effort, no rompe el ciclo si Redis falla).

**Importante**: esta caché es solo para reducir llamadas desde el polling de 60s del dashboard (`/api/health` + `/api/trading/status`). Ningún dato de trading se decide a partir de valores cacheados.

## Trading automatizado (Fase 2, paper)

- `src/watchlist.ts`: fuente única de verdad para `WATCHLIST` (20 símbolos: 11 ETFs en `ETF_SYMBOLS` + 9 acciones), `MACRO_SERIES` y `BARS_LOOKBACK_DAYS` (220 días, para tener suficiente histórico para SMA30+RSI14). Usado por `src/ingestRunner.ts`, la estrategia y `/api/trading/status` (clasifica cada símbolo como `ETF`/`STOCK`).
- `src/strategy/`: lógica pura (sin I/O) de la estrategia.
  - `indicators.ts`: `sma()`, `rsi()`, `momentum()`, `smaSeries()`, `rsiSeries()`, `estimateEntryPrice()`.
  - `signals.ts`: `computeSignal(symbol, closes, riskProfile = RISK_PROFILE)` -> `SignalResult` con `BUY`/`SELL`/`HOLD` (cruce SMA10/SMA30 confirmado con RSI<70 y momentum>0 para BUY), más `estimatedEntryPrice` y `estimatedExitPrice` (= `estimatedEntryPrice * (1 + riskProfile.takeProfitPct)`).
  - `config.ts`: `STRATEGY_PARAMS` (periodos de SMA/RSI/momentum), `RiskProfile` (tipo) y `RISK_PROFILE` (perfil moderado: 10% equity por posición, SL -3%/TP +6%, máx. 5 posiciones) + `RISK_PROFILE_PRESETS` (conservador/moderado/agresivo) - **desde Fase 5, solo defaults/semillas de `bot_settings`** (ver "Configuración dinámica (Fase 5)" más abajo).
  - `chart.ts`: `buildChartSeries(bars)` - serie de cierre + SMA10/SMA30/RSI para `/api/trading/chart/:symbol`.
- `src/services/tradingStore.ts`: tablas `trading_signals` (incluye `estimated_entry_price`, `estimated_exit_price`) y `trading_orders` (creadas/migradas por `setupTradingSchema` vía `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), helpers `saveSignal`, `saveOrder`, `getRecentOrders`. `getLatestSignals` sigue existiendo pero ya no la usa `server.ts` (que ahora recalcula señales frescas para todo el watchlist).
- `src/services/alpaca.ts`: además de `verifyAlpaca`/`getAccount`, expone `getPositions`, `getOpenOrders`, `placeBracketBuyOrder` (orden **límite** con `limitPrice`, `takeProfitPrice`, `stopLossPrice`), `cancelOrder`, `closePosition`. `getAccount`/`getPositions`/`getOpenOrders` no cachean nada por sí mismas - es `runTradingCycle()` quien, tras llamarlas, escribe los resultados en Redis (ver "Caché en Redis") para que `GET /api/trading/status` los reutilice sin pegarle a Alpaca de nuevo.
- `src/tradingRunner.ts`: `runTradingCycle()` - orquesta señales + riesgo + ejecución para todo el watchlist. Es la lógica compartida entre `src/trade.ts` (CLI, `npm run trade`) y `POST /api/trading/run`. En BUY, coloca la bracket order límite al `estimatedEntryPrice` (con fallback a `signal.price` si es `null`), con TP/SL relativos a ese precio.
- ⚠️ **`runTradingCycle()` coloca/cierra órdenes reales (bracket orders) en la cuenta PAPER de Alpaca.** No hay un modo "dry-run" separado en esta fase - el entorno paper de Alpaca ya cumple ese rol (aunque desde 2026-06-14 `bot_settings.trading_enabled = false` se le acerca: bloquea todas las compras/ventas vía `TRADING_DISABLED`, sin afectar señales/IA - ver "Configuración dinámica (Fase 5)"). Cualquier cambio a `tradingRunner.ts`, `strategy/config.ts` (perfil de riesgo), `strategy/signals.ts` o `bot_settings` (Fase 5 - perfil de riesgo/modelo Claude en runtime) debe tenerse en cuenta como un cambio de comportamiento de trading real (en paper).
- `grafana/dashboards/vibe-trading.json` (uid `vibe-bots-trading`): historial de señales, precio/RSI por símbolo y órdenes recientes. Se publica igual que `vibe-overview.json` (`POST /api/dashboards/db` con `admin:admin`). Los paneles `timeseries` tienen `fieldConfig.defaults.custom` (v2) pero la verificación visual queda pendiente (diferido a pedido del usuario).

### Automatización (cron, desde 2026-06-14)

- `src/cronTrade.ts` (`npm run trade:cron`): wrapper cron-safe sobre `runTradingCycle()`. Llama a `getMarketClock` (`GET /v2/clock` en `src/services/alpaca.ts`) y solo ejecuta el ciclo si `isOpen === true`; si el mercado está cerrado, loguea `nextOpen` y sale con código 0 sin hacer nada.
- Crontab de `root` (fuera del repo, **no versionado** - revisar con `crontab -l`):
  - `0 13-21 * * 1-5 cd /root/bots/vibe-bots && /usr/bin/npm run trade:cron >> logs/trade-cron.log 2>&1` - ciclo de trading cada hora en punto, ventana UTC amplia (13-21) que cubre 9:30-16:00 ET en EST y EDT; `getMarketClock` filtra fuera de sesión/feriados/fines de semana.
  - `0 22 * * 1-5 cd /root/bots/vibe-bots && /usr/bin/npm run ingest >> logs/ingest-cron.log 2>&1` - ingesta diaria post-cierre.
- La cadencia horaria es deliberada: la estrategia opera sobre cierres diarios (`market_bars`), por lo que las señales no cambian intra-día; las corridas horarias re-sincronizan posiciones/órdenes y re-evalúan SELL. Logs en `logs/trade-cron.log` / `logs/ingest-cron.log` (gitignored).

## Capa de IA (Claude) - Fase 4/5

`runTradingCycle()` incluye una fase adicional de evaluación con Claude que actúa como **gate de solo veto** sobre señales BUY (nunca crea compras ni afecta SELL/HOLD) y, desde Fase 5, puede proponer ajustes acotados a `estimatedEntryPrice`/`estimatedExitPrice`.

- `src/config.ts`: `loadAnthropicConfig()` lee `ANTHROPIC_API_KEY` (requerida, lanza si falta) y `ANTHROPIC_MODEL` (opcional, default `claude-haiku-4-5-20251001`). **Configurada desde 2026-06-14.**
- `src/services/claude.ts`: `createAnthropicClient(config)` (axios, `https://api.anthropic.com`, headers `x-api-key` + `anthropic-version: 2023-06-01`). `assessWatchlist(client, model, contexts, macro)` hace UNA llamada a `POST /v1/messages` por ciclo, con `tool_choice` forzado a la tool `record_assessments`, cubriendo los 20 símbolos del watchlist con el contexto (señal técnica + `estimatedEntryPrice`/`estimatedExitPrice` algorítmicos, fundamentales FMP, últimas 5 noticias, macro FRED). `model` viene de `bot_settings.claude_model` (Fase 5, si no es `NULL`) o de `loadAnthropicConfig().model`. Devuelve `SymbolAssessment[]`: `{symbol, score (-1..1), recommendation: 'buy'|'hold'|'avoid', confidence (0..1), rationale, adjustedEntryPrice, adjustedExitPrice}` (las últimas dos, Fase 5, opcionales - `null` si Claude no propuso nada). `verifyAnthropic(client, model)` es un ping mínimo para el diagnóstico (usa `loadAnthropicConfig().model`, no el override de `bot_settings`). `CLAUDE_MODEL_OPTIONS`: lista curada de 3 modelos (Haiku 4.5 / Sonnet 4.6 / Opus 4.8) para el selector del dashboard.
- `src/diagnostics.ts`: check `anthropic` (#10, mismo patrón que `alpha-vantage`/`fmp`) - ✅ desde que se configuró `ANTHROPIC_API_KEY`.
- `src/tradingRunner.ts` - `runTradingCycle()` reestructurado en pasada 1 (señales técnicas frescas para todo el watchlist, con `riskProfile = settings.riskProfile`) + fase IA (try/catch fail-open: si `loadAnthropicConfig()` lanza o falla la llamada, se loguea un warning y `assessments = new Map()`, sin más efectos) + pasada 2 (ajuste de precios + persistencia + ejecución). En pasada 2, una señal BUY que ya pasó los chequeos de posición/orden pendiente/máx. posiciones se bloquea si `assessments.get(symbol)?.recommendation === 'avoid'`, generando `{ type: 'AI_BLOCKED', symbol, reason: rationale }` (impreso como `🤖🚫` en `src/trade.ts`) en vez de `placeBracketBuyOrder`. **Fase 5**: antes de eso, `applyPriceAdjustment` aplica (si corresponde) `adjustedEntryPrice`/`adjustedExitPrice` a `signal.estimatedEntryPrice`/`estimatedExitPrice` - ver "Configuración dinámica (Fase 5)".
- `src/services/tradingStore.ts`: tabla `ai_assessments` (independiente, sin FK): `symbol, ts, score, recommendation, confidence, rationale, model, adjusted_entry_price, adjusted_exit_price` (las dos últimas, Fase 5, son las propuestas crudas de Claude antes del recorte ±10%). `saveAssessment(pool, a)` (una fila por símbolo y ciclo donde corrió la fase IA) y `getLatestAssessments(pool)` (`DISTINCT ON (symbol)`).
- `server.ts` expone `GET /api/assessments` (última evaluación por símbolo), integrado en la sección "Resumen por símbolo" del dashboard (bloque "Evaluación de IA" por símbolo: fecha/score/recomendación/confianza/ajuste entrada/ajuste salida/justificación, refresco cada 60s).
- El snapshot `trading/<ts>.json` en MinIO ahora incluye también `assessments: SymbolAssessment[]`.
- **Fail-open por diseño**: si la llamada a Claude falla por cualquier motivo, todo lo anterior corre sin romper nada - `npm run trade` completa normalmente con el perfil de riesgo/precios algorítmicos de `bot_settings`, `assessments` queda vacío, no se escribe `ai_assessments` y nunca aparece `AI_BLOCKED`.

## Configuración dinámica (Fase 5)

- `bot_settings` (tabla singleton, `id=1`, `CHECK (id = 1)`): `risk_preset, position_size_pct, stop_loss_pct, take_profit_pct, max_positions, claude_model, trading_enabled, updated_at`. `src/services/settingsStore.ts`: `setupSettingsSchema(pool)` (crea + siembra con los valores "moderado" de `RISK_PROFILE` - 10/3/6/5 -, `claude_model = NULL` y agrega `trading_enabled BOOLEAN NOT NULL DEFAULT TRUE` vía `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), `getSettings(pool) -> BotSettings` (incluye `tradingEnabled`), `saveSettings(pool, settings)` (no toca `trading_enabled`), `setTradingEnabled(pool, enabled)`. Leída **sin caché** al inicio de `runTradingCycle()`, `runBacktestForWatchlist()`, `GET /api/trading/status` y `GET /api/settings`.
- **Interruptor ON/OFF de órdenes a Alpaca** (`trading_enabled`, default `true`): `POST /api/settings/trading-enabled` (body `{ enabled: boolean }`) → `setTradingEnabled`. En `tradingRunner.ts`, si `!settings.tradingEnabled && signal.signal !== 'HOLD'`, la acción es `{ type: 'TRADING_DISABLED', symbol }` (impresa como `⏸️` en `src/trade.ts`) en vez de colocar/cancelar/cerrar órdenes - bloquea BUY y SELL por igual. Pasada 1 (señales) y la fase de IA (incluido `saveSignal`/`saveAssessment`) corren igual que con el interruptor en ON.
- `RISK_PROFILE_PRESETS` (`strategy/config.ts`, posición%/SL%/TP%/máx. posiciones): **Conservador** 5/2/4/3, **Moderado** 10/3/6/5 (= default histórico, sin cambios), **Agresivo** 15/5/10/8. "Personalizado" = los 4 campos editados a mano en el dashboard.
- Selector de modelo Claude: `CLAUDE_MODEL_OPTIONS` (`src/services/claude.ts`) - **lista curada sin texto libre**: `claude-haiku-4-5-20251001` (Haiku 4.5), `claude-sonnet-4-6` (Sonnet 4.6), `claude-opus-4-8` (Opus 4.8). `bot_settings.claude_model = NULL` → usa el default de `loadAnthropicConfig()` (Haiku 4.5); una vez guardado desde el dashboard siempre queda en uno de los 3 IDs curados.
- Límite de ajuste de precios IA: **±10%** del valor algorítmico (`applyPriceAdjustment` en `tradingRunner.ts`). Si Claude propone `adjustedEntryPrice`/`adjustedExitPrice` fuera de ese rango (o no propone nada), se descarta y se usa el valor algorítmico; si ambos ajustes son válidos y `adjustedExit > adjustedEntry`, se aplican a `signal.estimatedEntryPrice`/`estimatedExitPrice` **antes** de `saveSignal` (afecta también la bracket order BUY).
- `GET /api/settings` → `{ ok, settings: BotSettings, presets: RISK_PROFILE_PRESETS, models: CLAUDE_MODEL_OPTIONS }`. `POST /api/settings` valida `riskPreset` (∈ `conservador|moderado|agresivo|personalizado`), `riskProfile` (`positionSizePct` ∈ (0,1], `stopLossPct` ∈ (0,1), `takeProfitPct` ∈ (0,2), `maxPositions` entero ∈ [1,20]) y `claudeModel` (∈ `CLAUDE_MODEL_OPTIONS` o `null`); `400` con mensaje en español si algo no valida.
- Dashboard: sección "Configuración" (entre "Ingesta de datos" y "Resumen por símbolo"), con preset de riesgo + 4 campos numéricos editables (editar cualquiera cambia el preset a "Personalizado") y selector de modelo Claude. Cambios aplican desde el próximo ciclo de trading/backtest, sin reiniciar el dashboard ni el bot. El interruptor ON/OFF de órdenes a Alpaca vive aparte, en el header (aplica de inmediato, no requiere "Guardar").
- `src/strategy/signals.ts`/`backtest.ts`/`backtestRunner.ts` reciben `riskProfile: RiskProfile` como parámetro opcional (default `RISK_PROFILE`); `backtestRunner.ts` lo toma de `getSettings(pool).riskProfile` y lo persiste en `backtest_runs.params.risk`.

## Backtesting (`npm run backtest`) - Fase 4

- `src/strategy/backtest.ts` (lógica pura, sin I/O): `runBacktest(symbol, bars)` simula la estrategia real - misma regla de entrada límite `min(estimatedEntryPrice, price)`, TP +6%/SL -3%, fill al día siguiente vía `low <= entryPrice`, SL gana si TP/SL se tocan el mismo día, salida por señal SELL o `END_OF_DATA` - sobre el histórico (`getAllBars`) de un símbolo, en % de retorno (independiente por símbolo, sin equity/cash compartido ni cap de posiciones - eso sería v2).
- `src/backtestRunner.ts` (`runBacktestForWatchlist(pool)`) + `src/backtest.ts` (CLI, `npm run backtest`): corre el backtest para los 20 símbolos, agrega métricas de portafolio (nº trades, retorno promedio, win rate promedio, mejor/peor símbolo por retorno total) y persiste vía `src/services/backtestStore.ts`.
- `src/services/backtestStore.ts`: `setupBacktestSchema` crea `backtest_runs` (`id, run_at, symbols, start_date, end_date, params JSONB, summary JSONB`) y `backtest_trades` (`id, run_id` FK -> `backtest_runs`, `symbol, entry_date, entry_price, exit_date, exit_price, exit_reason, pnl_pct`). `saveBacktestRun`, `getLatestBacktestRun`.
- `server.ts` expone `POST /api/backtesting/run` (ejecuta y persiste) y `GET /api/backtesting/results` (última corrida con trades), integrado en la sección "Resumen por símbolo" del dashboard (período cubierto, resumen de portafolio, bloque "Backtest" por símbolo con trades/win rate/retorno/drawdown, botón "Ejecutar backtest").
- `src/backfillHistory.ts` (CLI opcional, `npm run backfill-history`, no corrido aún): extiende `market_bars` de ~150 a `BACKFILL_DAYS=1095` velas vía `getDailyBars`+`saveDailyBars` (upsert), para backtests con más historia. No afecta `BARS_LOOKBACK_DAYS=220` de la ingesta diaria.

## Snapshots en MinIO (Fase 3)

- `src/services/storage.ts`: además de `verifyStorage` (health-check), expone `putJsonSnapshot`, `listSnapshots`, `getSnapshotStream` para guardar/leer JSON en el bucket configurado (`MINIO_BUCKET`).
- `runIngest()` (`src/ingestRunner.ts`) y `runTradingCycle()` (`src/tradingRunner.ts`) suben, al final de cada corrida, un snapshot JSON crudo a `ingest/<ts>.json` / `trading/<ts>.json` (`<ts> = new Date().toISOString().replace(/[:.]/g, '-')`). La subida es best-effort: si MinIO falla, se loguea el error y `snapshotKey` queda `null`, sin afectar el resto de la corrida (Postgres/Redis/órdenes).
- `server.ts` expone `GET /api/snapshots` (lista hasta 30, ingesta+trading) y `GET /api/snapshots/download?key=...` (valida `^(ingest|trading)/[A-Za-z0-9_\-:.]+\.json$`). El dashboard (`public/`) tiene una sección "Snapshots (MinIO)" con tabla y enlaces de descarga.
- Backup periódico de PostgreSQL a MinIO (`pg_dump`) queda diferido a una fase/decisión separada (requiere scheduling propio).
