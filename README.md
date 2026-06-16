# Vibe Bots

Proyecto de bot trader en TypeScript diseñado para correr en una instancia LXD con servicios nativos.

Estado actual: bot operativo de punta a punta - ingesta diaria de datos de mercado, estrategia **multi-condicional por símbolo con condiciones de compra y venta independientes** (cada símbolo opera con su propio par ganador (condición_compra, condición_venta) elegido de un combo-matrix de 144 combinaciones = 12 condiciones × 12 condiciones, Fases 6 y 7) con un perfil de riesgo configurable (`bot_settings`), evaluación y ajuste de esas señales por Claude (Anthropic), ejecución automática de órdenes en modo `signal_only` (sin bracket TP/SL) en la cuenta paper de Alpaca (con un interruptor ON/OFF para bloquear órdenes desde el dashboard), backtesting de la estrategia, snapshots en MinIO y un dashboard web para monitoreo y configuración (Grafana corre por separado, ver sección "Grafana"). Ver "Flujo del bot" justo abajo para el recorrido completo, "Fase 7: condición de compra y venta independientes por símbolo" para el detalle, y "Próximas fases (mejoras propuestas)" al final para ideas de evolución.

## Flujo del bot (de los datos a una orden en Alpaca)

Cada ciclo de trading (`npm run trade`, `npm run trade:cron` o `POST /api/trading/run`, todos vía `runTradingCycle()` en `src/tradingRunner.ts`) sigue estos pasos:

1. **Datos** (ingesta previa, `npm run ingest`): bars diarias, noticias, fundamentales y series macro de los 20 símbolos del watchlist (`src/watchlist.ts`) ya están en PostgreSQL (`market_bars`, `news_items`, `fundamentals_snapshots`, `macro_series`).
2. **Configuración activa**: `runTradingCycle()` lee en caliente `bot_settings` (`getSettings(pool)`) - perfil de riesgo (tamaño de posición, stop-loss, take-profit, máx. posiciones) y modelo de Claude a usar.
3. **Señal técnica** (`computeSignal()` en `src/strategy/signals.ts`): para cada símbolo, evalúa su **condición de compra** (`buyConditionId`) y su **condición de venta** (`sellConditionId`) por separado (una de 12 condiciones clásicas de TA cada una - ver "Fase 7" - asignadas por `npm run backtest` y leídas de `symbol_conditions`, con fallback a `sma_cross_10_30` para ambas). `signal = 'BUY'` si la condición de compra lo indica; `'SELL'` si la condición de venta lo indica; `'HOLD'` si ninguna. Determina también `estimatedEntryPrice`/`estimatedExitPrice` (este último usando el `takeProfitPct` del perfil de riesgo activo). SMA10/SMA30/RSI(14)/momentum se calculan siempre como contexto general, independientemente de las condiciones activas.
4. **Evaluación de IA** (`assessWatchlist()` en `src/services/claude.ts`, una sola llamada a Claude por ciclo): para cada señal, Claude recibe el contexto técnico + precios estimados + fundamentales + noticias + macro, y devuelve `recommendation` (`buy`/`hold`/`avoid`), `score`, `confidence`, `rationale` y, opcionalmente, `adjustedEntryPrice`/`adjustedExitPrice`. Si esta llamada falla por cualquier motivo, el ciclo continúa sin ella (fail-open).
5. **Ajuste de precios** (`applyPriceAdjustment()` en `src/tradingRunner.ts`): si Claude propuso precios ajustados y quedan dentro de ±10% del valor algorítmico (y `exit > entry`), sobrescriben `estimatedEntryPrice`/`estimatedExitPrice` antes de persistir la señal.
6. **Gate de IA**: una señal `BUY` que ya pasó los chequeos de posición/orden pendiente/máximo de posiciones se bloquea (`AI_BLOCKED`, sin colocar orden) si `recommendation === 'avoid'`. La IA nunca convierte HOLD/SELL en BUY ni toca señales SELL.
7. **Orden a Alpaca** (cuenta **paper**): si la señal `BUY` sobrevive el gate, se coloca una **orden límite simple** a `min(estimatedEntryPrice, precio actual)` (modo `signal_only` activo: sin bracket TP/SL). Una señal `SELL` con posición abierta cancela órdenes pendientes y cierra la posición a mercado. Si el interruptor "Órdenes a Alpaca" del dashboard está en OFF (`bot_settings.trading_enabled = false`), este paso se omite para cualquier señal BUY/SELL (`TRADING_DISABLED`) - los pasos 1-6 (señales, IA, ajuste de precios) siguen corriendo igual.
8. **Persistencia y exposición**: la señal (`trading_signals`), la orden (`trading_orders`) y la evaluación de IA (`ai_assessments`) quedan en PostgreSQL; un snapshot JSON crudo del ciclo sube a MinIO (best-effort); todo se expone vía `GET /api/trading/status`, `GET /api/assessments` y el dashboard web (`npm run web`).

## Arquitectura actual

- `src/` - código fuente TypeScript
- `public/` - frontend estático del dashboard web (HTML/CSS/JS, sin build step)
- `grafana/` - dashboards de Grafana provisionados vía API (`vibe-overview.json`, `vibe-trading.json`)
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
- Grafana para dashboards, leyendo directamente de PostgreSQL
- Express para el dashboard web (health checks, ingesta manual, interruptor ON/OFF de órdenes a Alpaca, configuración y resumen por símbolo con trading, IA y backtesting)

> No se usa Docker en el entorno actual. Los archivos `Dockerfile`, `docker-compose.yml` y `docker/` ya no forman parte de la arquitectura activa.

## Comandos

- `npm install` - instalar dependencias Node
- `npm run build` - compilar TypeScript
- `npm start` - ejecutar el bot compilado
- `npm run dev` - ejecutar diagnóstico completo con `ts-node`
- `npm run ingest` - ejecutar la ingesta de datos de mercado
- `npm run trade` - ejecutar un ciclo de trading completo (paper): calcula señales, aplica el perfil de riesgo activo y coloca/cierra bracket orders en Alpaca paper
- `npm run trade:cron` - como `npm run trade`, pero primero consulta `/v2/clock` de Alpaca y no hace nada si el mercado está cerrado. Pensado para cron (ver "Automatización" más abajo).
- `npm run backtest` - corre las 144 combinaciones de condiciones (12 compra × 12 venta, Fase 7) sobre el histórico actual para los 20 símbolos del watchlist, elige el par ganador de cada símbolo y persiste el resultado en `symbol_conditions` (ver "Backtesting" y "Fase 7" más abajo).
- `npm run backfill-history` - (opcional, una sola vez, no corrido aún) extiende el histórico de `market_bars` de ~150 a ~2100 días (~5.8 años) para backtests con más regímenes de mercado.
- `npm run web` - levantar el dashboard web en primer plano, en `http://0.0.0.0:4000`
- `npm run web:start` / `npm run web:stop` - levantar/detener el dashboard web en background (ver `scripts/`)
- `npm run status` - ver el estado de los servicios nativos (Postgres/Redis/MinIO/Grafana) y del dashboard web

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

# Capa de IA (Claude): gate de señales BUY + ajuste de precios (fail-open si falla)
# El modelo usado en cada ciclo puede sobrescribirse vía bot_settings.claude_model
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-haiku-4-5-20251001

# Dashboard web
WEB_PORT=4000
GRAFANA_PUBLIC_URL=
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

- **Watchlist** (20 símbolos, `WATCHLIST` en `src/watchlist.ts`): 11 ETFs (`ETF_SYMBOLS`: `SPY, SCHE, SCHF, XLP, XLU, XMMO, VUG, SCHD, SPMO, QQQM, SOXQ`) + 9 acciones (`AAPL, MSFT, NVDA, REG, TOL, AMZN, TSM, GOOGL, MS`). `ETF_SYMBOLS` es el subconjunto de `WATCHLIST` que el dashboard clasifica como "ETF"; el resto se clasifica como "Acciones". Lista reducida desde los 28 símbolos originales (ver historial de commits) tras un análisis de backtests/correlación/liquidez, quitando `NECB, DBEZ, PPA, AVGO, MU, AGM` por baja probabilidad de retorno con la estrategia actual, y luego `QQQ`/`SCHG` por ser duplicados casi perfectos (r>=0.99) de `QQQM`/`VUG` respectivamente, con comisiones más altas (QQQ 0.20% vs QQQM 0.15%; SCHG 0.04% vs VUG 0.03%).
- **`market_bars`**: bars diarias (`BARS_LOOKBACK_DAYS` = 220 días calendario, ~150 sesiones, suficiente para SMA30+RSI14 con margen) desde Alpaca Market Data API (feed IEX).
- **`news_items`**: noticias del watchlist desde Alpaca News API (Benzinga).
- **`fundamentals_snapshots`**: perfil/fundamentales por símbolo desde FMP (`JSONB`, un snapshot por corrida).
- **`macro_series`**: observaciones de FRED para `FEDFUNDS`, `CPIAUCSL`, `UNRATE`.

Además cachea en Redis el último quote de Finnhub por símbolo (`quote:<SYMBOL>`, TTL 5 min) para consumo rápido por el bot (ver sección "Caché en Redis").

> ⚠️ Alpha Vantage tiene un free tier muy limitado (~25 requests/día). Su cliente (`src/services/alphaVantage.ts`) está disponible y se prueba en el diagnóstico, pero **no** se usa en la ingesta recurrente para no agotar la cuota.

> ℹ️ El endpoint `/v2/stocks/bars` de Alpaca aplica el parámetro `limit` al **total de barras de la respuesta** (suma de todos los símbolos), no por símbolo. `getDailyBars` (`src/services/marketData.ts`) usa `limit: 10000` para evitar que, con 20 símbolos x ~150 sesiones (~3000 barras), el watchlist se trunque alfabéticamente y los últimos símbolos queden sin histórico suficiente para SMA30. También se pasa `adjustment: 'split'` para evitar discontinuidades de precio (y señales falsas en SMA/RSI/momentum) cuando un símbolo tiene un split dentro de la ventana de lookback.

## Trading automatizado (`npm run trade`, paper)

`src/trade.ts` (CLI) y `src/tradingRunner.ts` (lógica compartida, también usada por `POST /api/trading/run`) ejecutan un ciclo completo de trading sobre el watchlist, **operando contra la cuenta paper de Alpaca** (`ALPACA_BASE_URL=https://paper-api.alpaca.markets`).

### Estrategia (`src/strategy/`)

- **Indicadores** (`indicators.ts`): SMA, EMA, RSI (versión simplificada, sin suavizado de Wilder), MACD, Bandas de Bollinger, Estocástico, Williams %R, CCI, Canal de Donchian, momentum (% de retorno) y `estimateEntryPrice`.
- **Condiciones** (`conditions.ts`): catálogo de 12 condiciones clásicas de TA (`CONDITIONS`) + `buildIndicatorContext(bars)` + `computeEstimatedEntryPrice(ctx, i, conditionId)` - ver "Fase 6: estrategia multi-condicional por símbolo" más abajo para el detalle completo.
- **Parámetros** (`config.ts`, `STRATEGY_PARAMS`): SMA rápida = 10, SMA lenta = 30, RSI(14) con umbral de sobrecompra 70, momentum a 10 periodos - usados por la condición `sma_cross_10_30` (default/fallback).
- **Señales** (`signals.ts`, `computeSignal(symbol, bars, riskProfile, buyConditionId, sellConditionId)`) - cada `SignalResult` incluye:
  - `signal: 'BUY' | 'SELL' | 'HOLD'`: `'BUY'` si `buyCondition.evaluate(ctx, i) === 'BUY'`; `'SELL'` si `sellCondition.evaluate(ctx, i) === 'SELL'`; `'HOLD'` si ninguna (Fase 7, condiciones de compra y venta son independientes).
  - `reason` (Fase 6.1, enriquecido con valores): `` `${signal} por "${condition.label}" (${details})` `` (BUY/SELL) o `` `Sin señal (condición activa: "${condition.label}"; ${details})` `` cuando compra=venta, o `` `Sin señal (compra: "X"; venta: "Y")` `` cuando difieren. `details = condition.describe(ctx, i)` agrega los valores de indicador.
  - `buyConditionId`/`buyConditionLabel`/`sellConditionId`/`sellConditionLabel`: las condiciones evaluadas, para persistencia/exposición.
  - `smaFast`/`smaSlow`/`rsi`/`momentum` (SMA10/SMA30/RSI14/Momentum10): se calculan **siempre** como contexto general, independientemente de la condición activa.
  - **`estimatedEntryPrice`**: para `sma_cross_10_30`/`sma_cross_20_50`, precio de cierre que haría que la SMA rápida de la próxima sesión alcance la SMA lenta actual (`estimateEntryPrice` en `indicators.ts`); para las otras 10 condiciones, el cierre actual (`price`) - ver "Fase 6" para el detalle.
  - **`estimatedExitPrice`**: `estimatedEntryPrice * (1 + riskProfile.takeProfitPct)` - precio objetivo de take-profit relativo a ese precio estimado de entrada (`riskProfile` viene de `bot_settings`, ver "Configuración dinámica" más abajo; default `RISK_PROFILE`). `null` cuando `estimatedEntryPrice` es `null` (histórico insuficiente, < 51 velas).
  - Antes de guardarse, ambos precios (`estimatedEntryPrice`/`estimatedExitPrice`) pueden ser ajustados por la fase de IA (Claude) dentro de un margen de ±10% - ver "Configuración dinámica (`bot_settings`)" y "Capa de IA (Claude)" más abajo.

### Gestión de riesgo (`bot_settings`)

El perfil de riesgo activo (`positionSizePct`, `stopLossPct`, `takeProfitPct`, `maxPositions`) se lee de la tabla `bot_settings` en cada ciclo - ver "Configuración dinámica (`bot_settings`)" más abajo. `RISK_PROFILE`/`RISK_PROFILE_PRESETS` (`strategy/config.ts`) son los valores por defecto/semilla con los que se siembra esa tabla. El perfil "moderado" (= valor por defecto, sin cambios respecto al diseño original) es:

- Tamaño de posición: 10% del equity de la cuenta por símbolo (calculado sobre el precio de mercado actual, `signal.price`).
- Stop-loss: -3% / Take-profit: +6% (ratio 2:1), calculados sobre `estimatedEntryPrice` (no sobre el precio de mercado actual), vía **bracket orders** de Alpaca (`order_class: 'bracket'`).
- Máximo 5 posiciones simultáneas (todo el watchlist).

### Ciclo de trading (`runTradingCycle`)

Para cada símbolo del watchlist: lee las últimas `BARS_LOOKBACK` (100) velas OHLC (`getRecentOhlcBars`), resuelve su condición técnica activa (`symbol_conditions`, fallback `sma_cross_10_30`, Fase 6), calcula la señal con esa condición y el perfil de riesgo activo (`bot_settings`), aplica el ajuste de precios de IA si corresponde y la persiste en `trading_signals`, y según la señal:

- **BUY**: si no hay posición ni orden pendiente para el símbolo y no se alcanzó el máximo de posiciones (`riskProfile.maxPositions`), calcula la cantidad (`equity * riskProfile.positionSizePct / precio actual`, mínimo 1 acción) y coloca una **orden límite simple** (`placeBuyOrder`, `type: 'limit'`) a `min(estimatedEntryPrice, precio actual)` sin bracket TP/SL (modo `exit_mode = 'signal_only'` activo en `bot_settings`). Si `estimatedEntryPrice` no está disponible, usa el precio de mercado actual.
- **SELL**: si hay una posición abierta, cancela órdenes pendientes del símbolo y cierra la posición a mercado.
- **HOLD**: sin acción.

Cada orden ejecutada (o error) se registra en `trading_orders`, vinculada a la señal que la originó. La respuesta cruda de Alpaca (incluyendo el `limit_price` real enviado) queda en la columna `raw` (JSONB).

> ⚠️ La orden de compra es una orden **límite** (no a mercado), puede quedar pendiente sin ejecutarse si el precio de mercado nunca llega al precio de entrada calculado durante la sesión (`time_in_force: 'day'`). En modo `signal_only` la salida es únicamente por señal SELL de la `sellCondition` activa — no hay bracket TP/SL automático.

### Automatización (cron)

`src/cronTrade.ts` (`npm run trade:cron`) consulta `GET /v2/clock` (`getMarketClock` en `src/services/alpaca.ts`) y solo llama a `runTradingCycle()` si el mercado está abierto; si está cerrado, loguea la próxima apertura y termina sin hacer nada (exit 0). El crontab de `root` (fuera del repo) tiene:

- **Ciclo de trading**: cada hora en punto, 13:00-21:00 UTC, lunes a viernes (`0 13-21 * * 1-5`). Esa ventana cubre el horario de mercado de EE.UU. (9:30-16:00 ET) tanto en EST como en EDT con margen; el chequeo de `/v2/clock` filtra las horas fuera de sesión, fines de semana y feriados. Salida en `logs/trade-cron.log`.
- **Ingesta pre-apertura**: 12:00 UTC (8:00 AM ET), lunes a viernes (`0 12 * * 1-5`). Los bars 1D son del cierre anterior; esta corrida refresca noticias, fundamentales y el contexto macro antes del primer ciclo de trading del día. Salida en `logs/ingest-cron.log`.
- **Ingesta post-cierre**: 22:00 UTC, lunes a viernes (`0 22 * * 1-5`), siempre después del cierre (16:00 ET) tanto en EST como en EDT. Salida en `logs/ingest-cron.log`.
- **Watchdog del dashboard web**: cada 5 minutos, todos los días (`*/5 * * * *`). Llama a `scripts/start-web.sh`, que es idempotente (verifica PID y no hace nada si ya está corriendo); si el proceso cayó, lo reinicia automáticamente. Salida en `logs/watchdog.log`.

La cadencia horaria es deliberadamente conservadora: la estrategia opera sobre cierres **diarios** (`market_bars`), por lo que las señales no cambian entre una ingesta y la siguiente dentro del mismo día - las corridas intradía sirven principalmente para re-sincronizar posiciones/órdenes (p.ej. si una bracket order límite de la mañana recién se ejecutó) y re-evaluar señales SELL con el equity actualizado. Para reaccionar más rápido, cambiar `0 13-21` por `*/30 13-21` (cada 30 min) en el crontab.

### Exposición vía API/web

- `GET /api/trading/status`: cuenta (equity/cash/buying power), posiciones abiertas, órdenes recientes y **señales recalculadas en el momento** (no cacheadas, usando el perfil de riesgo activo de `bot_settings`) para los 20 símbolos del watchlist, cada una etiquetada como `type: 'ETF' | 'STOCK'` según `ETF_SYMBOLS`. `estimatedEntryPrice`/`estimatedExitPrice` de cada señal se sobrescriben con el último valor persistido en `trading_signals` (= verificado/ajustado por IA en el ciclo más reciente), si existe.
- `POST /api/trading/run`: ejecuta `runTradingCycle()` (misma lógica que `npm run trade`) - **coloca/cierra órdenes reales en la cuenta paper**.
- El frontend (`public/`) integra estos datos en la sección "Resumen por símbolo" (gráficos y tablas por símbolo, más posiciones/órdenes al final) con un botón "Ejecutar ciclo de trading" que pide confirmación antes de llamar a `POST /api/trading/run`.

> ⚠️ Tanto `npm run trade` como el botón del dashboard y `POST /api/trading/run` colocan órdenes reales (con dinero simulado) en la cuenta **paper** de Alpaca. No hay modo "solo simulación" adicional en esta fase: el "paper" de Alpaca ya es el entorno de prueba.

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

### Evaluación batched (una llamada por ciclo)

`src/services/claude.ts` hace **una sola llamada** a `POST /v1/messages` por `runTradingCycle()`, cubriendo los 20 símbolos del watchlist con salida estructurada forzada (`tool_choice` → tool `record_assessments`). Para cada símbolo, el prompt incluye la señal técnica recién calculada (precio, SMA10/SMA30, RSI, momentum), los precios estimados de entrada/salida algorítmicos, el último perfil fundamental (FMP), hasta 5 noticias recientes y el contexto macro (FRED). La respuesta es un array de:

- `symbol`
- `score` (-1 a 1)
- `recommendation`: `'buy' | 'hold' | 'avoid'`
- `confidence` (0 a 1)
- `rationale` (texto corto)
- `adjustedEntryPrice` / `adjustedExitPrice` (opcionales): propuesta de Claude para ajustar los precios estimados, si los considera poco razonables a la luz de fundamentales/noticias/macro. `null`/omitidos si Claude no propone nada.

### Gate sobre señales BUY

En la "pasada 2" de `runTradingCycle()`, una señal BUY que ya pasó los chequeos existentes (sin posición abierta, sin orden pendiente, dentro del máximo de posiciones) se bloquea si `assessment.recommendation === 'avoid'`, generando una acción `{ type: 'AI_BLOCKED', symbol, reason: rationale }` (impresa como `🤖🚫` por `src/trade.ts`) en vez de colocar la bracket order. La IA **no** puede convertir un HOLD/SELL en BUY, ni bloquear/modificar un SELL.

### Ajuste de precios de entrada/salida

Antes de persistir la señal, si Claude propuso `adjustedEntryPrice`/`adjustedExitPrice`, `applyPriceAdjustment()` (`src/tradingRunner.ts`) los acota a **±10%** del valor algorítmico correspondiente; si la propuesta se sale de ese rango (o no hay propuesta), se mantiene el valor algorítmico. Si ambos ajustes quedan dentro del rango y `adjustedExitPrice > adjustedEntryPrice`, se sobrescriben `signal.estimatedEntryPrice`/`estimatedExitPrice` con esos valores **antes** de `saveSignal` - por lo que el valor mostrado en el dashboard, persistido en `trading_signals` y usado para la bracket order BUY (precio límite, take-profit, stop-loss) son consistentes y ya incorporan la verificación de Claude.

### Persistencia y exposición

- `ai_assessments` (tabla independiente, sin FK a `trading_signals`): `symbol, ts, score, recommendation, confidence, rationale, model, adjusted_entry_price, adjusted_exit_price`. Una fila por símbolo en cada ciclo donde la fase de IA corrió. Las dos últimas columnas son las propuestas *crudas* de Claude, antes del recorte ±10% - permiten ver en el dashboard si una propuesta fue descartada por estar fuera de rango.
- `GET /api/assessments` devuelve la última evaluación por símbolo (`getLatestAssessments`, `DISTINCT ON (symbol)`).
- Sección "Evaluaciones de IA (Claude)" en el dashboard: tabla con Símbolo, Fecha, Score, Recomendación, Confianza, Ajuste entrada, Ajuste salida y Justificación, refrescada cada 60s y con botón manual.
- El snapshot de trading en MinIO (`trading/<ts>.json`) ahora incluye también `assessments: SymbolAssessment[]`.
- `npm run dev` / `GET /api/health` incluyen un décimo check `anthropic` (`src/diagnostics.ts`) que hace un ping mínimo a Claude (ver "Diagnóstico" más arriba).

## Configuración dinámica (`bot_settings`)

Perfil de riesgo, modelo de Claude y el límite de ajuste de precios de IA se leen en caliente (sin caché) desde la tabla `bot_settings`, editable desde el dashboard. Afecta a `runTradingCycle()`, `runBacktestForWatchlist()` y `GET /api/trading/status`.

### `bot_settings` (tabla singleton)

`src/services/settingsStore.ts`:

- `setupSettingsSchema(pool)`: crea `bot_settings (id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1), risk_preset TEXT, position_size_pct NUMERIC, stop_loss_pct NUMERIC, take_profit_pct NUMERIC, max_positions INTEGER, claude_model TEXT, updated_at TIMESTAMPTZ)` si no existe, agrega `trading_enabled BOOLEAN NOT NULL DEFAULT TRUE` y `exit_mode TEXT NOT NULL DEFAULT 'bracket'` vía `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, y siembra la única fila (`id = 1`) con el perfil "moderado" (10/3/6/5) y `claude_model = NULL` (= usa el default de `ANTHROPIC_MODEL`). El `exit_mode` activo en producción es `'signal_only'`.
- `getSettings(pool)` / `saveSettings(pool, settings)`: leen/escriben esa fila. `BotSettings = { riskPreset, riskProfile: { positionSizePct, stopLossPct, takeProfitPct, maxPositions }, claudeModel, tradingEnabled }`. `saveSettings` solo escribe `riskPreset`/`riskProfile`/`claudeModel` (no toca `trading_enabled`).
- `setTradingEnabled(pool, enabled)`: actualiza únicamente `trading_enabled` (usado por el interruptor ON/OFF, ver más abajo).
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

- `GET /api/settings` → `{ ok, settings: BotSettings, presets: RISK_PROFILE_PRESETS, models: CLAUDE_MODEL_OPTIONS }` (`BotSettings` incluye `tradingEnabled`).
- `POST /api/settings` → valida `riskPreset` (∈ `conservador|moderado|agresivo|personalizado`), `riskProfile` (`positionSizePct` ∈ (0,1], `stopLossPct` ∈ (0,1), `takeProfitPct` ∈ (0,2), `maxPositions` entero ∈ [1,20]) y `claudeModel` (∈ `CLAUDE_MODEL_OPTIONS` o `null`); responde `400` con mensaje en español si algo no valida, o `{ ok: true, savedAt }` si guarda correctamente. No toca `trading_enabled`.
- `POST /api/settings/trading-enabled` → body `{ enabled: boolean }`; valida que `enabled` sea boolean (`400` si no), llama a `setTradingEnabled(pool, enabled)` y responde `{ ok: true, tradingEnabled: enabled, savedAt }`.

### Interruptor ON/OFF de órdenes a Alpaca

En el header del dashboard, junto al título, hay un indicador ("Órdenes a Alpaca: ACTIVADAS"/"DESACTIVADAS") y un botón ("⏸ Desactivar"/"▶ Activar") que llaman a `POST /api/settings/trading-enabled` (con `window.confirm` antes de cada cambio, ya que afecta trading real en paper).

- **ON** (`trading_enabled = true`, default): comportamiento normal, sin cambios.
- **OFF** (`trading_enabled = false`): en `runTradingCycle()`, cualquier señal `BUY`/`SELL` que llegue a la "pasada 2" genera una acción `{ type: 'TRADING_DISABLED', symbol }` (impresa como `⏸️` por `src/trade.ts`) en vez de colocar/cancelar/cerrar órdenes en Alpaca. Las señales `HOLD` siguen generando `NO_ACTION` igual que siempre. El cálculo de señales (pasada 1), la fase de IA y `saveSignal`/`saveAssessment` **no se ven afectados** - el dashboard sigue mostrando datos frescos por símbolo aunque el bot esté en OFF.
- Pensado como el equivalente más cercano a un "dry-run": útil para pausar la colocación de órdenes (p.ej. mantenimiento, revisión manual de posiciones) sin perder visibilidad de señales/IA/backtesting.

### Sección "Configuración" del frontend

Ubicada entre "Ingesta de datos" y "Resumen por símbolo". Incluye:

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

- `src/backtestRunner.ts` (`runBacktestForWatchlist(pool)`): para cada uno de los 20 símbolos del watchlist, corre `runCombinedBacktest` en las **144 combinaciones** (12 × 12) de `(buyConditionId, sellConditionId)` usando el `settings.exitMode` activo de `bot_settings`, elige el par ganador (mayor `totalReturnPct` entre los que tuvieron al menos 1 trade) y lo persiste en `symbol_conditions` con `buy_condition_id`/`sell_condition_id`; agrega métricas de portafolio y persiste el resto vía `src/services/backtestStore.ts`.
- `src/backtest.ts` (CLI, `npm run backtest`): imprime una tabla resumen por símbolo (trades, win rate, retorno total, retorno promedio, max drawdown) y el resumen de portafolio, y muestra el `runId` persistido.
- `backtest_runs` (`id, run_at, symbols, start_date, end_date, params JSONB, summary JSONB`) y `backtest_trades` (`id, run_id` FK -> `backtest_runs`, `symbol, entry_date, entry_price, exit_date, exit_price, exit_reason, pnl_pct`) - creadas por `setupBacktestSchema`.
- `POST /api/backtesting/run` ejecuta el backtest y lo persiste; `GET /api/backtesting/results` devuelve la última corrida (con sus trades). Sección "Backtesting" en el dashboard: período cubierto, tabla resumen por símbolo, resumen de portafolio y botón "Ejecutar backtest".
- `npm run backfill-history` (opcional, una sola vez, no corrido aún): extiende `market_bars` de ~150 a **2100 días** (~5.8 años, `BACKFILL_DAYS`) vía `getDailyBars` + `saveDailyBars` (upsert), para backtests con más historia. No afecta `BARS_LOOKBACK_DAYS=220` de la ingesta diaria normal.

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
- **`CONDITION_CHART_CONFIG`** (`public/app.js`): mapa `conditionId -> { price?: [{key,label,color}], oscillator?: {label, series, min?, max?, levels?} }` que decide qué overlays mostrar en `renderSymbolCharts` según la condición activa de cada símbolo - ver "Gráfico" en "Sección 'Resumen por símbolo' del frontend" más abajo.
- **Dos tablas nuevas** en "Resumen por símbolo": "Resumen de señales" (`#signals-summary-table`, los 20 símbolos con condición activa y motivo) y "Condiciones por símbolo (backtest)" (`#conditions-table`, condición ganadora + métricas de `/api/conditions` por símbolo) - ver detalle más abajo.

## Dashboard web (`npm run web`)

`src/server.ts` levanta un servidor Express (puerto `WEB_PORT`, por defecto `4000`) que sirve un frontend estático (`public/`) y una API mínima:

- `GET /` - dashboard web (health checks, interruptor ON/OFF de órdenes a Alpaca, ingesta manual, configuración y resumen por símbolo).
- `GET /api/health` - ejecuta las 10 verificaciones de `src/diagnostics.ts` (las mismas que `npm run dev`) y devuelve JSON con el estado de cada servicio.
- `GET /api/config` - expone configuración pública para el frontend (por ahora, `grafanaPublicUrl`).
- `POST /api/ingest` - ejecuta `src/ingestRunner.ts` (misma lógica que `npm run ingest`) y devuelve un resumen JSON.
- `GET /api/trading/status` - cuenta, posiciones, señales (frescas, ETF + Acciones) y órdenes recientes (ver más arriba).
- `GET /api/trading/chart/:symbol` - serie de las últimas `CHART_LOOKBACK_BARS` (**365**) velas OHLC de un símbolo (opcionalmente `?tf=1H` para 600 velas horarias), con el precio de cierre + TODOS los campos de `IndicatorContext` (`ChartPoint`: sma10/20/30/50, ema12/26, rsi14, macd/macdSignal, bandas de Bollinger, estocástico %K/%D, Williams %R, CCI20, canal de Donchian) vía `buildChartSeries` (`src/strategy/chart.ts`, datos de `getRecentOhlcBars`). El frontend elige qué campos mostrar como overlay según las condiciones activas del símbolo (`CONDITION_CHART_CONFIG`, ver "Resumen por símbolo" más abajo).
- `POST /api/trading/run` - ejecuta `src/tradingRunner.ts` (misma lógica que `npm run trade`); **coloca/cierra órdenes reales en la cuenta paper de Alpaca**.
- `POST /api/backtesting/run` - corre el backtest del watchlist completo y lo persiste (ver más arriba).
- `GET /api/backtesting/results` - última corrida de backtest persistida, con sus trades.
- `GET /api/conditions` - condición técnica activa de cada símbolo (`symbol_conditions`) + catálogo completo de las 12 condiciones disponibles (ver "Fase 6: estrategia multi-condicional por símbolo" más arriba).
- `GET /api/assessments` - última evaluación de IA (Claude) por símbolo (ver más arriba). Devuelve `[]` mientras la fase de IA no haya corrido (p.ej. si falló la última llamada a Claude).
- `GET /api/settings` / `POST /api/settings` - leer/guardar el perfil de riesgo, preset y modelo de Claude activos (`bot_settings`, ver más arriba).
- `POST /api/settings/trading-enabled` - activar/desactivar el interruptor de órdenes a Alpaca (`bot_settings.trading_enabled`, ver "Interruptor ON/OFF de órdenes a Alpaca" más arriba).
- `GET /api/snapshots` - lista los snapshots más recientes (ingesta + trading, hasta 30) guardados en MinIO, con `{ key, size, lastModified, type: 'ingest' | 'trading' }` (ver más arriba).
- `GET /api/snapshots/download?key=...` - descarga el contenido JSON de un snapshot. Valida que `key` tenga el formato `(ingest|trading)/<...>.json` para evitar acceso a otros objetos del bucket.

### Sección "Resumen por símbolo" del frontend

Sección única que fusiona trading, evaluaciones de IA y backtesting - reemplaza las antiguas secciones separadas "Trading (paper)", "Evaluaciones de IA (Claude)" y "Backtesting". Muestra primero los datos de cuenta (`GET /api/trading/status`) y el resumen de la última corrida de backtest (período cubierto + resumen de portafolio, `GET /api/backtesting/results`).

A continuación, dos tablas de resumen (Fase 6.1):

- **Resumen de señales** (`#signals-summary-table`, `renderSignalsSummaryTable`): una fila por símbolo (los 20, en el orden devuelto por `GET /api/trading/status`) con columnas Símbolo, Tipo (ETF/Stock), Señal (badge BUY/SELL/HOLD), Condición activa y Motivo (`reason`, con los valores de indicador de `condition.describe()`).
- **Condiciones por símbolo (backtest)** (`#conditions-table`, `renderConditionsTable`): una fila por símbolo con la condición ganadora y las métricas de `GET /api/conditions` (Trades, Win rate, Retorno total, Retorno prom., Max drawdown, Actualizado) - justifica por qué `npm run backtest` eligió esa condición para ese símbolo.

Luego, dos sub-secciones, **ETFs** y **Acciones**, con una **tarjeta por símbolo** (`renderSymbolCard`) que funciona como mini-informe:

- **Encabezado**: símbolo + badge de señal (`BUY`/`SELL`/`HOLD`).
- **Datos**: Precio, **Condición activa** (Fase 6), SMA10, SMA30, RSI, Momentum, **Precio est. entrada**, **Precio est. salida** y el motivo de la señal.
- **Posición abierta** (si existe): cantidad, precio de entrada, precio actual, valor y P/L no realizado (desde `positions` de `/api/trading/status`).
- **Gráfico** (`/api/trading/chart/:symbol`): Precio (azul) + overlays específicos de la **condición activa** del símbolo (Fase 6.1, `CONDITION_CHART_CONFIG` en `public/app.js`) - p.ej. SMA10/SMA30 para `sma_cross_10_30`, SMA20/SMA50 para `sma_cross_20_50`, EMA12/EMA26 para `ema_cross_12_26`, bandas de Bollinger para `bollinger_reversion`/`bollinger_breakout`, o el canal de Donchian para `donchian_breakout_20`, todos en el eje de precio (`y`). Las condiciones basadas en osciladores (`macd_cross`, `rsi_reversal_30_70`, `stochastic_cross`, `williams_r_reversal`, `cci_reversal`, y el RSI de `trend_pullback_sma50`) agregan un panel secundario (eje `y1`, a la derecha) con sus series y líneas punteadas grises en los umbrales de la condición (p.ej. 30/70 para RSI, 20/80 para el Estocástico, -80/-20 para Williams %R). Siempre incluye franjas horizontales punteadas de Precio est. entrada (amarillo) y Precio est. salida (violeta) en el eje de precio. Si no hay datos históricos todavía, muestra un mensaje en vez del gráfico.
- **Evaluación de IA**: recomendación, score, confianza, fecha, ajuste entrada/salida (`—` si Claude no propuso nada) y justificación (desde `GET /api/assessments`), o "Sin evaluación todavía" si la fase de IA no corrió para ese símbolo.
- **Backtest**: trades, win rate, retorno total, retorno promedio y max drawdown (desde `summary.symbols` de `GET /api/backtesting/results`), o "Sin backtest todavía" si el símbolo no está en la última corrida.

Las tarjetas de cada sub-sección se ordenan de mayor a menor según `attractivenessScore(signal)` (`public/app.js`): puntaje compuesto que prioriza señal BUY > HOLD > SELL, y dentro de cada una favorece momentum positivo, RSI cercano a neutral (no sobrecomprado/sobrevendido) y tendencia alcista (SMA10 > SMA30).

Al final de la sección, dos tablas (igual que en la antigua sección "Trading (paper)"):

- **Posiciones abiertas**: Símbolo, Cantidad, Precio entrada, Precio actual, Valor, P/L no realizado.
- **Órdenes ejecutadas**: Fecha, Símbolo, Lado, Cantidad, Tipo, TP, SL, Estado (`GET /api/trading/status`, últimas 20).

Los botones "🤖 Ejecutar ciclo de trading" (`POST /api/trading/run`) y "📊 Ejecutar backtest" (`POST /api/backtesting/run`) están en el header de esta sección; ambos refrescan toda la sección (`loadSymbolReports()`) al terminar. Toda la sección se refresca automáticamente cada 60s.

### Sección "Snapshots (MinIO)" del frontend

Tabla (`renderSnapshots`) con columnas Tipo, Fecha, Tamaño y un enlace de descarga, poblada desde `GET /api/snapshots` (hasta 30 snapshots, ingesta + trading mezclados y ordenados por fecha). Se refresca con el botón "🔄 Actualizar" y automáticamente después de ejecutar una ingesta o un ciclo de trading desde el dashboard.

El resto del frontend (`public/index.html`, `public/app.js`, `public/styles.css`):

- Muestra una tarjeta por servicio con su estado (✅/❌) y detalle, refrescando cada 60s.
- Permite disparar la ingesta manualmente y ver el resultado.
- El dashboard "Vibe Bots - Overview" de Grafana ya **no** está embebido aquí (ver "Grafana" más abajo); `GRAFANA_PUBLIC_URL` queda configurado pero sin uso desde `public/`.

`src/diagnostics.ts` y `src/ingestRunner.ts` son los módulos compartidos: `src/index.ts` (CLI) y `src/ingest.ts` (CLI) son ahora wrappers delgados sobre ellos, para que la CLI y el dashboard web ejecuten exactamente la misma lógica.

### Levantar/parar el dashboard web

PostgreSQL, Redis, MinIO y Grafana ya corren como servicios nativos (systemd) con autostart. El dashboard web de Vibe Bots **no** está configurado como servicio systemd (decisión deliberada, para no agregar autostart a nivel de sistema sin pedirlo explícitamente); se maneja con scripts simples:

- `npm run web:start` (o `./scripts/start-web.sh`) - lo levanta en background con `nohup`, guarda el PID en `run/web.pid` y los logs en `logs/web.log`.
- `npm run web:stop` (o `./scripts/stop-web.sh`) - lo detiene usando `run/web.pid`.
- `npm run status` (o `./scripts/status.sh`) - muestra el estado de los servicios nativos y si el dashboard web está arriba (con un check a `/api/health`).

> Si reinicias la instancia, los servicios nativos vuelven solos pero el dashboard web hay que volver a levantarlo con `npm run web:start`. Un cron watchdog (`*/5 * * * *`) lo reinicia automáticamente si cae mientras la instancia sigue corriendo (ver "Automatización"). `src/server.ts` tiene handlers globales `uncaughtException`/`unhandledRejection` para que errores async (Redis disconnect, timeout de Alpaca) no terminen el proceso.

## Grafana

Grafana corre como servicio nativo (`systemctl status grafana-server`) en `http://localhost:3000`.

- Datasource "PostgreSQL - vibe" provisionado en `/etc/grafana/provisioning/datasources/vibe-postgres.yaml`, apuntando a la misma base `vibe` y usuario (`vibe_bot`) que usa el bot.
- Login inicial: `admin` / `admin` (Grafana pide cambiarla en el primer ingreso).
- Dashboard "Vibe Bots - Overview" (`grafana/dashboards/vibe-overview.json`, uid `vibe-bots-overview`): precio de cierre del watchlist (30 días), noticias recientes, indicadores macro (FRED) y fundamentales (FMP). Se crea/actualiza vía API (`POST /api/dashboards/db` con `admin:admin`).
- Dashboard de trading en Grafana (`grafana/dashboards/vibe-trading.json`, uid `vibe-bots-trading`): historial de señales (`trading_signals`, con precio/SMA10/SMA30/RSI/momentum/precio est. entrada/precio est. salida/señal), evolución de precio y RSI por símbolo, y órdenes recientes (`trading_orders`). Se crea/actualiza igual que el anterior, vía API. No está embebido en el dashboard web (solo accesible vía Grafana con login).
- **Embedding**: `/etc/grafana/grafana.ini` tiene `[security] allow_embedding = true` (cambio manual a nivel de sistema, fuera de este repo). `auth.anonymous` permanece deshabilitado.
- **Acceso público acotado**: el dashboard "Vibe Bots - Overview" está compartido como [Public Dashboard](https://grafana.com/docs/grafana/latest/dashboards/sharing-dashboards-panels/shared-dashboards/) (`POST /api/dashboards/uid/<uid>/public-dashboards`), por lo que es accesible sin login solo a través de su URL pública (`GRAFANA_PUBLIC_URL`). El resto de Grafana (admin, otros dashboards) sigue requiriendo autenticación.

> ⏳ **Pendiente**: ambos dashboards tienen `fieldConfig.defaults.custom` agregado a los paneles de tipo `timeseries` (versión 2, re-publicados vía API), pero al momento de escribir esto los paneles seguían sin mostrar datos visualmente. El iframe de "Vibe Bots - Overview" se quitó del dashboard web (2026-06-14, ver "Sección 'Resumen por símbolo'"); Grafana en sí sigue corriendo igual, accesible directamente. Queda pendiente de diagnóstico/verificación visual; no es bloqueante para el resto de la funcionalidad del bot (ver "Próximas fases" al final).

## Base de datos - tablas clave

- `market_bars`, `news_items`, `fundamentals_snapshots`, `macro_series` - ver "Ingesta de datos" más arriba.
- `trading_signals` - una fila por señal calculada en cada `runTradingCycle()`: `symbol, ts, price, sma_fast, sma_slow, rsi, momentum, estimated_entry_price, estimated_exit_price, signal, reason, buy_condition_id, buy_condition_label, sell_condition_id, sell_condition_label` (Fase 7 — las últimas 4 columnas reemplazaron `condition_id`/`condition_label` de Fase 6).
- `trading_orders` - una fila por orden ejecutada (o error): `signal_id` (FK a `trading_signals`), `symbol, ts, side, qty, order_type, alpaca_order_id, take_profit_price, stop_loss_price, status, raw` (JSONB con la respuesta completa de Alpaca).
- `ai_assessments` (independiente, sin FK): `symbol, ts, score, recommendation, confidence, rationale, model, adjusted_entry_price, adjusted_exit_price` - una fila por símbolo en cada ciclo donde corrió la fase de IA (ver "Capa de IA (Claude)" más arriba). Las dos últimas columnas son las propuestas crudas de Claude antes del recorte ±10%.
- `backtest_runs`: `id, run_at, symbols, start_date, end_date, params JSONB, summary JSONB`.
- `backtest_trades`: `id, run_id` (FK a `backtest_runs`), `symbol, entry_date, entry_price, exit_date, exit_price, exit_reason, pnl_pct` (ver "Backtesting" más arriba).
- `bot_settings` (singleton `id=1`): `risk_preset, position_size_pct, stop_loss_pct, take_profit_pct, max_positions, claude_model, trading_enabled, exit_mode, updated_at` - perfil de riesgo, modelo de Claude, modo de salida (`'signal_only'` activo / `'bracket'`) e interruptor ON/OFF (ver "Configuración dinámica (`bot_settings`)" más arriba).
- `symbol_conditions` (PK `symbol`): `timeframe, buy_condition_id, buy_condition_label, sell_condition_id, sell_condition_label, trades, win_rate_pct, total_return_pct, avg_return_pct, max_drawdown_pct, updated_at` - par ganador (compra + venta) por símbolo, calculado por `npm run backtest` sobre 144 combos, leído por `runTradingCycle()`/`GET /api/trading/status` (ver "Fase 7" más arriba).

`setupTradingSchema` (`src/services/tradingStore.ts`) crea las tablas si no existen y agrega columnas nuevas vía `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (no hay framework de migraciones). Se ejecuta al inicio de `runTradingCycle()`; `GET /api/trading/status` no la ejecuta, así que columnas nuevas deben existir ya en la base (aplicadas manualmente o mediante un `npm run trade` previo) para que ese endpoint no falle. `setupBacktestSchema` (`src/services/backtestStore.ts`) crea `backtest_runs`/`backtest_trades` y se ejecuta al inicio de `runBacktestForWatchlist()` y de `GET /api/backtesting/results`.

## Arquitectura para futuros agentes de código

Ver también `CLAUDE.md` (contexto denso para Claude Code) y `AGENTS.md` (reglas para agentes IA en general), pensados para retener contexto entre sesiones/compactaciones.

Mapa rápido de módulos (todos operativos):

1. **Ingesta de datos en PostgreSQL** (`src/ingest.ts`, `src/ingestRunner.ts`): bars, noticias, fundamentales y series macro para 20 símbolos (11 ETFs + 9 acciones).
2. **Redis** (`src/services/cache.ts`, ver sección "Caché en Redis"): quotes de Finnhub, resultados de `/api/health` por API externa (TTLs según cuota, p.ej. 2h para Alpha Vantage) y estado de Alpaca (cuenta/posiciones/órdenes abiertas) compartido entre `runTradingCycle()` y `GET /api/trading/status` para reducir llamadas a Alpaca desde el polling del dashboard.
3. **Dashboard web** (`src/server.ts` + `public/`): health checks, ingesta manual, interruptor ON/OFF de órdenes a Alpaca (header), sección "Configuración" y sección "Resumen por símbolo" (un mini-informe por símbolo - señal/gráfico, evaluación de IA y backtest -, ETF/Acciones, ranking por atractivo, terminando con posiciones abiertas y órdenes ejecutadas).
4. **Estrategia + ejecución automática de órdenes vía Alpaca** (`src/strategy/`, `src/tradingRunner.ts`, `npm run trade`): cada símbolo opera con su propio **par ganador de condiciones** (compra + venta independientes, Fase 7, `symbol_conditions`, elegido de 144 combos = 12×12, fallback `sma_cross_10_30`), con SMA10/SMA30/RSI/momentum siempre calculados como contexto general, precio estimado de entrada/salida generalizado por condición, perfil de riesgo dinámico (`bot_settings`) y órdenes límite simples en modo `signal_only` en paper - salvo que el interruptor ON/OFF del dashboard esté en OFF (`TRADING_DISABLED`). Persistencia en `trading_signals`/`trading_orders`, expuesto en `/api/trading/*`, dashboard web y Grafana.
5. **Snapshots de ingesta/trading en MinIO** (`src/services/storage.ts`): cada `npm run ingest`/`npm run trade` sube un snapshot JSON crudo (`ingest/<ts>.json` / `trading/<ts>.json`), listado y descargable desde el dashboard (`GET /api/snapshots`, `GET /api/snapshots/download`). Subida best-effort (no rompe la corrida si MinIO falla). Backup periódico de PostgreSQL a MinIO queda diferido (ver roadmap).
6. **Backtesting** (`src/strategy/backtest.ts`, `src/backtestRunner.ts`, `npm run backtest`): para cada símbolo, corre las **144 combinaciones** (12×12, Fase 7) `(buyConditionId, sellConditionId)` con el motor real de orden límite sobre el histórico de `market_bars`, usando `settings.exitMode` de `bot_settings`; persiste el par ganador en `symbol_conditions` y los trades/resumen en `backtest_runs`/`backtest_trades`, expuesto en `/api/backtesting/*`, `/api/conditions` y, por símbolo, en la sección "Resumen por símbolo" del dashboard. `npm run backfill-history` (opcional, no corrido aún) amplía el histórico a 2100 días para backtests más robustos.
7. **Capa de IA (Claude)** (`src/services/claude.ts`, `src/tradingRunner.ts`): **activa desde 2026-06-14** (`ANTHROPIC_API_KEY` configurada) - evaluación batched (técnico + precios estimados + fundamentales FMP + noticias + macro FRED) que puede vetar señales BUY (`AI_BLOCKED`) y proponer ajustes acotados a `estimatedEntryPrice`/`estimatedExitPrice`; persistida en `ai_assessments` y expuesta en `GET /api/assessments` + sección "Resumen por símbolo" del dashboard. Fail-open si la llamada a Claude falla.
8. **Configuración dinámica** (`bot_settings`, `src/services/settingsStore.ts`): perfil de riesgo (con presets Conservador/Moderado/Agresivo/Personalizado), modelo de Claude (lista curada de 3), límite de ajuste de precios de IA (±10%) e interruptor ON/OFF de órdenes a Alpaca (`trading_enabled`), editables desde el dashboard (`GET`/`POST /api/settings`, `POST /api/settings/trading-enabled`) y leídos en caliente por `runTradingCycle()`/`runBacktestForWatchlist()`/`GET /api/trading/status`. `RISK_PROFILE`/`RISK_PROFILE_PRESETS` (`strategy/config.ts`) quedan como defaults/semillas.

## Próximas fases (mejoras propuestas)

Ideas de evolución, no implementadas todavía - priorizar según valor/esfuerzo:

1. **Backtesting de portafolio (v2)**: hoy cada símbolo se simula de forma independiente (% de retorno aislado, sin equity/cash compartido ni cap real de posiciones simultáneas); modelar el portafolio completo daría retornos más realistas y comparables al trading en vivo.
2. **Backfill histórico**: ejecutar `npm run backfill-history` (ya implementado, nunca corrido) para extender `market_bars` de ~150 a ~2100 días (~5.8 años, límite real de Alpaca IEX free) y tener backtests con más regímenes de mercado.
3. **Backups automáticos de PostgreSQL**: `pg_dump` periódico (cron) subido a MinIO junto a los snapshots de ingesta/trading.
4. **Verificación visual de Grafana**: los paneles `timeseries` del Public Dashboard "Vibe Bots - Overview" no muestran datos pese a `fieldConfig.defaults.custom`; diagnosticar y corregir (independiente del dashboard web, donde el iframe ya no está embebido).
5. **Cron intradía**: evaluar `*/30 13-21 * * 1-5` (cada 30 min) si se requiere reaccionar más rápido a fills de órdenes límite o señales SELL.
6. **Tests automatizados**: no hay suite de tests; agregar unit tests para `strategy/` (señales, backtest, `applyPriceAdjustment`) e integración para `settingsStore`/`tradingRunner`.
7. **Escalado de la capa de IA**: si el watchlist crece, dividir la llamada batched a Claude en lotes para no exceder límites de tokens/tool-use; considerar evaluación incremental (solo símbolos con señal BUY).
8. **Historial de configuración**: `bot_settings` es una fila singleton sin auditoría; agregar una tabla `bot_settings_history` para ver cuándo/quién cambió el perfil de riesgo o el modelo de Claude.
9. **Watchlist dinámica**: `WATCHLIST` es una constante en código (`src/watchlist.ts`); permitir agregar/quitar símbolos desde el dashboard, igual que `bot_settings`.
10. **Alertas**: notificaciones (email/Telegram/Slack) ante `AI_BLOCKED`, ajustes de precio de IA descartados por exceder ±10%, o fallos repetidos de la capa de IA/ingesta.
