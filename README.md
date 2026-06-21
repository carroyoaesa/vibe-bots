# Vibe Bots

Proyecto de bot trader en TypeScript diseñado para correr en una instancia LXD con servicios nativos.

Estado actual: bot operativo de punta a punta - ingesta diaria de datos de mercado para 27 símbolos, estrategia **multi-condicional por símbolo con condiciones de compra y venta independientes** (cada símbolo opera con su propio combo ganador, de 1, 2 o 3 condiciones según el símbolo - Fases 6, 7 y 8) con un perfil de riesgo configurable (`bot_settings`), evaluación y ajuste de señales BUY por Claude (Anthropic, con experimento opcional de sesgo A/B/C/D y tracking de costo), ejecución automática de órdenes en modo `signal_only` (sin bracket TP/SL) en la cuenta paper de Alpaca (con un interruptor ON/OFF, clasificación manual por símbolo con bloqueo duro, y limpieza automática opcional de órdenes huérfanas), backtesting de la estrategia (global y segmentado por clasificación), snapshots en MinIO y un dashboard web con UI por pestañas (Resumen/Detalle/Backtest/Operaciones/Sistema) para monitoreo y configuración, con una capa responsive para uso desde teléfono/tablet. Ver "Flujo del bot" justo abajo para el recorrido completo, las secciones "Fase 7" a "Fase 11" para el detalle de cada evolución, y "Próximas fases (mejoras propuestas)" al final para ideas pendientes.

## Flujo del bot (de los datos a una orden en Alpaca)

Cada ciclo de trading (`npm run trade`, `npm run trade:cron` o `POST /api/trading/run`, todos vía `runTradingCycle()` en `src/tradingRunner.ts`) sigue estos pasos:

1. **Datos** (ingesta previa, `npm run ingest`): bars diarias, noticias, fundamentales y series macro de los 27 símbolos del watchlist (`src/watchlist.ts`) ya están en PostgreSQL (`market_bars`, `news_items`, `fundamentals_snapshots`, `macro_series`).
2. **Configuración activa**: `runTradingCycle()` lee en caliente `bot_settings` (`getSettings(pool)`) - perfil de riesgo (tamaño de posición, stop-loss, take-profit, máx. posiciones) y modelo de Claude a usar.
3. **Señal técnica** (`computeSignal()` en `src/strategy/signals.ts`): para cada símbolo, evalúa su **condición de compra** (`buyConditionId`) y su **condición de venta** (`sellConditionId`) por separado. La condición efectiva se resuelve con precedencia: primero `MULTI_CONDITION_OVERRIDES` (expresión de 2-3 condiciones, Fase 8 - cubre 26 de los 27 símbolos), si no hay override se usa el pick de 1 condición de `symbol_conditions` (Fase 7, asignado por `npm run backtest`), con fallback final a `sma_cross_10_30` para ambas. `signal = 'BUY'` si la condición de compra lo indica; `'SELL'` si la condición de venta lo indica; `'HOLD'` si ninguna. Determina también `estimatedEntryPrice`/`estimatedExitPrice` (este último usando el `takeProfitPct` del perfil de riesgo activo). SMA10/SMA30/RSI(14)/momentum se calculan siempre como contexto general, independientemente de las condiciones activas.
4. **Limpieza de órdenes huérfanas** (opcional, `cancelStaleOrders()` en `src/services/staleOrders.ts` - ver "Fase 11"): si `bot_settings.auto_cancel_stale_orders` está activo, cancela antes de evaluar BUY/SELL cualquier orden BUY pendiente con más de `pending_order_timeout_min` minutos abierta, o cuyo precio límite ya quedó por encima del precio que se colocaría hoy para ese símbolo. Si la señal sigue siendo BUY este ciclo, el flujo normal del paso 7 coloca una orden nueva al precio recalculado.
5. **Evaluación de IA** (`assessWatchlist()` en `src/services/claude.ts`, una sola llamada a Claude por ciclo - ver "Fase 11"): **solo para los símbolos con señal BUY técnica este ciclo y no bloqueados manualmente**; si ninguno califica, esta fase se omite por completo (costo $0). Para cada candidato, Claude recibe el contexto técnico + precios estimados + fundamentales + noticias + macro, y devuelve `recommendation` (`buy`/`hold`/`avoid`), `score`, `confidence`, `rationale` y, opcionalmente, `adjustedEntryPrice`/`adjustedExitPrice`. Si esta llamada falla por cualquier motivo, el ciclo continúa sin ella (fail-open). Cada llamada real a Claude se registra en `claude_usage_log` (tokens + costo estimado, ver "Fase 11").
6. **Ajuste de precios** (`applyPriceAdjustment()` en `src/tradingRunner.ts`): si Claude propuso precios ajustados y quedan dentro de ±10% del valor algorítmico (y `exit > entry`), sobrescriben `estimatedEntryPrice`/`estimatedExitPrice` antes de persistir la señal.
7. **Gate de IA**: una señal `BUY` que ya pasó el pre-trade check unificado (clasificación no bloqueada, sin posición/orden BUY pendiente, dentro del tope de exposición y de posiciones máximas - ver "Fase 10") se bloquea (`AI_BLOCKED`, sin colocar orden) si `recommendation === 'avoid'`. La IA nunca convierte HOLD/SELL en BUY ni toca señales SELL.
8. **Orden a Alpaca** (cuenta **paper** única - ver nota de "Fase 10" sobre multi-cuenta): si la señal `BUY` sobrevive el gate, se coloca una **orden límite simple** a `min(estimatedEntryPrice, precio actual)` (modo `signal_only` activo: sin bracket TP/SL). Una señal `SELL` con posición abierta cancela órdenes pendientes y cierra la posición a mercado. Si el interruptor "Órdenes a Alpaca" del dashboard está en OFF (`bot_settings.trading_enabled = false`), este paso se omite para cualquier señal BUY/SELL (`TRADING_DISABLED`) - los pasos anteriores (señales, IA, ajuste de precios) siguen corriendo igual.
9. **Persistencia y exposición**: la señal (`trading_signals`, etiquetada además con el `account_group` derivado de la clasificación manual del símbolo), la orden (`trading_orders`) y la evaluación de IA (`ai_assessments`) quedan en PostgreSQL; un snapshot JSON crudo del ciclo sube a MinIO (best-effort); todo se expone vía `GET /api/trading/status`, `GET /api/assessments`, `GET /api/operations` y el dashboard web (`npm run web`).

## Arquitectura actual

- `src/` - código fuente TypeScript
- `public/` - frontend estático del dashboard web (HTML/CSS/JS, sin build step; layout con tabs + capa responsive para teléfono/tablet, ver "Dashboard web")
- `package.json` - dependencias y scripts
- `tsconfig.json` - configuración TypeScript
- `CLAUDE.md` - contexto técnico denso para Claude Code (se carga automáticamente en cada sesión)
- `AGENTS.md` - contexto y reglas para agentes IA en general
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
- Express para el dashboard web (health checks, ingesta manual, interruptor ON/OFF de órdenes a Alpaca, clasificación manual por símbolo, configuración, operaciones multi-cuenta y backtesting)

## Comandos

- `npm install` - instalar dependencias Node
- `npm run build` - compilar TypeScript
- `npm start` - ejecutar el bot compilado
- `npm run dev` - ejecutar diagnóstico completo con `ts-node`
- `npm run ingest` - ejecutar la ingesta de datos de mercado
- `npm run trade` - ejecutar un ciclo de trading completo (paper): calcula señales, aplica el perfil de riesgo activo y coloca/cierra órdenes en Alpaca paper (límite simples en modo `signal_only`, activo en producción; bracket con TP/SL si el preset activo fuera `bracket`)
- `npm run trade:cron` - como `npm run trade`, pero primero consulta `/v2/clock` de Alpaca y no hace nada si el mercado está cerrado. Pensado para cron (ver "Automatización" más abajo).
- `npm run backtest` - corre las 144 combinaciones de condiciones (12 compra × 12 venta, Fase 7) sobre el histórico actual para los 27 símbolos del watchlist, elige el par ganador de cada símbolo y persiste el resultado en `symbol_conditions` (ver "Backtesting" y "Fase 7" más abajo). Es la corrida "legacy" (sin segmentar); ver "Fase 10" para la variante segmentada por clasificación (`POST /api/backtest/run?group=...`, solo vía dashboard/API, sin script propio todavía).
- `npm run backfill-history` - (opcional, una sola vez, no corrido aún) extiende el histórico diario de `market_bars` de ~150 a ~2100 días (~5.8 años) para backtests con más regímenes de mercado.
- `npm run backfill-1h` - (opcional, no corrido aún) descarga histórico de velas horarias (`market_bars` con `timeframe='1Hour'`) vía `src/backfillHourlyHistory.ts`. Alimenta el pick informativo 1H de `backtestRunner.ts` (ver nota en "Backtesting") - hoy no afecta señales/órdenes reales.
- `npm run web` - levantar el dashboard web en primer plano, en `http://0.0.0.0:4000`
- `npm run web:start` / `npm run web:stop` - levantar/detener el dashboard web en background (ver `scripts/`)
- `npm run status` - ver el estado de los servicios nativos (Postgres/Redis/MinIO) y del dashboard web

## Configuración local

1. Crea `secure/keys.env` con las variables necesarias.
2. Si no usas `secure/keys.env`, pon las mismas variables en un `.env` local.
3. El proyecto cargará automáticamente estas variables.

## Variables requeridas

```env
ALPACA_API_KEY=tu_api_key_aqui
ALPACA_API_SECRET=tu_api_secret_aqui
ALPACA_BASE_URL=https://paper-api.alpaca.markets

# Cuentas paper por grupo de clasificación (Fase 10, "Operaciones multi-cuenta") - solo para
# LECTURA de estado/posiciones/órdenes en el tab "Operaciones" (GET /api/operations,
# /api/account-status). Las órdenes reales del bot siguen yendo SIEMPRE a la cuenta de
# ALPACA_API_KEY/SECRET arriba - ver "Fase 10" más abajo. Si falta un grupo, su sync se omite
# (warning en logs) sin romper el resto del dashboard.
ALPACA_APTOS_KEY=
ALPACA_APTOS_SECRET=
ALPACA_APTOS_ENDPOINT=https://paper-api.alpaca.markets
ALPACA_OBSERVADOS_KEY=
ALPACA_OBSERVADOS_SECRET=
ALPACA_OBSERVADOS_ENDPOINT=https://paper-api.alpaca.markets
# ALPACA_BLOQUEADOS_KEY/_SECRET/_ENDPOINT - no configuradas hoy (ver "Próximas fases")

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

# Capa de IA (Claude): gate de señales BUY + ajuste de precios (fail-open si falla)
# El modelo usado en cada ciclo puede sobrescribirse vía bot_settings.claude_model
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-haiku-4-5-20251001

# Dashboard web
WEB_PORT=4000
```

## Diagnóstico (`npm run dev`)

`src/index.ts` ejecuta diez verificaciones independientes mediante `src/check-runner.ts`. Cada una corre de forma aislada: si una falla, las demás igual se ejecutan, y al final se muestra un resumen con el estado de cada servicio.

1. `src/services/alpaca.ts` - cliente Alpaca (Trading API) y verificación de cuenta.
2. `src/services/db.ts` - pool de PostgreSQL y verificación (crea/lee una fila de prueba).
3. `src/services/cache.ts` - cliente Redis y verificación (set/get de prueba).
4. `src/services/storage.ts` - cliente MinIO y verificación (bucket + objeto de prueba).
5. `src/services/marketData.ts` - cliente Alpaca Market Data API, verifica bars históricas y noticias.
6. `src/services/fmp.ts` - cliente Financial Modeling Prep, verifica perfil de empresa (`/stable/profile`).
7. `src/services/finnhub.ts` - cliente Finnhub, verifica quote en tiempo real.
8. `src/services/alphaVantage.ts` - cliente Alpha Vantage, verifica `GLOBAL_QUOTE`.
9. `src/services/fred.ts` - cliente FRED, verifica última observación de `FEDFUNDS`.
10. `src/services/claude.ts` - cliente Anthropic (Claude), ping mínimo a `/v1/messages`. ✅ desde que se configuró `ANTHROPIC_API_KEY` en `secure/keys.env` (2026-06-14); si faltara, fallaría (❌) sin afectar el resto del diagnóstico.

## Caché en Redis (`src/services/cache.ts`)

`getCachedJson`/`setCachedJson`/`getCachedOrFetch` guardan JSON + timestamp `cachedAt` con TTL (`EX`), para reducir llamadas repetidas a APIs externas - sobre todo las que dispara el polling de 60s del dashboard web (`/api/health` y `GET /api/trading/status`):

- **Quotes de Finnhub** (`quote:<SYMBOL>`, TTL 5 min): escritas por `npm run ingest` (ver sección "Ingesta de datos").
- **Chequeos de `runDiagnostics()`** (`/api/health` y `npm run dev`) que llaman a una API externa: `health:market-data`/`health:finnhub` (TTL 5 min), `health:fmp` (10 min), `health:fred` (30 min), `health:anthropic` (10 min), **`health:alpha-vantage` (2 h)**. Si hay valor en caché, NO se llama a la API externa y el resultado trae `cached: true` + `cachedAt`; si falla, no se cachea el error (se reintenta en el próximo poll). Los chequeos locales (postgres, redis, minio) nunca se cachean. El TTL de 2h en Alpha Vantage es clave: su free tier es de 25 requests/día y, sin caché, el polling de 60s del dashboard agotaba la cuota en ~25 minutos.
- **Estado de Alpaca** (`alpaca:account` TTL 45s, `alpaca:positions` TTL 30s, `alpaca:open-orders` TTL ~70 min): `runTradingCycle()` siempre pide cuenta/posiciones/órdenes abiertas FRESCAS a Alpaca para decidir (la caché nunca se usa para tomar decisiones de trading) y además las guarda en Redis. `GET /api/trading/status` reutiliza `alpaca:account`/`alpaca:positions` (o las pide y cachea si no hay valor) y lee `alpaca:open-orders` solo de caché (sin llamar a Alpaca), exponiendo `openOrdersCount`/`openOrdersAt` (`null` si todavía no corrió ningún ciclo de trading). `alpaca:account` se comparte con el chequeo "alpaca" de `/api/health` (mismo dato).

## Ingesta de datos (`npm run ingest`)

`src/ingest.ts` corre la ingesta inicial de datos de mercado para el watchlist (`src/watchlist.ts`) y la guarda en PostgreSQL (`src/services/marketStore.ts` crea las tablas si no existen):

- **Watchlist** (27 símbolos, `WATCHLIST` en `src/watchlist.ts`): 12 ETFs (`ETF_SYMBOLS`: `SPY, SCHE, SCHF, XLP, XLU, XMMO, VUG, SCHD, SPMO, QQQM, SOXQ, SCHG`) + 15 acciones (`AAPL, MSFT, NVDA, REG, TOL, AMZN, TSM, GOOGL, MS, AVGO, HD, LOW, MAIN, MU, SHW`). `ETF_SYMBOLS` es el subconjunto de `WATCHLIST` que el dashboard clasifica como "ETF"; el resto se clasifica como "Acciones". Lista reducida desde los 28 símbolos originales (ver historial de commits) a 20 (2026-06-14) tras un análisis de backtests/correlación/liquidez, quitando `NECB, DBEZ, PPA, AVGO, MU, AGM` por baja probabilidad de retorno con la estrategia actual, y luego `QQQ` por ser duplicado casi perfecto (r>=0.99) de `QQQM`, con comisión más alta (0.20% vs 0.15%). Ampliada de 20 a 27 (Fase 8, 2026-06-17): se reincorporaron `AVGO, HD, LOW, MAIN, MU, SCHG, SHW` - ver "Fase 8" más abajo para el detalle completo, incluyendo por qué `QQQ`, `GOLD`, `AGM`, `DBEZ`, `NECB` y `PPA` quedaron afuera.
- **`market_bars`**: bars diarias (`BARS_LOOKBACK_DAYS` = 220 días calendario, ~150 sesiones, suficiente para SMA30+RSI14 con margen) desde Alpaca Market Data API (feed IEX).
- **`news_items`**: noticias del watchlist desde Alpaca News API (Benzinga).
- **`fundamentals_snapshots`**: perfil/fundamentales por símbolo desde FMP (`JSONB`, un snapshot por corrida).
- **`macro_series`**: observaciones de FRED para `FEDFUNDS`, `CPIAUCSL`, `UNRATE`.

Además cachea en Redis el último quote de Finnhub por símbolo (`quote:<SYMBOL>`, TTL 5 min) para consumo rápido por el bot (ver sección "Caché en Redis").

> ⚠️ Alpha Vantage tiene un free tier muy limitado (~25 requests/día). Su cliente (`src/services/alphaVantage.ts`) está disponible y se prueba en el diagnóstico, pero **no** se usa en la ingesta recurrente para no agotar la cuota.

> ℹ️ El endpoint `/v2/stocks/bars` de Alpaca aplica el parámetro `limit` al **total de barras de la respuesta** (suma de todos los símbolos), no por símbolo. `getDailyBars` (`src/services/marketData.ts`) usa `limit: 10000` para evitar que, con 27 símbolos x ~150 sesiones (~4000 barras), el watchlist se trunque alfabéticamente y los últimos símbolos queden sin histórico suficiente para SMA30. También se pasa `adjustment: 'split'` para evitar discontinuidades de precio (y señales falsas en SMA/RSI/momentum) cuando un símbolo tiene un split dentro de la ventana de lookback.

## Trading automatizado (`npm run trade`, paper)

`src/trade.ts` (CLI) y `src/tradingRunner.ts` (lógica compartida, también usada por `POST /api/trading/run`) ejecutan un ciclo completo de trading sobre el watchlist, **operando contra la cuenta paper de Alpaca** (`ALPACA_BASE_URL=https://paper-api.alpaca.markets`).

### Estrategia (`src/strategy/`)

- **Indicadores** (`indicators.ts`): SMA, EMA, RSI (versión simplificada, sin suavizado de Wilder), MACD, Bandas de Bollinger, Estocástico, Williams %R, CCI, Canal de Donchian, momentum (% de retorno) y `estimateEntryPrice`.
- **Condiciones** (`conditions.ts`): catálogo de 12 condiciones clásicas de TA (`CONDITIONS`) + `buildIndicatorContext(bars)` + `computeEstimatedEntryPrice(ctx, i, conditionId)` - ver "Fase 7" más abajo para el catálogo completo y cómo se eligen por símbolo.
- **Parámetros** (`config.ts`, `STRATEGY_PARAMS`): SMA rápida = 10, SMA lenta = 30, RSI(14) con umbral de sobrecompra 70, momentum a 10 periodos - usados por la condición `sma_cross_10_30` (default/fallback).
- **Señales** (`signals.ts`, `computeSignal(symbol, bars, riskProfile, buyConditionId, sellConditionId)`) - cada `SignalResult` incluye:
  - `signal: 'BUY' | 'SELL' | 'HOLD'`: `'BUY'` si `buyCondition.evaluate(ctx, i) === 'BUY'`; `'SELL'` si `sellCondition.evaluate(ctx, i) === 'SELL'`; `'HOLD'` si ninguna (Fase 7, condiciones de compra y venta son independientes).
  - `reason` (Fase 6.1, enriquecido con valores): `` `${signal} por "${condition.label}" (${details})` `` (BUY/SELL) o `` `Sin señal (condición activa: "${condition.label}"; ${details})` `` cuando compra=venta, o `` `Sin señal (compra: "X"; venta: "Y")` `` cuando difieren. `details = condition.describe(ctx, i)` agrega los valores de indicador.
  - `buyConditionId`/`buyConditionLabel`/`sellConditionId`/`sellConditionLabel`: las condiciones evaluadas, para persistencia/exposición.
  - `smaFast`/`smaSlow`/`rsi`/`momentum` (SMA10/SMA30/RSI14/Momentum10): se calculan **siempre** como contexto general, independientemente de la condición activa.
  - **`estimatedEntryPrice`**: para `sma_cross_10_30`/`sma_cross_20_50`, precio de cierre que haría que la SMA rápida de la próxima sesión alcance la SMA lenta actual (`estimateEntryPrice` en `indicators.ts`); para las otras 10 condiciones, el cierre actual (`price`) - ver "Fase 7" para el detalle completo por condición.
  - **`estimatedExitPrice`**: `estimatedEntryPrice * (1 + riskProfile.takeProfitPct)` - precio objetivo de take-profit relativo a ese precio estimado de entrada (`riskProfile` viene de `bot_settings`, ver "Configuración dinámica" más abajo; default `RISK_PROFILE`). `null` cuando `estimatedEntryPrice` es `null` (histórico insuficiente, < 51 velas).
  - Antes de guardarse, ambos precios (`estimatedEntryPrice`/`estimatedExitPrice`) pueden ser ajustados por la fase de IA (Claude) dentro de un margen de ±10% - ver "Configuración dinámica (`bot_settings`)" y "Capa de IA (Claude)" más abajo.

### Gestión de riesgo (`bot_settings`)

El perfil de riesgo activo (`positionSizePct`, `stopLossPct`, `takeProfitPct`, `maxPositions`) se lee de la tabla `bot_settings` en cada ciclo - ver "Configuración dinámica (`bot_settings`)" más abajo. `RISK_PROFILE`/`RISK_PROFILE_PRESETS` (`strategy/config.ts`) son los valores por defecto/semilla con los que se siembra esa tabla. El perfil "moderado" (= valor por defecto, sin cambios respecto al diseño original) es:

- Tamaño de posición: 10% del equity de la cuenta por símbolo (calculado sobre el precio de mercado actual, `signal.price`).
- Stop-loss: -3% / Take-profit: +6% (ratio 2:1), calculados sobre `estimatedEntryPrice` (no sobre el precio de mercado actual), vía **bracket orders** de Alpaca (`order_class: 'bracket'`).
- Máximo 5 posiciones simultáneas (todo el watchlist).

### Ciclo de trading (`runTradingCycle`)

Para cada símbolo del watchlist: lee las últimas `BARS_LOOKBACK` (100) velas OHLC (`getRecentOhlcBars`), resuelve su condición técnica activa (`MULTI_CONDITION_OVERRIDES` con precedencia sobre `symbol_conditions`, fallback `sma_cross_10_30` - ver "Fase 7"/"Fase 8"), calcula la señal con esa condición y el perfil de riesgo activo (`bot_settings`), aplica el ajuste de precios de IA si corresponde y la persiste en `trading_signals` (etiquetada con el `account_group` derivado de la clasificación manual del símbolo - ver "Fase 10"), y según la señal:

- **BUY**: pasa por un **pre-trade check unificado** (`canPlaceBuyOrder()` en `src/services/preTradeCheck.ts`, cacheado 30s por `grupo+símbolo`) que evalúa, en orden fail-fast: clasificación manual `bloqueado` (`SYMBOL_BLOCKED_MANUAL`, bloqueo duro sin excepciones) → posición ya abierta (`POSITION_ALREADY_OPEN`) → orden BUY pendiente (`PENDING_BUY_ORDER`, filtra por lado para no confundir una SELL pendiente con una compra duplicada) → tope de exposición por símbolo (`EXPOSURE_LIMIT_EXCEEDED`, `equity * riskProfile.positionSizePct`) → máximo de posiciones abiertas (`MAX_POSITIONS_REACHED`). Si pasa los 5 checks, calcula la cantidad (`equity * riskProfile.positionSizePct / precio actual`, mínimo 1 acción) y coloca una **orden límite simple** (`placeBuyOrder`, `type: 'limit'`) a `min(estimatedEntryPrice, precio actual)` sin bracket TP/SL (modo `exit_mode = 'signal_only'` activo en `bot_settings`). Si `estimatedEntryPrice` no está disponible, usa el precio de mercado actual.
- **SELL**: si hay una posición abierta, cancela órdenes pendientes del símbolo y cierra la posición a mercado.
- **HOLD**: sin acción.

Cada orden ejecutada (o error) se registra en `trading_orders` (también con `account_group`), vinculada a la señal que la originó. La respuesta cruda de Alpaca (incluyendo el `limit_price` real enviado) queda en la columna `raw` (JSONB).

> ⚠️ La orden de compra es una orden **límite** (no a mercado), puede quedar pendiente sin ejecutarse si el precio de mercado nunca llega al precio de entrada calculado durante la sesión (`time_in_force: 'day'`). En modo `signal_only` la salida es únicamente por señal SELL de la `sellCondition` activa — no hay bracket TP/SL automático.

### Limpieza automática de órdenes BUY huérfanas/desalineadas (Fase 11)

Antes de evaluar BUY/SELL en cada ciclo, si `bot_settings.auto_cancel_stale_orders` está activo (default `false`), `findStaleOrders()`/`cancelStaleOrders()` (`src/services/staleOrders.ts`) cancelan una orden BUY pendiente si:

- lleva abierta más de `bot_settings.pending_order_timeout_min` minutos (default `60`), o
- el precio de entrada que se colocaría **hoy** para ese símbolo ya quedó por debajo del precio límite de la orden vieja (p.ej. una orden encolada fuera de horario cuyo límite quedó por encima del valor actual) - sin tolerancia mínima, cualquier diferencia cuenta.

Las órdenes canceladas se sacan de la lista de órdenes abiertas en memoria antes del pre-trade check normal, así que si la señal sigue siendo BUY este mismo ciclo, el flujo de la sección anterior coloca naturalmente una orden nueva al precio recalculado - no es un paso separado. Activable desde el dashboard (tab "Operaciones", `POST /api/settings/auto-cancel-stale-orders`); el timeout se muestra en esa misma sección pero **no es editable desde la UI todavía** (ver "Próximas fases").

### Automatización (cron)

`src/cronTrade.ts` (`npm run trade:cron`) consulta `GET /v2/clock` (`getMarketClock` en `src/services/alpaca.ts`) y solo llama a `runTradingCycle()` si el mercado está abierto; si está cerrado, loguea la próxima apertura y termina sin hacer nada (exit 0). El crontab de `root` (fuera del repo) tiene:

- **Ciclo de trading**: cada 5 minutos, 13:00-21:00 UTC, lunes a viernes (`*/5 13-21 * * 1-5`). Esa ventana cubre el horario de mercado de EE.UU. (9:30-16:00 ET) tanto en EST como en EDT con margen; el chequeo de `/v2/clock` filtra las horas fuera de sesión, fines de semana y feriados. Salida en `logs/trade-cron.log`.
- **Ingesta**: 3 veces al día, lunes a viernes (`0 12,16,22 * * 1-5`) - 12:00 UTC (pre-apertura: refresca noticias/fundamentales/macro antes del primer ciclo del día), 16:00 UTC (mediodía) y 22:00 UTC (post-cierre, bars 1D del día ya cerrado). Salida en `logs/ingest-cron.log`.
- **Watchdog del dashboard web**: cada 5 minutos, todos los días (`*/5 * * * *`). Llama a `scripts/start-web.sh`, que es idempotente (verifica PID y no hace nada si ya está corriendo); si el proceso cayó, lo reinicia automáticamente. Salida en `logs/watchdog.log`.

Las señales técnicas operan sobre cierres **diarios** (`market_bars`), por lo que no cambian entre una corrida y la siguiente dentro del mismo día - las corridas cada 5 min sirven principalmente para re-sincronizar posiciones/órdenes (p.ej. si una orden límite recién se ejecutó) y re-evaluar señales SELL con el equity actualizado. ⚠️ Con esta cadencia y sin un gate de "una vez por día" para la fase de IA (ver "Fase 11"), un símbolo con señal BUY persistente puede ser evaluado por Claude muchas veces el mismo día - ver el aviso de costo en "Fase 11" antes de asumir que el volumen de llamadas es bajo.

### Exposición vía API/web

- `GET /api/trading/status`: cuenta (equity/cash/buying power), posiciones abiertas, órdenes recientes y **señales recalculadas en el momento** (no cacheadas, usando el perfil de riesgo activo de `bot_settings`) para los 27 símbolos del watchlist, cada una etiquetada como `type: 'ETF' | 'STOCK'` según `ETF_SYMBOLS`. `estimatedEntryPrice`/`estimatedExitPrice` de cada señal se sobrescriben con el último valor persistido en `trading_signals` (= verificado/ajustado por IA en el ciclo más reciente), si existe. Esta es la fuente de datos de los tabs "Resumen"/"Detalle" del dashboard (cuenta única).
- `POST /api/trading/run`: antes de ejecutar nada, consulta `GET /v2/clock` (mismo guard que `cronTrade.ts`); si el mercado está cerrado, devuelve `{ ok: true, skipped: true, reason: 'MARKET_CLOSED', nextOpen }` sin tocar Alpaca. Si está abierto, ejecuta `runTradingCycle()` (misma lógica que `npm run trade`) - **coloca/cierra órdenes reales en la cuenta paper**.
- `GET /api/operations?account=<aptos|observados|bloqueados|all>` / `GET /api/account-status?account=...` / `POST /api/operations/sync?account=...`: estado/posiciones/órdenes por grupo de cuenta, ver "Fase 10" más abajo. Es la fuente de datos del tab "Operaciones".
- El frontend (`public/`) integra estos datos en los tabs "Resumen", "Detalle" y "Operaciones" del dashboard (ver "Dashboard web" más abajo) con un botón "Ejecutar ciclo de trading" que pide confirmación antes de llamar a `POST /api/trading/run`.

> ⚠️ Tanto `npm run trade` como el botón del dashboard y `POST /api/trading/run` colocan órdenes reales (con dinero simulado) en la cuenta **paper** de Alpaca, salvo que el mercado esté cerrado (ver guard arriba). No hay modo "solo simulación" adicional en esta fase: el "paper" de Alpaca ya es el entorno de prueba.

## Capa de IA (Claude)

`runTradingCycle()` incluye una fase adicional de evaluación con Claude (Anthropic) que actúa como **gate de solo veto** sobre señales BUY (nunca genera compras nuevas ni afecta señales SELL/HOLD) y puede proponer ajustes acotados a `estimatedEntryPrice`/`estimatedExitPrice`.

### Configuración

```env
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
```

`ANTHROPIC_API_KEY` es requerida para que esta fase corra (**configurada desde 2026-06-14**); `ANTHROPIC_MODEL` es opcional (default Claude Haiku 4.5, `claude-haiku-4-5-20251001`) y se usa para el diagnóstico (`verifyAnthropic`). `loadAnthropicConfig()` (`src/config.ts`) lanza si falta la key. El modelo usado en `assessWatchlist()` (la evaluación batched de cada ciclo) puede sobrescribirse vía `bot_settings.claude_model` - ver "Configuración dinámica (`bot_settings`)".

### Diseño: fail-open

Si falla la llamada a Claude por cualquier motivo (red, rate limit, respuesta inesperada, o si `loadAnthropicConfig()` lanza por falta de `ANTHROPIC_API_KEY`), la fase de IA se omite por completo: se loguea un warning (`Fase de IA (Claude) omitida en este ciclo: ...`) y `runTradingCycle()` continúa con el perfil de riesgo/modelo de `bot_settings` y los precios algorítmicos (sin filas nuevas en `ai_assessments`, sin acciones `AI_BLOCKED`, sin ajuste de precios).

### Evaluación batched (una llamada por ciclo, solo candidatos BUY)

`src/services/claude.ts` hace **a lo sumo una llamada** a `POST /v1/messages` por `runTradingCycle()`, con salida estructurada forzada (`tool_choice` → tool `record_assessments`) - desde la Fase de eficiencia (ver "Fase 11"), **solo cubre los símbolos con señal BUY técnica este ciclo y no bloqueados manualmente**, no los 27 del watchlist. Si ningún símbolo califica como candidato BUY, esta fase se omite por completo (costo $0 ese ciclo - no se llama a Claude). Para cada candidato, el prompt incluye la señal técnica recién calculada (precio, SMA10/SMA30, RSI, momentum), los precios estimados de entrada/salida algorítmicos, el último perfil fundamental (FMP), hasta 5 noticias recientes y el contexto macro (FRED). La respuesta es un array de:

- `symbol`
- `score` (-1 a 1)
- `recommendation`: `'buy' | 'hold' | 'avoid'`
- `confidence` (0 a 1)
- `rationale` (texto corto)
- `adjustedEntryPrice` / `adjustedExitPrice` (opcionales): propuesta de Claude para ajustar los precios estimados, si los considera poco razonables a la luz de fundamentales/noticias/macro. `null`/omitidos si Claude no propone nada.

### Gate sobre señales BUY

En la "pasada 2" de `runTradingCycle()`, una señal BUY que ya pasó el pre-trade check unificado (ver "Ciclo de trading" más arriba - clasificación, posición/orden pendiente, exposición, máximo de posiciones) se bloquea si `assessment.recommendation === 'avoid'`, generando una acción `{ type: 'AI_BLOCKED', symbol, reason: rationale }` (impresa como `🤖🚫` por `src/trade.ts`) en vez de colocar la orden. La IA **no** puede convertir un HOLD/SELL en BUY, ni bloquear/modificar un SELL.

### Ajuste de precios de entrada/salida

Antes de persistir la señal, si Claude propuso `adjustedEntryPrice`/`adjustedExitPrice`, `applyPriceAdjustment()` (`src/tradingRunner.ts`) los acota a **±10%** del valor algorítmico correspondiente; si la propuesta se sale de ese rango (o no hay propuesta), se mantiene el valor algorítmico. Si ambos ajustes quedan dentro del rango y `adjustedExitPrice > adjustedEntryPrice`, se sobrescriben `signal.estimatedEntryPrice`/`estimatedExitPrice` con esos valores **antes** de `saveSignal` - por lo que el valor mostrado en el dashboard, persistido en `trading_signals` y usado para la orden BUY (precio límite, y take-profit/stop-loss si el `exit_mode` activo fuera `'bracket'`) son consistentes y ya incorporan la verificación de Claude.

### Persistencia y exposición

- `ai_assessments` (tabla independiente, sin FK a `trading_signals`): `symbol, ts, score, recommendation, confidence, rationale, model, adjusted_entry_price, adjusted_exit_price`. Una fila por símbolo en cada ciclo donde la fase de IA corrió para ese símbolo (candidatos BUY, ver "Evaluación batched" arriba). Las dos últimas columnas son las propuestas *crudas* de Claude, antes del recorte ±10% - permiten ver en el dashboard si una propuesta fue descartada por estar fuera de rango.
- `GET /api/assessments` devuelve la última evaluación por símbolo (`getLatestAssessments`, `DISTINCT ON (symbol)`).
- Tab "Detalle" del dashboard: bloque "Evaluación de IA (Claude)" por símbolo con Score, Recomendación, Confianza, Ajuste entrada, Ajuste salida y Justificación. El tab "Resumen" muestra un badge compacto de la recomendación, con el dropdown de variantes A/B/C/D si el experimento corrió para ese símbolo (ver "Fase 11").
- El snapshot de trading en MinIO (`trading/<ts>.json`) ahora incluye también `assessments: SymbolAssessment[]`.
- `npm run dev` / `GET /api/health` incluyen un décimo check `anthropic` (`src/diagnostics.ts`) que hace un ping mínimo a Claude (ver "Diagnóstico" más arriba).

### Experimento de sesgo A/B/C/D (Fase 11, opcional)

Para medir si la evaluación de producción (variante "A") está sesgada por cómo se construye el prompt, `runTradingCycle()` puede correr 3 llamadas extra a Claude **por cada candidato BUY** (mismo filtro BUY-only de arriba), activable con `bot_settings.claude_experiment_enabled` (default `false` - no cambia comportamiento de trading, es solo medición):

- **A (control)**: no es una llamada extra - es la evaluación de producción ya obtenida (Fase de arriba), reusada tal cual.
- **B (sin señal técnica)**: mismo contexto que A (fundamentales/noticias/macro/precio) pero sin la condición técnica activa ni los precios estimados algorítmicos - para ver si Claude recomendaría "buy" igual sin saber que la estrategia ya disparó esa señal.
- **C (solo señal técnica)**: únicamente la condición técnica + precio, sin fundamentales/noticias/macro.
- **D (orden invertido)**: mismo contenido completo que A, con las secciones del prompt en orden inverso - para detectar sesgo de anclaje/orden en la respuesta.

Persistencia en `claude_gate_experiment` (`symbol, ts, variant, recommendation, score, confidence, rationale, model, tokens_used, cost_estimate_usd`); las 4 variantes de un símbolo en un ciclo comparten el mismo `ts` para poder cruzarlas. Endpoints: `GET /api/claude-experiment/summary?days=7` (resumen por variante), `GET /api/claude-experiment/disagreements?days=7` (casos donde A y B difieren), `GET /api/claude-experiment/cost?days=7` (costo incremental del experimento) y `GET /api/claude-experiment/latest?days=30` (última corrida por símbolo, consumida por el dropdown de variantes del tab "Resumen"). Toggle: `POST /api/settings/claude-experiment-enabled`.

### Visibilidad de costo (Fase 11)

Cada llamada real a `/v1/messages` (producción o experimento) se registra en `claude_usage_log` (`date, total_tokens, total_cost_usd, calls_count, calls_production, calls_experiment`, upsert diario en UTC) vía `recordClaudeUsage()`. El costo se estima con una tabla de precios oficiales por millón de tokens, hardcodeada en `src/services/claude.ts` (`CLAUDE_PRICING`, USD por millón de tokens input/output: Haiku 4.5 `1.0/5.0`, Sonnet 4.6 `3.0/15.0`, Opus 4.8 `5.0/25.0`) aplicada a los tokens reales devueltos por la API (`usage.input_tokens`/`usage.output_tokens`), nunca una cuota inventada. `GET /api/claude-usage?days=1` alimenta el banner "Claude hoy: $X · N llamadas" del header del dashboard (refresca cada 60s). Es **puramente informativo** - no hay ningún corte automático de llamadas por presupuesto; el control de gasto es manual (apagar el experimento, o en el límite, revocar `ANTHROPIC_API_KEY`).

## Configuración dinámica (`bot_settings`)

Perfil de riesgo, modelo de Claude y el límite de ajuste de precios de IA se leen en caliente (sin caché) desde la tabla `bot_settings`, editable desde el dashboard. Afecta a `runTradingCycle()`, `runBacktestForWatchlist()`/`runBacktestForGroup()` y `GET /api/trading/status`.

### `bot_settings` (tabla singleton)

`src/services/settingsStore.ts`:

- `setupSettingsSchema(pool)`: crea `bot_settings (id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1), risk_preset TEXT, position_size_pct NUMERIC, stop_loss_pct NUMERIC, take_profit_pct NUMERIC, max_positions INTEGER, claude_model TEXT, updated_at TIMESTAMPTZ)` si no existe, y agrega vía `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`: `trading_enabled BOOLEAN NOT NULL DEFAULT TRUE`, `exit_mode TEXT NOT NULL DEFAULT 'bracket'`, `pending_order_timeout_min INTEGER NOT NULL DEFAULT 60`, `auto_cancel_stale_orders BOOLEAN NOT NULL DEFAULT FALSE` y `claude_experiment_enabled BOOLEAN NOT NULL DEFAULT FALSE` (ver "Fase 11"). Siembra la única fila (`id = 1`) con el perfil "moderado" (10/3/6/5) y `claude_model = NULL` (= usa el default de `ANTHROPIC_MODEL`). El `exit_mode` activo en producción es `'signal_only'`.
- `getSettings(pool)` / `saveSettings(pool, settings)`: leen/escriben esa fila. `BotSettings = { riskPreset, riskProfile: { positionSizePct, stopLossPct, takeProfitPct, maxPositions }, claudeModel, tradingEnabled, exitMode, pendingOrderTimeoutMin, autoCancelStaleOrders, claudeExperimentEnabled }`. `saveSettings` solo escribe `riskPreset`/`riskProfile`/`claudeModel`/`exitMode` (no toca los demás flags, cada uno con su propio endpoint de toggle).
- `setTradingEnabled(pool, enabled)` / `setAutoCancelStaleOrders(pool, enabled)` / `setClaudeExperimentEnabled(pool, enabled)`: actualizan un flag booleano cada uno (usados por sus respectivos interruptores, ver más abajo).
- `RISK_PROFILE` / `RISK_PROFILE_PRESETS` (`src/strategy/config.ts`) son ahora solo **defaults/semillas**; la fuente de verdad en runtime es `bot_settings`.

### Presets de perfil de riesgo

| Preset | Posición (% equity) | Stop-loss | Take-profit | Máx. posiciones |
| --- | --- | --- | --- | --- |
| Conservador | 5% | -2% | +4% | 3 |
| Moderado (default histórico) | 10% | -3% | +6% | 5 |
| Agresivo | 15% | -5% | +10% | 8 |
| Personalizado | (los 4 valores se editan a mano) | | | |

### Selector de modelo de Claude

`CLAUDE_MODEL_OPTIONS` (`src/services/claude.ts`) - **lista curada, sin texto libre**:

- `claude-haiku-4-5-20251001` (Haiku 4.5, default si `bot_settings.claude_model = NULL`)
- `claude-sonnet-4-6` (Sonnet 4.6)
- `claude-opus-4-8` (Opus 4.8)

El modelo elegido se usa para `assessWatchlist()` (evaluación batched del ciclo de trading). El diagnóstico `anthropic` (`npm run dev` / `GET /api/health`) sigue usando `ANTHROPIC_MODEL`/`loadAnthropicConfig().model`, no este override.

### Endpoints `/api/settings`

- `GET /api/settings` → `{ ok, settings: BotSettings, presets: RISK_PROFILE_PRESETS, models: CLAUDE_MODEL_OPTIONS }` (`BotSettings` incluye `tradingEnabled`, `pendingOrderTimeoutMin`, `autoCancelStaleOrders`, `claudeExperimentEnabled`).
- `POST /api/settings` → valida `riskPreset` (∈ `conservador|moderado|agresivo|personalizado`), `riskProfile` (`positionSizePct` ∈ (0,1], `stopLossPct` ∈ (0,1), `takeProfitPct` ∈ (0,2), `maxPositions` entero ∈ [1,20]) y `claudeModel` (∈ `CLAUDE_MODEL_OPTIONS` o `null`); responde `400` con mensaje en español si algo no valida, o `{ ok: true, savedAt }` si guarda correctamente. No toca `trading_enabled`.
- `POST /api/settings/trading-enabled` → body `{ enabled: boolean }`; valida que `enabled` sea boolean (`400` si no), llama a `setTradingEnabled(pool, enabled)` y responde `{ ok: true, tradingEnabled: enabled, savedAt }`.
- `POST /api/settings/auto-cancel-stale-orders` → mismo patrón, controla la limpieza automática de órdenes huérfanas (ver "Fase 11").
- `POST /api/settings/claude-experiment-enabled` → mismo patrón, controla el experimento de sesgo A/B/C/D (ver "Fase 11").

### Interruptor ON/OFF de órdenes a Alpaca

En el header del dashboard, junto al título, hay un indicador ("Órdenes a Alpaca: ACTIVADAS"/"DESACTIVADAS") y un botón ("⏸ Desactivar"/"▶ Activar") que llaman a `POST /api/settings/trading-enabled` (con `window.confirm` antes de cada cambio, ya que afecta trading real en paper).

- **ON** (`trading_enabled = true`, default): comportamiento normal, sin cambios.
- **OFF** (`trading_enabled = false`): en `runTradingCycle()`, cualquier señal `BUY`/`SELL` que llegue a la "pasada 2" genera una acción `{ type: 'TRADING_DISABLED', symbol }` (impresa como `⏸️` por `src/trade.ts`) en vez de colocar/cancelar/cerrar órdenes en Alpaca. Las señales `HOLD` siguen generando `NO_ACTION` igual que siempre. El cálculo de señales (pasada 1), la fase de IA y `saveSignal`/`saveAssessment` **no se ven afectados** - el dashboard sigue mostrando datos frescos por símbolo aunque el bot esté en OFF.
- Pensado como el equivalente más cercano a un "dry-run": útil para pausar la colocación de órdenes (p.ej. mantenimiento, revisión manual de posiciones) sin perder visibilidad de señales/IA/backtesting.

### Sección "Configuración" del frontend

Ubicada en el tab "Sistema" del dashboard (ver "Dashboard web" más abajo), entre "Ingesta de datos" y "Experimentos". Incluye:

- Selector de preset de riesgo: Conservador/Moderado/Agresivo/Personalizado y **"Sin bracket (solo señal)"** (`exit_mode = 'signal_only'`, activo en producción) + 4 campos numéricos (tamaño de posición, stop-loss, take-profit, máx. posiciones). Elegir un preset rellena los 4 campos; editar cualquiera a mano cambia el preset a "Personalizado". En modo `signal_only`, los campos de SL/TP quedan deshabilitados.
- Selector de modelo de Claude (las 3 opciones curadas).
- Botón "💾 Guardar" (`POST /api/settings`).

El interruptor ON/OFF de órdenes a Alpaca vive aparte, en el header (ver arriba) - no requiere "Guardar" y aplica de inmediato.

Los cambios aplican desde el próximo ciclo de trading/backtest, sin reiniciar el dashboard ni el bot (el dashboard nunca corre como systemd, ver "Levantar/parar el dashboard web").

## Snapshots de ingesta y trading en MinIO

`src/services/storage.ts` expone, además del health-check, helpers para guardar y leer snapshots JSON en el bucket configurado (`MINIO_BUCKET`, por defecto `vibe-bots`):

- `putJsonSnapshot(client, config, key, data)` - sube `data` como JSON (crea el bucket si no existe).
- `listSnapshots(client, config, prefix)` - lista objetos bajo `prefix`, ordenados por fecha descendente.
- `getSnapshotStream(client, config, key)` - devuelve un stream legible con el contenido de un objeto.

Tanto `runIngest()` (`src/ingestRunner.ts`) como `runTradingCycle()` (`src/tradingRunner.ts`) suben, al final de cada corrida, un snapshot JSON con los datos crudos de esa corrida:

- **`ingest/<timestamp>.json`** (cada `npm run ingest` / `POST /api/ingest`): `{ generatedAt, watchlist, macroSeries, bars, news, fundamentals, macroObservations, quotes }` - el detalle completo de lo obtenido de Alpaca/FMP/FRED/Finnhub en esa corrida (no solo los conteos del resumen).
- **`trading/<timestamp>.json`** (cada `npm run trade` / `POST /api/trading/run`): `{ generatedAt, account, signals, actions }` - estado de cuenta, señales calculadas y acciones tomadas (o no) por símbolo.

`<timestamp>` es `new Date().toISOString().replace(/[:.]/g, '-')` (p.ej. `2026-06-14T12-36-20-486Z.json`).

La subida a MinIO es **best-effort**: si falla (p.ej. MinIO caído), se loguea el error y `snapshotKey` queda en `null` en el resultado (`IngestSummary.snapshotKey` / `TradingCycleResult.snapshotKey`), pero la ingesta o el ciclo de trading continúan normalmente (no se pierde lo ya guardado en PostgreSQL/Redis ni se interrumpe la colocación de órdenes).

> ℹ️ El backup periódico de PostgreSQL a MinIO (`pg_dump`) no está implementado - requiere su propia decisión de scheduling (cron); ver "Próximas fases" al final.

## Backtesting (`npm run backtest`)

`src/strategy/backtest.ts` (`runCombinedBacktest(symbol, bars, riskProfile, buyConditionId, sellConditionId, exitMode)`, lógica pura) simula la estrategia real para un par de condiciones dado (Fase 7) - mismas reglas de entrada límite (`min(estimatedEntryPrice, price)`), verificación de fill al día siguiente vía high/low diario, y salida según `exitMode`: con `'signal_only'` (activo), solo señal SELL de `sellCondition` o `END_OF_DATA`; con `'bracket'`, además TP/SL del perfil de riesgo - sobre el histórico de `market_bars` de cada símbolo, de forma independiente (% de retorno por símbolo, sin modelar equity/cash compartido ni el cap de posiciones - eso sería v2).

- `src/backtestRunner.ts` (`runBacktestForSymbols(pool, symbols, classificationGroup)`, núcleo compartido): para cada símbolo del universo recibido, corre `runCombinedBacktest` en las **144 combinaciones** (12 × 12) de `(buyConditionId, sellConditionId)` usando el `settings.exitMode` activo de `bot_settings`, elige el par ganador (mayor `totalReturnPct` entre los que tuvieron al menos 1 trade) y lo persiste en `symbol_conditions` con `buy_condition_id`/`sell_condition_id`; agrega métricas de portafolio y persiste el resto vía `src/services/backtestStore.ts`. Dos wrappers, mismo cálculo, distinto universo de símbolos (ver "Fase 10" para el detalle del segundo):
  - `runBacktestForWatchlist(pool)` - los 27 símbolos del watchlist completo, sin filtrar (`classification_group = null` en `backtest_runs`). Es la corrida "legacy".
  - `runBacktestForGroup(pool, group)` / `runBacktestForAllGroups(pool)` - acota el universo a los símbolos de un grupo de clasificación (`aptos`/`observados`/`bloqueados`), persistido con ese `classification_group`.
- `src/backtest.ts` (CLI, `npm run backtest` → `runBacktestForWatchlist`): imprime una tabla resumen por símbolo (trades, win rate, retorno total, retorno promedio, max drawdown) y el resumen de portafolio, y muestra el `runId` persistido.
- `backtest_runs` (`id, run_at, symbols, start_date, end_date, params JSONB, summary JSONB, classification_group TEXT`) y `backtest_trades` (`id, run_id` FK -> `backtest_runs`, `symbol, entry_date, entry_price, exit_date, exit_price, exit_reason, pnl_pct`) - creadas por `setupBacktestSchema`.
- `POST /api/backtesting/run` / `GET /api/backtesting/results` - corrida legacy (todo el watchlist), sin parámetro de grupo. `POST /api/backtest/run?group=<aptos|observados|bloqueados|all>` / `GET /api/backtest/results?group=...` - corrida segmentada (Fase 10); con `group=all` corre los 3 grupos secuencialmente. Ambos pares de endpoints coexisten (ver "Próximas fases" sobre si conviene deprecar el legacy). Tab "Backtest" del dashboard: período cubierto, tabla resumen por símbolo, resumen de portafolio, selector de grupo y botón "Ejecutar backtest".
- `npm run backfill-history` (opcional, una sola vez, no corrido aún): extiende `market_bars` diarias de ~150 a **2100 días** (~5.8 años, `BACKFILL_DAYS`) vía `getDailyBars` + `saveDailyBars` (upsert), para backtests con más historia. No afecta `BARS_LOOKBACK_DAYS=220` de la ingesta diaria normal.
- `npm run backfill-1h` (opcional, no corrido aún): histórico de velas horarias para los símbolos de `strategy/hybridConfig.ts#HYBRID_SYMBOLS`. `backtestRunner.ts` corre además, informativamente, el combo 1H de cada símbolo Tier 1 vía `HYBRID_CONFIG` (guardado como un pick adicional `timeframe='1Hour'` en `symbol_conditions`) - **no participa en el resumen de portafolio ni en las señales/órdenes reales de `runTradingCycle()`**, que hoy llama a `computeSignal` (1D) sin ninguna rama 1H (ver "Próximas fases").

## Fase 7: condición de compra y venta independientes por símbolo

Desde Fase 6, cada símbolo del watchlist opera con su propio par de condiciones técnicas elegido de un catálogo de 12. Desde **Fase 7**, las condiciones de **compra** (`buyConditionId`) y **venta** (`sellConditionId`) son independientes por símbolo: `npm run backtest` prueba las **144 combinaciones** (12 × 12) y elige el par de mayor retorno total. El par ganador se persiste en `symbol_conditions`; `runTradingCycle()` y `GET /api/trading/status` lo leen en caliente (sin caché), igual que `bot_settings`.

### Catálogo de 12 condiciones (`src/strategy/conditions.ts`)

| id | Condición | Tipo |
| --- | --- | --- |
| `sma_cross_10_30` | Cruce SMA10/SMA30 + RSI<70 + Momentum>0 (estrategia original de vibe-bots; **default/fallback**) | Tendencia |
| `sma_cross_20_50` | Golden/Death Cross SMA20/SMA50 | Tendencia |
| `ema_cross_12_26` | Cruce EMA12/EMA26 | Tendencia |
| `macd_cross` | Cruce MACD(12,26,9) / línea de señal | Momentum |
| `rsi_reversal_30_70` | RSI(14) sale de sobreventa (<30) / sobrecompra (>70) | Reversión |
| `bollinger_reversion` | Rebote desde banda inferior hacia la media (Bollinger 20,2) | Reversión |
| `bollinger_breakout` | Ruptura de banda superior (Bollinger 20,2) | Breakout |
| `stochastic_cross` | Cruce %K/%D del Estocástico(14,3) en zonas extremas | Reversión |
| `williams_r_reversal` | Williams %R(14) sale de zonas extremas (-80/-20) | Reversión |
| `cci_reversal` | CCI(20) sale de zonas extremas (±100) | Reversión |
| `donchian_breakout_20` | Ruptura de Canal de Donchian (máx. 20 / mín. 10) | Breakout |
| `trend_pullback_sma50` | Precio sobre SMA50 + pullback de RSI sobre 40 | Tendencia+pullback |

`buildIndicatorContext(bars: OhlcBar[])` calcula todos los indicadores necesarios para las 12 condiciones (SMA10/20/30/50, EMA12/26, RSI14, MACD+señal, Bandas de Bollinger 20±2, Estocástico %K/%D, Williams %R, CCI20, canal de Donchian máx20/mín10, momentum10) a partir de `OhlcBar = {ts, open, high, low, close}`; cada `Condition` de `CONDITIONS` implementa `evaluate(ctx, i): 'BUY' | 'SELL' | 'HOLD'`. Estas funciones fueron portadas con el mismo comportamiento desde `/root/bots/backtests` (proyecto separado, solo lectura, usado para la investigación inicial de condiciones).

### `symbol_conditions` (tabla, `src/services/conditionStore.ts`)

Columnas: `symbol` (PK), `timeframe, buy_condition_id, buy_condition_label, sell_condition_id, sell_condition_label, trades, win_rate_pct, total_return_pct, avg_return_pct, max_drawdown_pct, updated_at`. Una fila por símbolo del watchlist con el par ganador (compra + venta) y las métricas del backtest que lo eligió.

- **Cómo se calcula/persiste**: `npm run backtest` corre `runCombinedBacktest(symbol, bars, riskProfile, buyConditionId, sellConditionId, exitMode)` para las 144 combinaciones (12 × 12) de cada símbolo, elige el par de mayor `totalReturnPct` entre los que tuvieron al menos 1 trade (si ninguno operó, usa `sma_cross_10_30`/`sma_cross_10_30` con `trades: 0`), y hace upsert en `symbol_conditions` (`saveSymbolConditions`). `backtest_runs.params.conditions` registra `{symbol, buyConditionId, sellConditionId, timeframe}` de cada corrida. Los `symbolSummaries`/`trades` de `backtest_runs`/`backtest_trades` corresponden solo al par ganador de cada símbolo.
- **Cómo se lee**: `runTradingCycle()` y `GET /api/trading/status` llaman a `getMainSymbolConditions(pool)` al inicio de cada ciclo/request (sin caché, igual que `bot_settings`) y resuelven `buyConditionId = symbolConditions.get(symbol)?.buyConditionId ?? DEFAULT_CONDITION_ID` y `sellConditionId` análogo. Antes de la primera corrida de `npm run backtest`, todos los símbolos usan `sma_cross_10_30` para ambos.
- **Posición abierta + cambio de condición**: si `npm run backtest` cambia el par ganador de un símbolo con posición abierta, la salida queda gobernada por la señal SELL de la NUEVA condición de venta en el próximo ciclo - sin manejo especial.

### Modelo de precio de entrada/salida generalizado

`computeEstimatedEntryPrice(ctx, i, conditionId)` (`src/strategy/conditions.ts`), usado por `signals.ts` y `backtest.ts`:

- `sma_cross_10_30` (fastPeriod=10 vs SMA30) y `sma_cross_20_50` (fastPeriod=20 vs SMA50): `estimateEntryPrice(closes, fastPeriod, smaSlow)` - el nivel de cierre que haría que la SMA rápida de la próxima sesión alcance la SMA lenta actual (misma fórmula de fases anteriores, ahora parametrizada por período).
- Las otras 10 condiciones: `estimatedEntryPrice = price` (cierre actual) - orden límite al último cierre, sin proyección de cruce.
- En todos los casos, `estimatedExitPrice = estimatedEntryPrice * (1 + riskProfile.takeProfitPct)`. `entryPrice = min(estimatedEntryPrice, price)` sigue igual en `tradingRunner.ts`/`backtest.ts` (para las 10 condiciones nuevas, `entryPrice == price`).

### `BARS_LOOKBACK` (señales/trading, distinto de `BARS_LOOKBACK_DAYS` de ingesta)

`runTradingCycle()`, `GET /api/trading/status` y `getRecentOhlcBars(pool, symbol, limit)` (`src/services/marketStore.ts`) usan `BARS_LOOKBACK = 100` velas OHLC diarias (antes `CLOSES_LOOKBACK = 60`, solo cierres) - suficientes para el warm-up de SMA50/EMA26/MACD/Bollinger/Estocástico/CCI/Donchian, los indicadores de mayor período entre las 12 condiciones. `computeSignal` además exige un mínimo de 51 velas (`MIN_BARS`) para poder detectar cruces en `i` e `i-1` con SMA50; con menos, devuelve HOLD ("Histórico insuficiente para calcular indicadores"). No afecta `BARS_LOOKBACK_DAYS=220` (`src/watchlist.ts`), usado por la ingesta diaria.

### `GET /api/conditions`

Devuelve `{ ok, generatedAt, conditions: [{symbol, timeframe, buyConditionId, buyConditionLabel, sellConditionId, sellConditionLabel, trades, winRatePct, totalReturnPct, avgReturnPct, maxDrawdownPct, updatedAt, buyHoldReturnPct}], catalog: [{id, label}], buyHoldPeriod: {start, end} | null }` - uno por símbolo del watchlist (desde `symbol_conditions`, fallback `sma_cross_10_30` para ambas si no corrió `npm run backtest`) más el catálogo de las 12 condiciones. `buyHoldReturnPct`: retorno de comprar y mantener durante `buyHoldPeriod` (período del último `backtest_runs`), con dividendos reinvertidos (Alpaca `adjustment=all`), para comparar con el retorno de la estrategia.

### Fase 6.1/7.1: `reason` con valores, overlays de gráfico por condición y tablas de resumen

(Sin cambios en `condition.evaluate()` ni en el modelo de precios de entrada/salida - puramente texto/visualización):

- **`describe(ctx, i)`** (nuevo método de `Condition`, una implementación por cada una de las 12 condiciones en `conditions.ts`): devuelve un fragmento con los valores de indicador que justifican la señal en `i` (p.ej. `SMA10=123.45 SMA30=120.10 RSI14=58.30 Mom10=2.10%`, `MACD=1.234 Señal=0.987`, `%K=15.2 %D=22.7`). `fmtVal(value, decimals=2)` formatea `null` como `'n/a'`.
- **`reason` enriquecido** (`signals.ts`): `` `${signal} por "${condition.label}" (${details})` `` (BUY/SELL) o `` `Sin señal (condición activa: "${condition.label}"; ${details})` `` (HOLD), con `details = condition.describe(ctx, i)`. Los dos casos tempranos (sin datos / histórico insuficiente) no cambian, ya que no hay `IndicatorContext` disponible todavía.
- **`ChartPoint`/`buildChartSeries`** (`chart.ts`, reescrito): ahora expone TODOS los campos de `IndicatorContext` por punto (sma10/20/30/50, ema12/26, rsi14, macd/macdSignal, bbUpper/Middle/Lower, stochK/D, williamsR, cci20, priorHigh20/priorLow10), no solo SMA10/SMA30/RSI. `/api/trading/chart/:symbol` usa `getRecentOhlcBars` (antes `getRecentBars`) y `CHART_LOOKBACK_BARS` subió de 90 a 150 (~100 puntos válidos de SMA50 dentro de la ventana visible).
- **`CONDITION_CHART_CONFIG`** (`public/app.js`): mapa `conditionId -> { price?: [{key,label,color}], oscillator?: {label, series, min?, max?, levels?} }` que decide qué overlays mostrar en el gráfico de un símbolo según su condición activa - ver tab "Detalle" en "Dashboard web" más abajo.
- **Dos tablas de resumen** introducidas en esta fase: una con señal y motivo por símbolo, y `#conditions-table` (condición ganadora + métricas de `/api/conditions`). La primera era `#signals-summary-table` (sección "Resumen por símbolo", página única) hasta la Fase 9; el rediseño a tabs la reemplazó por el tab "Resumen" actual, que cubre el mismo rol. `#conditions-table` sigue vigente, hoy en el tab "Backtest".

## Fase 8: expresiones de 2-3 condiciones y ampliación del watchlist (2026-06-17, mergeada a `main`)

Basada en un reporte de `/root/bots/backtests` (proyecto separado, solo lectura) que compara, para 33 símbolos, 3 niveles de complejidad de señal: 1 condición (= lo que ya hace `npm run backtest`, Fase 7), 2 condiciones (combinadas con AND/OR) y 3 condiciones (8 formas lógicas posibles, p.ej. `(A AND B) OR C`). El reporte recomienda, por símbolo, el nivel más simple que mejora de forma real con una muestra de trades confiable.

- **Expresiones de condición** (`src/strategy/conditionExpr.ts`): `buyConditionId`/`sellConditionId` ya no son necesariamente un id de las 12 `CONDITIONS` - pueden ser una combinación booleana, p.ej. `bollinger_reversion|stochastic_cross` (2 condiciones, OR) o `(sma_cross_10_30|williams_r_reversal)&bollinger_breakout` (3 condiciones, forma mixta). Un id simple sigue siendo válido (caso trivial) - sin cambios para los símbolos que no usan combinaciones.
- **`src/strategy/multiConditionOverrides.ts#MULTI_CONDITION_OVERRIDES`**: mapa estático `{symbol: {tier, buyExpr, sellExpr}}` con la expresión ganadora de cada símbolo según el reporte. Tiene precedencia sobre el pick de 1 condición de `symbol_conditions` en `runTradingCycle()` y `GET /api/trading/status`/`GET /api/conditions`. Hoy cubre 26 de los 27 símbolos del watchlist - el único sin override es `SOXQ` (ni 2 ni 3 condiciones mejoran de forma robusta para ese símbolo). Cuando hay override, `GET /api/conditions` sobrescribe `buyConditionId`/`buyConditionLabel`/`sellConditionId`/`sellConditionLabel` con la expresión activa real y agrega `overrideTier: 2 | 3 | null` para que el frontend sepa que las métricas (`trades`/`winRatePct`/etc.) siguen siendo las del pick de 1 condición de `symbol_conditions`, no recalculadas para el override.
- **Watchlist ampliado de 20 a 27 símbolos**: se reincorporaron `AVGO, HD, LOW, MAIN, MU, SCHG, SHW` (señal "usar" en el reporte + volumen diario líquido). `QQQ` sigue excluido de forma permanente (duplicado de `QQQM`). `GOLD` quedó afuera porque Alpaca resuelve ese ticker hoy a una empresa distinta ("Gold.com, Inc.") de la que generó el histórico backtested (posiblemente Barrick Gold). `AGM, DBEZ, NECB, PPA` quedaron afuera por volumen diario muy bajo (riesgo de slippage), pese a tener señal "usar" en el reporte.

Ver `CLAUDE.md` (sección "Fase 8") para el detalle técnico completo, incluyendo la gramática exacta de expresiones soportada y la verificación end-to-end realizada antes de commitear.

## Fase 9: clasificación manual por símbolo + dashboard con tabs (2026-06-18, mergeada a `main`)

Dos cambios entregados juntos: clasificación manual con bloqueo duro de trading, y un rediseño completo del dashboard (de página única con scroll infinito a un layout con tabs).

- **Clasificación manual** (`src/services/symbolClassificationStore.ts`): tabla `symbol_classifications (symbol PK, status IN ('apto','observar','bloqueado'), updated_at, updated_by)`, default `apto` para cualquier símbolo sin fila. Editable desde el dashboard (`GET /api/symbol-classifications` → mapa plano `{symbol: status}`; `POST /api/symbol-classifications/:symbol` con `{status}`). Caché en memoria TTL 30s, invalidada en cada escritura.
- **Bloqueo duro sobre BUY**: un símbolo `bloqueado` nunca coloca una orden de compra - es el primer check (fail-fast) del pre-trade unificado (`SYMBOL_BLOCKED_MANUAL`, ver "Ciclo de trading" más arriba) y también excluye al símbolo de la evaluación de IA de ese ciclo (no se gasta en Claude evaluando algo que no va a comprar). No afecta señales SELL/HOLD ya en curso.
- **Dashboard con tabs** (reemplaza la antigua página de scroll infinito con cards por símbolo): 5 tabs - **Resumen** (tabla compacta de los 27 símbolos con Estado editable inline, filtros por estado/tipo/señal/búsqueda), **Detalle** (al hacer click en una fila de Resumen - gráfico grande, stats, motivo, posición, IA, backtest), **Backtest** (la tabla de condiciones por símbolo), **Operaciones** (posiciones/órdenes, ver "Fase 10") y **Sistema** (health checks, ingesta, configuración, snapshots). Sidebar fija con resumen de servicios/cuenta/posiciones. Ver "Dashboard web" más abajo para el detalle completo de la UI actual.

## Fase 10: operaciones multi-cuenta + backtests segmentados por clasificación (mergeada a `main`)

- **Backtests segmentados**: además de la corrida legacy sobre todo el watchlist (`npm run backtest`), `runBacktestForGroup(pool, group)` corre el mismo motor de 144 combos pero acotado a los símbolos `aptos`/`observados`/`bloqueados` (ver "Backtesting" más arriba) - mismo cálculo, distinto universo de símbolos, persistido en una corrida separada (`backtest_runs.classification_group`).
- **Operaciones multi-cuenta - estado actual, importante no asumir más de lo que hay**: existen credenciales Alpaca **separadas** para los grupos `aptos` y `observados` (`ALPACA_APTOS_*`/`ALPACA_OBSERVADOS_*`; `bloqueados` no está configurado), vía `getAlpacaClient(group)` (`src/services/alpaca.ts`). Un poller en background (`src/services/operationsSync.ts`, `setupOperationsSyncSchema`) sincroniza periódicamente cuenta/posiciones/órdenes de cada grupo configurado hacia `account_state`/`positions_snapshot`/`pending_orders_snapshot`/`executed_orders_snapshot`, expuesto vía `GET /api/operations`/`GET /api/account-status`/`POST /api/operations/sync` y consumido por el tab "Operaciones" del dashboard (pills "Todas/✅ Aptos/🟡 Observados/❌ Bloqueados").
  - **Lo que NO hace todavía**: `runTradingCycle()` sigue colocando/cerrando **todas** las órdenes reales en la única cuenta de `ALPACA_API_KEY/SECRET/BASE_URL` - el `account_group` derivado de la clasificación del símbolo (`classificationToAccountGroup()`) hoy solo **etiqueta** `trading_signals`/`trading_orders` para que el tab "Operaciones" pueda filtrar/mostrar coherentemente. No hay ruteo real de la orden hacia la cuenta de Alpaca de ese grupo. Ver "Próximas fases" sobre si conviene completar ese ruteo o mantener el modelo de una sola cuenta de ejecución con vistas multi-cuenta de solo lectura.

## Fase 11: eficiencia y experimento de sesgo de Claude (2026-06-21, mergeada a `main`)

Ver "Capa de IA (Claude)" más arriba para el detalle completo de cada pieza - resumen:

- **Filtro BUY-only**: la evaluación de producción de Claude (antes, los 27 símbolos en cada ciclo) ahora corre solo para símbolos con señal BUY técnica y no bloqueados; se omite por completo (costo $0) si no hay candidatos ese ciclo.
- **Experimento A/B/C/D** (opcional, `bot_settings.claude_experiment_enabled`): 3 llamadas extra por candidato BUY para medir sesgo de la variante de producción contra variantes con menos contexto u orden invertido.
- **Visibilidad de costo**: tracking diario de tokens/costo estimado (`claude_usage_log`) con precios oficiales por modelo, mostrado en el header del dashboard. Puramente informativo - el corte de gasto es manual, no automático.
- **Limpieza automática de órdenes huérfanas** (opcional, `bot_settings.auto_cancel_stale_orders`): cancela y deja reemplazar automáticamente órdenes BUY pendientes desalineadas con el precio/tiempo actual (ver "Limpieza automática de órdenes BUY huérfanas/desalineadas" más arriba).

## Dashboard web (`npm run web`)

`src/server.ts` levanta un servidor Express (puerto `WEB_PORT`, por defecto `4000`) que sirve un frontend estático (`public/`) y una API. El frontend es HTML/CSS/JS plano (`public/index.html`/`app.js`/`styles.css`, sin build step ni framework).

### Layout del frontend (Fase 9 - tabs)

Header fijo (título, estado de servicios, banner de costo de Claude del día e interruptor "Órdenes a Alpaca") + sidebar (Servicios, Próximo ciclo, Cuenta Alpaca, Posiciones abiertas) + 5 tabs:

- **Resumen** (default): una fila por símbolo del watchlist (27) con columnas Símbolo, Tipo, Estado (clasificación editable inline, `POST /api/symbol-classifications/:symbol`), Señal, IA, Precio est. entrada y Condición (compra→venta, abreviadas). Filtros por estado/tipo/señal y búsqueda por símbolo (client-side). Fila coloreada según clasificación; click en una fila abre **Detalle**.
- **Detalle**: vacío hasta seleccionar un símbolo en Resumen - entonces una card grande con gráfico (con toggles de overlay: medias móviles/Bollinger/oscilador), stats completos, motivo de la señal, posición abierta, evaluación de IA y resumen de backtest para ese símbolo puntual.
- **Backtest**: tabla de condiciones por símbolo (`GET /api/conditions`) con selector de grupo (Todos/Aptos/Observados/Bloqueados, ver "Fase 10") y botón "Ejecutar backtest".
- **Operaciones**: posiciones abiertas, órdenes pendientes y ejecutadas, con pills de cuenta (Todas/Aptos/Observados/Bloqueados, ver "Fase 10"), botón "Ejecutar ciclo de trading", botón "Sincronizar ahora" y los interruptores de limpieza automática de órdenes huérfanas (ver "Fase 11").
- **Sistema**: health checks (10 servicios), ingesta manual, configuración (perfil de riesgo, modelo de Claude), sección "Experimentos" (toggle + tablas de resumen/desacuerdos del experimento A/B/C/D, ver "Fase 11") y snapshots de MinIO.

### Capa responsive (teléfono/tablet)

`public/styles.css`/`app.js` detectan el dispositivo vía **media queries de viewport** (no user-agent sniffing) en tres niveles: escritorio (>1024px, sin cambios), tablet (681–1024px, columna única + controles táctiles más grandes, mismas tablas/tabs) y teléfono (≤680px, "app shell"): header compacto fijo, sidebar convertida en un drawer lateral (botón ☰), barra de navegación inferior con iconos reemplazando los tabs de arriba, filtros en grilla de 2 columnas, y las tablas de uso frecuente (Resumen/Operaciones) convertidas en tarjetas apiladas vía CSS (sin cambios en la lógica de renderizado JS). Metadatos PWA (`manifest.json`, `icon.svg`, `theme-color`, `apple-mobile-web-app-capable`) permiten agregar el dashboard a la pantalla de inicio en modo standalone (el ícono SVG se ve en Android/Chrome; iOS no lo muestra en pantalla de inicio porque requiere PNG, ver "Próximas fases").

### Endpoints principales

- `GET /` - dashboard web.
- `GET /api/health` - ejecuta las 10 verificaciones de `src/diagnostics.ts` (las mismas que `npm run dev`) y devuelve JSON con el estado de cada servicio.
- `POST /api/ingest` - ejecuta `src/ingestRunner.ts` (misma lógica que `npm run ingest`) y devuelve un resumen JSON.
- `GET /api/trading/status` - cuenta, posiciones, señales (frescas, ETF + Acciones) y órdenes recientes de la cuenta única (ver "Trading automatizado" más arriba). Alimenta los tabs Resumen/Detalle.
- `GET /api/trading/chart/:symbol` - serie de las últimas `CHART_LOOKBACK_BARS` (**365**) velas OHLC de un símbolo (opcionalmente `?tf=1H` para 600 velas horarias), con el precio de cierre + TODOS los campos de `IndicatorContext` vía `buildChartSeries` (`src/strategy/chart.ts`). El frontend elige qué campos mostrar como overlay según las condiciones activas del símbolo (`CONDITION_CHART_CONFIG` en `app.js`).
- `POST /api/trading/run` - chequea `GET /v2/clock` primero (igual que `cronTrade.ts`); si el mercado está cerrado devuelve `{ ok: true, skipped: true, reason: 'MARKET_CLOSED' }` sin ejecutar nada. Si está abierto, ejecuta `src/tradingRunner.ts` (misma lógica que `npm run trade`); **coloca/cierra órdenes reales en la cuenta paper de Alpaca**.
- `POST /api/backtesting/run` / `GET /api/backtesting/results` - corrida legacy (todo el watchlist). `POST /api/backtest/run?group=...` / `GET /api/backtest/results?group=...` - corrida segmentada (Fase 10).
- `GET /api/conditions` - condición técnica activa de cada símbolo (override de 2-3 condiciones o pick de `symbol_conditions`) + catálogo completo de las 12 condiciones disponibles (ver "Fase 7"/"Fase 8" más arriba).
- `GET /api/assessments` - última evaluación de IA (Claude) por símbolo. Devuelve `[]` mientras la fase de IA no haya corrido para ningún símbolo este ciclo (p.ej. ciclo sin candidatos BUY).
- `GET /api/symbol-classifications` / `POST /api/symbol-classifications/:symbol` - leer/editar la clasificación manual de un símbolo (Fase 9).
- `GET /api/operations` / `GET /api/account-status` / `POST /api/operations/sync` - estado multi-cuenta por grupo (Fase 10).
- `GET /api/claude-experiment/summary|disagreements|cost|latest` / `GET /api/claude-usage` - experimento de sesgo y costo de Claude (Fase 11).
- `GET /api/settings` / `POST /api/settings` - leer/guardar el perfil de riesgo, preset y modelo de Claude activos (`bot_settings`, ver más arriba).
- `POST /api/settings/trading-enabled` / `POST /api/settings/auto-cancel-stale-orders` / `POST /api/settings/claude-experiment-enabled` - los 3 interruptores ON/OFF del dashboard.
- `GET /api/snapshots` / `GET /api/snapshots/download?key=...` - snapshots de MinIO (ver más arriba).

`src/diagnostics.ts` y `src/ingestRunner.ts` son los módulos compartidos: `src/index.ts` (CLI) y `src/ingest.ts` (CLI) son ahora wrappers delgados sobre ellos, para que la CLI y el dashboard web ejecuten exactamente la misma lógica.

### Levantar/parar el dashboard web

PostgreSQL, Redis y MinIO ya corren como servicios nativos (systemd) con autostart. El dashboard web de Vibe Bots **no** está configurado como servicio systemd (decisión deliberada, para no agregar autostart a nivel de sistema sin pedirlo explícitamente); se maneja con scripts simples:

- `npm run web:start` (o `./scripts/start-web.sh`) - lo levanta en background con `nohup`, guarda el PID en `run/web.pid` y los logs en `logs/web.log`.
- `npm run web:stop` (o `./scripts/stop-web.sh`) - lo detiene usando `run/web.pid`.
- `npm run status` (o `./scripts/status.sh`) - muestra el estado de los servicios nativos y si el dashboard web está arriba (con un check a `/api/health`).

> Si reinicias la instancia, los servicios nativos vuelven solos pero el dashboard web hay que volver a levantarlo con `npm run web:start`. Un cron watchdog (`*/5 * * * *`) lo reinicia automáticamente si cae mientras la instancia sigue corriendo (ver "Automatización"). `src/server.ts` tiene handlers globales `uncaughtException`/`unhandledRejection` para que errores async (Redis disconnect, timeout de Alpaca) no terminen el proceso.

## Base de datos - tablas clave

- `market_bars`, `news_items`, `fundamentals_snapshots`, `macro_series` - ver "Ingesta de datos" más arriba.
- `trading_signals` - una fila por señal calculada en cada `runTradingCycle()`: `symbol, ts, price, sma_fast, sma_slow, rsi, momentum, estimated_entry_price, estimated_exit_price, signal, reason, buy_condition_id, buy_condition_label, sell_condition_id, sell_condition_label` (Fase 7), más `system, timeframe` (default `'main'`/`'1Day'`, infraestructura para señales 1H - ver nota en "Backtesting" sobre por qué hoy no se usan en producción) y `account_group` (Fase 10, deriva de la clasificación manual del símbolo).
- `trading_orders` - una fila por orden ejecutada (o error): `signal_id` (FK a `trading_signals`), `symbol, ts, side, qty, order_type, alpaca_order_id, take_profit_price, stop_loss_price, status, raw` (JSONB con la respuesta completa de Alpaca), más `system, account_group`.
- `ai_assessments` (independiente, sin FK): `symbol, ts, score, recommendation, confidence, rationale, model, adjusted_entry_price, adjusted_exit_price` - una fila por símbolo en cada ciclo donde corrió la fase de IA para ese símbolo (ver "Capa de IA (Claude)" más arriba - desde la Fase 11, solo candidatos BUY). Las dos últimas columnas son las propuestas crudas de Claude antes del recorte ±10%.
- `claude_gate_experiment` / `claude_usage_log` - experimento de sesgo A/B/C/D y tracking de costo de Claude (ver "Fase 11" más arriba).
- `backtest_runs`: `id, run_at, symbols, start_date, end_date, params JSONB, summary JSONB, classification_group` (Fase 10, `null` para la corrida legacy).
- `backtest_trades`: `id, run_id` (FK a `backtest_runs`), `symbol, entry_date, entry_price, exit_date, exit_price, exit_reason, pnl_pct` (ver "Backtesting" más arriba).
- `bot_settings` (singleton `id=1`): `risk_preset, position_size_pct, stop_loss_pct, take_profit_pct, max_positions, claude_model, trading_enabled, exit_mode, pending_order_timeout_min, auto_cancel_stale_orders, claude_experiment_enabled, updated_at` - perfil de riesgo, modelo de Claude, modo de salida, y los 3 interruptores ON/OFF del dashboard (ver "Configuración dinámica (`bot_settings`)" más arriba).
- `symbol_conditions` (PK `symbol`): `timeframe, buy_condition_id, buy_condition_label, sell_condition_id, sell_condition_label, trades, win_rate_pct, total_return_pct, avg_return_pct, max_drawdown_pct, updated_at` - par ganador (compra + venta) por símbolo, calculado por `npm run backtest` sobre 144 combos, leído por `runTradingCycle()`/`GET /api/trading/status` (ver "Fase 7" más arriba; con precedencia de `MULTI_CONDITION_OVERRIDES` para 26/27 símbolos, ver "Fase 8").
- `symbol_classifications` (PK `symbol`): `status IN ('apto','observar','bloqueado'), updated_at, updated_by` - clasificación manual con bloqueo duro sobre BUY (Fase 9).
- `account_state` (PK `account_group`), `positions_snapshot`/`pending_orders_snapshot`/`executed_orders_snapshot` (PK `account_group`+símbolo/id) - snapshots de cuenta/posiciones/órdenes por grupo, sincronizados periódicamente desde Alpaca (Fase 10, ver `src/services/operationsSync.ts`).

`setupTradingSchema` (`src/services/tradingStore.ts`) crea las tablas si no existen y agrega columnas nuevas vía `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (no hay framework de migraciones). Se ejecuta al inicio de `runTradingCycle()`; `GET /api/trading/status` no la ejecuta, así que columnas nuevas deben existir ya en la base (aplicadas manualmente o mediante un `npm run trade` previo) para que ese endpoint no falle. `setupBacktestSchema` (`src/services/backtestStore.ts`) crea `backtest_runs`/`backtest_trades` y se ejecuta al inicio de `runBacktestForWatchlist()`/`runBacktestForGroup()` y de `GET /api/backtesting/results`.

## Arquitectura para futuros agentes de código

Ver también `CLAUDE.md` (contexto denso para Claude Code) y `AGENTS.md` (reglas para agentes IA en general), pensados para retener contexto entre sesiones/compactaciones.

Mapa rápido de módulos (todos operativos):

1. **Ingesta de datos en PostgreSQL** (`src/ingest.ts`, `src/ingestRunner.ts`): bars, noticias, fundamentales y series macro para 27 símbolos (12 ETFs + 15 acciones).
2. **Redis** (`src/services/cache.ts`, ver sección "Caché en Redis"): quotes de Finnhub, resultados de `/api/health` por API externa (TTLs según cuota, p.ej. 2h para Alpha Vantage) y estado de Alpaca (cuenta/posiciones/órdenes abiertas) compartido entre `runTradingCycle()` y `GET /api/trading/status` para reducir llamadas a Alpaca desde el polling del dashboard.
3. **Dashboard web** (`src/server.ts` + `public/`): UI con 5 tabs (Resumen/Detalle/Backtest/Operaciones/Sistema, Fase 9), clasificación manual por símbolo, operaciones multi-cuenta de solo lectura (Fase 10), experimento/costo de Claude (Fase 11) y una capa responsive para teléfono/tablet - ver "Dashboard web" más arriba.
4. **Estrategia + ejecución automática de órdenes vía Alpaca** (`src/strategy/`, `src/tradingRunner.ts`, `npm run trade`): cada símbolo opera con su condición efectiva (override de 2-3 condiciones - Fase 8, 26/27 símbolos - o el par ganador de 1 condición de `symbol_conditions` - Fase 7 -, fallback `sma_cross_10_30`), con SMA10/SMA30/RSI/momentum siempre calculados como contexto general, precio estimado de entrada/salida generalizado por condición, perfil de riesgo dinámico (`bot_settings`), pre-trade check unificado (clasificación/posición/exposición/máx. posiciones) y órdenes límite simples en modo `signal_only` en paper - salvo que el interruptor ON/OFF del dashboard esté en OFF (`TRADING_DISABLED`). Persistencia en `trading_signals`/`trading_orders` (con `account_group`), expuesto en `/api/trading/*` y dashboard web.
5. **Snapshots de ingesta/trading en MinIO** (`src/services/storage.ts`): cada `npm run ingest`/`npm run trade` sube un snapshot JSON crudo (`ingest/<ts>.json` / `trading/<ts>.json`), listado y descargable desde el dashboard (`GET /api/snapshots`, `GET /api/snapshots/download`). Subida best-effort (no rompe la corrida si MinIO falla). Backup periódico de PostgreSQL a MinIO queda diferido (ver roadmap).
6. **Backtesting** (`src/strategy/backtest.ts`, `src/backtestRunner.ts`, `npm run backtest`): para cada símbolo, corre las **144 combinaciones** (12×12, Fase 7) `(buyConditionId, sellConditionId)` con el motor real de orden límite sobre el histórico de `market_bars`, usando `settings.exitMode` de `bot_settings`; persiste el par ganador en `symbol_conditions` y los trades/resumen en `backtest_runs`/`backtest_trades`, expuesto en `/api/backtesting/*` (legacy) y `/api/backtest/*` (segmentado por clasificación, Fase 10) + `/api/conditions` + tab "Backtest" del dashboard. `npm run backfill-history` (opcional, no corrido aún) amplía el histórico a 2100 días para backtests más robustos.
7. **Capa de IA (Claude)** (`src/services/claude.ts`, `src/tradingRunner.ts`): **activa desde 2026-06-14** (`ANTHROPIC_API_KEY` configurada), **limitada a candidatos BUY desde la Fase 11** - evaluación batched (técnico + precios estimados + fundamentales FMP + noticias + macro FRED) que puede vetar señales BUY (`AI_BLOCKED`) y proponer ajustes acotados a `estimatedEntryPrice`/`estimatedExitPrice`; persistida en `ai_assessments` y expuesta en `GET /api/assessments` + tabs Resumen/Detalle del dashboard. Fail-open si la llamada a Claude falla. Experimento opcional de sesgo A/B/C/D y tracking de costo (`claude_gate_experiment`/`claude_usage_log`, Fase 11).
8. **Configuración dinámica** (`bot_settings`, `src/services/settingsStore.ts`): perfil de riesgo (con presets Conservador/Moderado/Agresivo/Personalizado), modelo de Claude (lista curada de 3), límite de ajuste de precios de IA (±10%) y 3 interruptores ON/OFF (órdenes a Alpaca, limpieza automática de órdenes huérfanas, experimento de Claude), editables desde el dashboard y leídos en caliente por `runTradingCycle()`/`runBacktestForWatchlist()`/`GET /api/trading/status`. `RISK_PROFILE`/`RISK_PROFILE_PRESETS` (`strategy/config.ts`) quedan como defaults/semillas.
9. **Clasificación manual + operaciones multi-cuenta** (Fases 9-10, `symbol_classifications`, `services/preTradeCheck.ts`, `services/operationsSync.ts`): bloqueo duro de BUY por símbolo, y vistas de solo lectura de hasta 3 cuentas Alpaca (`aptos`/`observados`/`bloqueados`) en el tab Operaciones - sin ruteo real de órdenes hacia esas cuentas todavía (ver "Fase 10" y "Próximas fases").

## Próximas fases (mejoras propuestas)

Ideas de evolución, no implementadas todavía - priorizar según valor/esfuerzo. Esta lista se reescribió de punta a punta el 2026-06-21 tras una auditoría completa del código (varias fases recientes - operaciones multi-cuenta, clasificación manual, experimento/costo de Claude, limpieza de órdenes - no estaban documentadas en `README.md`/`CLAUDE.md` hasta ahora); los puntos 1-5 salen directamente de huecos/decisiones a medio camino encontrados en esa auditoría.

1. **Completar (o descartar) el ruteo real de órdenes multi-cuenta**: hoy `account_group` (Fase 10) solo *etiqueta* `trading_signals`/`trading_orders` para que el tab Operaciones filtre - todas las órdenes reales siguen yendo a la única cuenta de `ALPACA_API_KEY`. Decidir si se completa el ruteo (la orden BUY de un símbolo "apto" se coloca en la cuenta `ALPACA_APTOS_*`, etc.) o si el modelo definitivo es "una cuenta de ejecución + vistas de solo lectura multi-cuenta" - y documentarlo explícitamente una vez resuelto.
2. **Credenciales `ALPACA_BLOQUEADOS_*`**: no están configuradas, así que el grupo "Bloqueados" del tab Operaciones nunca tiene datos reales de Alpaca (sync omitido con warning). Configurarlas o decidir formalmente que ese grupo no necesita una cuenta real (al fin y al cabo nunca debería tener posiciones).
3. **Hacer editable `bot_settings.pending_order_timeout_min`** desde el dashboard: hoy se muestra en el tab Operaciones pero solo se puede cambiar vía SQL/API directa, no desde la UI.
4. **Unificar o deprecar los endpoints de backtest legacy** (`/api/backtesting/run|results`) ahora que existen los segmentados por clasificación (`/api/backtest/run|results?group=`, Fase 10) - hoy coexisten dos pares de rutas que hacen lo mismo sobre distinto universo de símbolos.
5. **Mantener `CLAUDE.md`/`README.md` sincronizados con cada feature mergeada**: la auditoría de esta revisión encontró que `CLAUDE.md` describe la "Fase híbrido" (señales 1H Tier 1/2/sombra) como activa en `runTradingCycle()` cuando en realidad esa orquestación ya no está conectada ahí (el soporte 1H sigue existiendo y se usa solo para un pick informativo en `backtestRunner.ts`); y que el código ya tiene una "Fase 10" (comentario en `backtestRunner.ts`) sin correlato en la documentación. Vale la pena una auditoría de `CLAUDE.md` con el mismo criterio aplicado acá, y considerar un recordatorio en el flujo de PR/merge para actualizar ambos archivos.
6. **Decidir el destino de las branches exploratorias no mergeadas**: `regime-study`, `regime-aware-backtest` y `portfolio-margin-study` (estudios de régimen de mercado y apalancamiento de portafolio, con código compilado en `dist/` pero sin mergear) acumulan trabajo sin una decisión de continuar/archivar.
7. **Backtesting de portafolio (v2)**: hoy cada símbolo se simula de forma independiente (% de retorno aislado, sin equity/cash compartido ni cap real de posiciones simultáneas); modelar el portafolio completo daría retornos más realistas y comparables al trading en vivo.
8. **Backfill histórico**: ejecutar `npm run backfill-history` (ya implementado, nunca corrido) para extender `market_bars` de ~150 a ~2100 días (~5.8 años, límite real de Alpaca IEX free) y tener backtests con más regímenes de mercado.
9. **Backups automáticos de PostgreSQL**: `pg_dump` periódico (cron) subido a MinIO junto a los snapshots de ingesta/trading.
10. **Cron intradía**: evaluar `*/30 13-21 * * 1-5` (cada 30 min) si se requiere reaccionar más rápido a fills de órdenes límite o señales SELL.
11. **Tests automatizados**: no hay suite de tests; agregar unit tests para `strategy/` (señales, backtest, `applyPriceAdjustment`, `preTradeCheck`) e integración para `settingsStore`/`tradingRunner`.
12. **Historial de configuración**: `bot_settings` es una fila singleton sin auditoría; agregar una tabla `bot_settings_history` para ver cuándo/quién cambió el perfil de riesgo, modelo de Claude o cualquiera de los 3 interruptores.
13. **Watchlist dinámica**: `WATCHLIST` es una constante en código (`src/watchlist.ts`); permitir agregar/quitar símbolos desde el dashboard, igual que `bot_settings`.
14. **Alertas**: notificaciones (email/Telegram/Slack) ante `AI_BLOCKED`, ajustes de precio de IA descartados por exceder ±10%, fallos repetidos de la capa de IA/ingesta, o sync de cuenta fallido en "Operaciones".
15. **Revisar el volumen real de llamadas a Claude por la cadencia de 5 min**: el ciclo de trading corre cada 5 minutos (no cada hora, corregido en esta misma revisión) y la Fase 11 quitó el viejo gate de "1 vez por día" para la IA - un candidato BUY persistente podría generar muchas llamadas el mismo día. Revisar `GET /api/claude-usage` en un día con BUYs activos; si el volumen es alto, la corrección sería un throttle de "no re-preguntar lo mismo en una ventana corta" (no un corte por presupuesto, ver regla en "Fase 11").
16. **Ícono PWA en iOS**: el `icon.svg` del dashboard responsive (capa móvil agregada en esta misma revisión) se ve en Android/Chrome al agregar a la pantalla de inicio, pero iOS Safari requiere un `apple-touch-icon` en PNG - generar uno si se quiere paridad completa.
