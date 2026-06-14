# Vibe Bots

Proyecto de bot trader en TypeScript diseñado para correr en una instancia LXD con servicios nativos.

Estado actual: **Fase 1** (ingesta), **Fase 1.5** (dashboard web) y **Fase 2** (estrategia + ejecución automática en paper) operativas.

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
- Express para el dashboard web (health checks, ingesta manual, panel de trading y panel de Grafana embebido)

> No se usa Docker en el entorno actual. Los archivos `Dockerfile`, `docker-compose.yml` y `docker/` ya no forman parte de la arquitectura activa.

## Comandos

- `npm install` - instalar dependencias Node
- `npm run build` - compilar TypeScript
- `npm start` - ejecutar el bot compilado
- `npm run dev` - ejecutar diagnóstico completo con `ts-node`
- `npm run ingest` - ejecutar la ingesta de datos de mercado (Fase 1)
- `npm run trade` - ejecutar un ciclo de trading (Fase 2, paper): calcula señales, aplica el perfil de riesgo y coloca/cierra bracket orders en Alpaca paper
- `npm run web` - levantar el dashboard web (Fase 1.5+) en primer plano, en `http://0.0.0.0:4000`
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

# Dashboard web (Fase 1.5)
WEB_PORT=4000
GRAFANA_PUBLIC_URL=
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

`src/ingest.ts` corre la ingesta inicial de datos de mercado para el watchlist (`src/watchlist.ts`) y la guarda en PostgreSQL (`src/services/marketStore.ts` crea las tablas si no existen):

- **Watchlist** (28 símbolos, `WATCHLIST` en `src/watchlist.ts`): 15 ETFs (`ETF_SYMBOLS`: `SPY, QQQ, SCHE, SCHF, XLP, XLU, XMMO, VUG, DBEZ, PPA, SCHG, SCHD, SPMO, QQQM, SOXQ`) + 13 acciones (`AAPL, MSFT, NVDA, NECB, REG, TOL, AMZN, TSM, AVGO, GOOGL, MU, AGM, MS`). `ETF_SYMBOLS` es el subconjunto de `WATCHLIST` que el dashboard clasifica como "ETF"; el resto se clasifica como "Acciones".
- **`market_bars`**: bars diarias (`BARS_LOOKBACK_DAYS` = 220 días calendario, ~150 sesiones, suficiente para SMA30+RSI14 con margen) desde Alpaca Market Data API (feed IEX).
- **`news_items`**: noticias del watchlist desde Alpaca News API (Benzinga).
- **`fundamentals_snapshots`**: perfil/fundamentales por símbolo desde FMP (`JSONB`, un snapshot por corrida).
- **`macro_series`**: observaciones de FRED para `FEDFUNDS`, `CPIAUCSL`, `UNRATE`.

Además cachea en Redis el último quote de Finnhub por símbolo (`quote:<SYMBOL>`, TTL 5 min) para consumo rápido por el bot.

> ⚠️ Alpha Vantage tiene un free tier muy limitado (~25 requests/día). Su cliente (`src/services/alphaVantage.ts`) está disponible y se prueba en el diagnóstico, pero **no** se usa en la ingesta recurrente para no agotar la cuota.

> ℹ️ El endpoint `/v2/stocks/bars` de Alpaca aplica el parámetro `limit` al **total de barras de la respuesta** (suma de todos los símbolos), no por símbolo. `getDailyBars` (`src/services/marketData.ts`) usa `limit: 10000` para evitar que, con 28 símbolos x ~150 sesiones (~4200 barras), el watchlist se trunque alfabéticamente y los últimos símbolos queden sin histórico suficiente para SMA30.

## Trading automatizado (`npm run trade`) - Fase 2 (paper)

`src/trade.ts` (CLI) y `src/tradingRunner.ts` (lógica compartida, también usada por `POST /api/trading/run`) ejecutan un ciclo completo de trading sobre el watchlist, **operando contra la cuenta paper de Alpaca** (`ALPACA_BASE_URL=https://paper-api.alpaca.markets`).

### Estrategia (`src/strategy/`)

- **Indicadores** (`indicators.ts`): SMA, RSI (versión simplificada, sin suavizado de Wilder), momentum (% de retorno) y `estimateEntryPrice`.
- **Parámetros** (`config.ts`, `STRATEGY_PARAMS`): SMA rápida = 10, SMA lenta = 30, RSI(14) con umbral de sobrecompra 70, momentum a 10 periodos.
- **Señales** (`signals.ts`, `computeSignal`) - cada `SignalResult` incluye:
  - **BUY**: cruce alcista de SMA10 sobre SMA30 (golden cross), confirmado con RSI < 70 (no sobrecomprado) y momentum positivo.
  - **SELL**: cruce bajista de SMA10 bajo SMA30 (death cross).
  - **HOLD**: sin cruce, o sin suficiente histórico (`market_bars`) para calcular SMA30+1.
  - **`estimatedEntryPrice`**: precio de cierre que haría que la SMA10 de la próxima sesión alcance la SMA30 actual (`estimateEntryPrice` en `indicators.ts`) - una aproximación de "precio justo de entrada" para un cruce alcista.
  - **`estimatedExitPrice`**: `estimatedEntryPrice * (1 + RISK_PROFILE.takeProfitPct)` - precio objetivo de take-profit relativo a ese precio estimado de entrada. `null` cuando `estimatedEntryPrice` es `null` (histórico insuficiente).

### Gestión de riesgo (`config.ts`, `RISK_PROFILE` - perfil moderado)

- Tamaño de posición: 10% del equity de la cuenta por símbolo (calculado sobre el precio de mercado actual, `signal.price`).
- Stop-loss: -3% / Take-profit: +6% (ratio 2:1), calculados sobre `estimatedEntryPrice` (no sobre el precio de mercado actual), vía **bracket orders** de Alpaca (`order_class: 'bracket'`).
- Máximo 5 posiciones simultáneas (todo el watchlist).

### Ciclo de trading (`runTradingCycle`)

Para cada símbolo del watchlist: lee los últimos cierres (`getCloses`), calcula la señal y la persiste en `trading_signals`, y según la señal:

- **BUY**: si no hay posición ni orden pendiente para el símbolo y no se alcanzó el máximo de posiciones, calcula la cantidad (`equity * 10% / precio actual`, mínimo 1 acción) y coloca una **bracket order de compra LÍMITE** (`type: 'limit'`) al `estimatedEntryPrice`, con `take_profit.limit_price = estimatedExitPrice` y `stop_loss.stop_price = estimatedEntryPrice * (1 - stopLossPct)`. Si `estimatedEntryPrice` no está disponible, usa el precio de mercado actual como respaldo.
- **SELL**: si hay una posición abierta, cancela órdenes pendientes del símbolo y cierra la posición a mercado.
- **HOLD**: sin acción.

Cada orden ejecutada (o error) se registra en `trading_orders`, vinculada a la señal que la originó. La respuesta cruda de Alpaca (incluyendo el `limit_price` real enviado) queda en la columna `raw` (JSONB).

> ⚠️ Como la orden de compra es ahora una orden **límite** (no a mercado), puede quedar pendiente sin ejecutarse si el precio de mercado nunca llega al `estimatedEntryPrice` durante la sesión (`time_in_force: 'day'`).

### Exposición vía API/web

- `GET /api/trading/status`: cuenta (equity/cash/buying power), posiciones abiertas, órdenes recientes y **señales recalculadas en el momento** (no cacheadas) para los 28 símbolos del watchlist, cada una etiquetada como `type: 'ETF' | 'STOCK'` según `ETF_SYMBOLS`.
- `POST /api/trading/run`: ejecuta `runTradingCycle()` (misma lógica que `npm run trade`) - **coloca/cierra órdenes reales en la cuenta paper**.
- El frontend (`public/`) tiene una sección "Trading (Fase 2 - paper)" con estas tablas, gráficos por símbolo y un botón "Ejecutar ciclo de trading" que pide confirmación antes de llamar a `POST /api/trading/run`.

> ⚠️ Tanto `npm run trade` como el botón del dashboard y `POST /api/trading/run` colocan órdenes reales (con dinero simulado) en la cuenta **paper** de Alpaca. No hay modo "solo simulación" adicional en esta fase: el "paper" de Alpaca ya es el entorno de prueba.

## Dashboard web (`npm run web`) - Fase 1.5

`src/server.ts` levanta un servidor Express (puerto `WEB_PORT`, por defecto `4000`) que sirve un frontend estático (`public/`) y una API mínima:

- `GET /` - dashboard web (health checks, botón de ingesta, panel de trading y panel de Grafana embebido).
- `GET /api/health` - ejecuta las 9 verificaciones de `src/diagnostics.ts` (las mismas que `npm run dev`) y devuelve JSON con el estado de cada servicio.
- `GET /api/config` - expone configuración pública para el frontend (por ahora, `grafanaPublicUrl`).
- `POST /api/ingest` - ejecuta `src/ingestRunner.ts` (misma lógica que `npm run ingest`) y devuelve un resumen JSON.
- `GET /api/trading/status` - cuenta, posiciones, señales (frescas, ETF + Acciones) y órdenes recientes (Fase 2, ver más arriba).
- `GET /api/trading/chart/:symbol` - serie de los últimos `CHART_LOOKBACK_BARS` (90) cierres + SMA10/SMA30/RSI para un símbolo (`buildChartSeries` en `src/strategy/chart.ts`, datos de `getRecentBars`).
- `POST /api/trading/run` - ejecuta `src/tradingRunner.ts` (misma lógica que `npm run trade`); **coloca/cierra órdenes reales en la cuenta paper de Alpaca**.

### Sección "Trading (Fase 2 - paper)" del frontend

El panel se divide en dos sub-secciones, **ETFs** y **Acciones**, cada una con:

- Una tabla (`renderSignalsTable`) con columnas: Símbolo, Precio, SMA10, SMA30, RSI, Mom., **Precio est. entrada**, **Precio est. salida**, Señal, Motivo.
- Una lista de gráficos por símbolo (uno debajo del otro, ancho completo - `.chart-grid` en columna), cada uno con:
  - Línea de **Precio** (cierre diario, azul).
  - Línea de **SMA10** (verde) y **SMA30** (naranja).
  - Franja horizontal punteada de **Precio est. entrada** (amarillo).
  - Franja horizontal punteada de **Precio est. salida** (violeta).
  - Si no hay datos históricos todavía, muestra un mensaje en vez del gráfico.

Ambas sub-secciones (tabla y gráficos) se ordenan de mayor a menor según `attractivenessScore(signal)` (`public/app.js`): puntaje compuesto que prioriza señal BUY > HOLD > SELL, y dentro de cada una favorece momentum positivo, RSI cercano a neutral (no sobrecomprado/sobrevendido) y tendencia alcista (SMA10 > SMA30).

El resto del frontend (`public/index.html`, `public/app.js`, `public/styles.css`):

- Muestra una tarjeta por servicio con su estado (✅/❌) y detalle, refrescando cada 60s.
- Permite disparar la ingesta manualmente y ver el resultado.
- Embebe el dashboard "Vibe Bots - Overview" de Grafana vía `<iframe>`, usando la URL de `GRAFANA_PUBLIC_URL`.

`src/diagnostics.ts` y `src/ingestRunner.ts` son los módulos compartidos: `src/index.ts` (CLI) y `src/ingest.ts` (CLI) son ahora wrappers delgados sobre ellos, para que la CLI y el dashboard web ejecuten exactamente la misma lógica.

### Levantar/parar el dashboard web

PostgreSQL, Redis, MinIO y Grafana ya corren como servicios nativos (systemd) con autostart. El dashboard web de Vibe Bots **no** está configurado como servicio systemd (decisión deliberada, para no agregar autostart a nivel de sistema sin pedirlo explícitamente); se maneja con scripts simples:

- `npm run web:start` (o `./scripts/start-web.sh`) - lo levanta en background con `nohup`, guarda el PID en `run/web.pid` y los logs en `logs/web.log`.
- `npm run web:stop` (o `./scripts/stop-web.sh`) - lo detiene usando `run/web.pid`.
- `npm run status` (o `./scripts/status.sh`) - muestra el estado de los servicios nativos y si el dashboard web está arriba (con un check a `/api/health`).

> Si reinicias la instancia, los servicios nativos vuelven solos pero el dashboard web hay que volver a levantarlo con `npm run web:start`.

## Grafana

Grafana corre como servicio nativo (`systemctl status grafana-server`) en `http://localhost:3000`.

- Datasource "PostgreSQL - vibe" provisionado en `/etc/grafana/provisioning/datasources/vibe-postgres.yaml`, apuntando a la misma base `vibe` y usuario (`vibe_bot`) que usa el bot.
- Login inicial: `admin` / `admin` (Grafana pide cambiarla en el primer ingreso).
- Dashboard "Vibe Bots - Overview" (`grafana/dashboards/vibe-overview.json`, uid `vibe-bots-overview`): precio de cierre del watchlist (30 días), noticias recientes, indicadores macro (FRED) y fundamentales (FMP). Se crea/actualiza vía API (`POST /api/dashboards/db` con `admin:admin`).
- Dashboard "Vibe Bots - Trading (Fase 2)" (`grafana/dashboards/vibe-trading.json`, uid `vibe-bots-trading`): historial de señales (`trading_signals`, con precio/SMA10/SMA30/RSI/momentum/precio est. entrada/precio est. salida/señal), evolución de precio y RSI por símbolo, y órdenes recientes (`trading_orders`). Se crea/actualiza igual que el anterior, vía API. No está embebido en el dashboard web (solo accesible vía Grafana con login).
- **Embedding**: `/etc/grafana/grafana.ini` tiene `[security] allow_embedding = true` (cambio manual a nivel de sistema, fuera de este repo). `auth.anonymous` permanece deshabilitado.
- **Acceso público acotado**: el dashboard "Vibe Bots - Overview" está compartido como [Public Dashboard](https://grafana.com/docs/grafana/latest/dashboards/sharing-dashboards-panels/shared-dashboards/) (`POST /api/dashboards/uid/<uid>/public-dashboards`), por lo que es accesible sin login solo a través de su URL pública (`GRAFANA_PUBLIC_URL`). El resto de Grafana (admin, otros dashboards) sigue requiriendo autenticación.

> ⏳ **Pendiente**: ambos dashboards tienen `fieldConfig.defaults.custom` agregado a los paneles de tipo `timeseries` (versión 2, re-publicados vía API), pero al momento de escribir esto los paneles seguían sin mostrar datos visualmente en el iframe embebido. Queda pendiente de diagnóstico/verificación visual; no es bloqueante para Fases 1/1.5/2.

## Base de datos - tablas clave

- `market_bars`, `news_items`, `fundamentals_snapshots`, `macro_series` - ver "Ingesta de datos" (Fase 1).
- `trading_signals` - una fila por señal calculada en cada `runTradingCycle()`: `symbol, ts, price, sma_fast, sma_slow, rsi, momentum, estimated_entry_price, estimated_exit_price, signal, reason`.
- `trading_orders` - una fila por orden ejecutada (o error): `signal_id` (FK a `trading_signals`), `symbol, ts, side, qty, order_type, alpaca_order_id, take_profit_price, stop_loss_price, status, raw` (JSONB con la respuesta completa de Alpaca).

`setupTradingSchema` (`src/services/tradingStore.ts`) crea las tablas si no existen y agrega columnas nuevas vía `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (no hay framework de migraciones). Se ejecuta al inicio de `runTradingCycle()`; `GET /api/trading/status` no la ejecuta, así que columnas nuevas deben existir ya en la base (aplicadas manualmente o mediante un `npm run trade` previo) para que ese endpoint no falle.

## Arquitectura para futuros agentes de código

Ver también `CLAUDE.md` para un resumen denso pensado para retener contexto entre sesiones/compactaciones.

Estado de las fases:

1. ✅ **Ingestión de datos en PostgreSQL** (Fase 1, `src/ingest.ts`): bars, noticias, fundamentales y series macro para 28 símbolos (15 ETFs + 13 acciones).
2. ✅ uso de Redis para caché de quotes (Finnhub) - pendiente extender a estado/colas de órdenes.
3. ✅ **Dashboard web** (Fase 1.5, `src/server.ts` + `public/`): health checks, ingesta manual, panel de trading (ETF/Acciones, ranking por atractivo, gráficos con bandas de entrada/salida) y panel de Grafana embebido (Public Dashboard, ⏳ sin verificación visual completa).
4. ✅ **Estrategia + ejecución automática de órdenes vía Alpaca** (Fase 2, `src/strategy/`, `src/tradingRunner.ts`, `npm run trade`): señales SMA10/SMA30 + RSI + momentum, precio estimado de entrada/salida, perfil de riesgo moderado y bracket orders **límite** en paper. Persistencia en `trading_signals`/`trading_orders`, expuesto en `/api/trading/*`, dashboard web y Grafana.
5. ⬜ almacenamiento de archivos y snapshots en MinIO (aún solo health-check).
6. ⬜ backtesting y capa de IA (Claude) combinando indicadores técnicos + fundamentales (FMP) + sentimiento (noticias/Alpha Vantage) + contexto macro (FRED), visualizado en Grafana.
