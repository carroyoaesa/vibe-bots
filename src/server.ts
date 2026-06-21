import path from 'path';
import express from 'express';
import { loadWebConfig, loadAlpacaConfig, loadPostgresConfig, loadMinioConfig, loadRedisConfig } from './config';
import { runDiagnostics } from './diagnostics';
import { runIngest } from './ingestRunner';
import { runTradingCycle } from './tradingRunner';
import { createPostgresPool } from './services/db';
import { createMinioClient, listSnapshots, getSnapshotStream } from './services/storage';
import { createAlpacaClient, getAccount, getPositions, getMarketClock, AlpacaOrder, ACCOUNT_GROUPS, AccountGroup, getAlpacaClient, placeSellOrder, cancelOrder } from './services/alpaca';
import { setupOperationsSyncSchema, syncAccountState, syncAllAccounts } from './services/operationsSync';
import { startOperationsPoller, POLLER_INTERVAL_SECONDS } from './operationsPoller';
import { computeExitPriceEstimate } from './services/exitPriceEstimate';
import {
  createRedisClient,
  getCachedJson,
  getCachedOrFetch,
  ALPACA_ACCOUNT_CACHE_KEY,
  ALPACA_ACCOUNT_CACHE_TTL_SECONDS,
  ALPACA_POSITIONS_CACHE_KEY,
  ALPACA_POSITIONS_CACHE_TTL_SECONDS,
  ALPACA_OPEN_ORDERS_CACHE_KEY,
} from './services/cache';
import { setupTradingSchema, getRecentOrders, getLatestAssessments, getLatestSignals } from './services/tradingStore';
import { getRecentOhlcBars, getRecentOhlcBars1H } from './services/marketStore';
import { createMarketDataClient, getAdjustedCloses } from './services/marketData';
import { buildChartSeries, buildChartSeries1H } from './strategy/chart';
import { computeSignal } from './strategy/signals';
import { labelConditionExpr } from './strategy/conditionExpr';
import { CONDITIONS, DEFAULT_CONDITION_ID } from './strategy/conditions';
import { RISK_PROFILE_PRESETS } from './strategy/config';
import { WATCHLIST, ETF_SYMBOLS } from './watchlist';
import { setupBacktestSchema, getLatestBacktestRun } from './services/backtestStore';
import { runBacktestForWatchlist, runBacktestForGroup, runBacktestForAllGroups, BACKTEST_GROUPS, BacktestGroup } from './backtestRunner';
import { setupSettingsSchema, getSettings, saveSettings, setTradingEnabled, setClaudeExperimentEnabled } from './services/settingsStore';
import { setupConditionSchema, getSymbolConditions, getMainSymbolConditions } from './services/conditionStore';
import { CLAUDE_MODEL_OPTIONS } from './services/claude';
import { setupClaudeUsageSchema, getClaudeUsage, getTodayClaudeUsage } from './services/claudeUsageStore';
import { setupClaudeExperimentSchema, getExperimentSummary, getExperimentDisagreements, getExperimentCost } from './services/claudeExperimentStore';
import { MULTI_CONDITION_OVERRIDES } from './strategy/multiConditionOverrides';
import {
  setupSymbolClassificationSchema,
  getAllSymbolClassifications,
  setSymbolClassification,
  getSymbolClassification,
  classificationToAccountGroup,
  SYMBOL_CLASSIFICATION_STATUSES,
} from './services/symbolClassificationStore';

// Evita que errores async no manejados (p.ej. Redis disconnect, Alpaca timeout) maten el proceso.
// Node 18 termina en unhandledRejection por defecto; aquí lo degradamos a un log de error.
process.on('uncaughtException', (err) => {
  console.error('[FATAL uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[WARN unhandledRejection]', reason);
});

// Velas para el gráfico por símbolo: suficientes para que SMA50/EMA26/Donchian etc.
// (los indicadores de mayor período entre las 12 condiciones) tengan ~100 puntos
// válidos dentro de la ventana visible (Fase 6.1).
const CHART_LOOKBACK_BARS = 365;
const CHART_LOOKBACK_BARS_1H = 600;
// Velas (OHLC diarias) pedidas por símbolo para recalcular la señal de cada condición activa (Fase 6).
const BARS_LOOKBACK = 100;
const SNAPSHOT_KEY_PATTERN = /^(ingest|trading)\/[A-Za-z0-9_\-:.]+\.json$/;
const SNAPSHOTS_LIMIT = 30;

const config = loadWebConfig();
const app = express();

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

const VALID_ACCOUNT_GROUPS_OR_ALL = [...ACCOUNT_GROUPS, 'all'];

/** `?account=` -> lista de grupos a cubrir (`all` expande a los 3), o `null` si el valor no es válido. */
function parseAccountParam(value: unknown): AccountGroup[] | null {
  if (value === undefined || value === 'all') return [...ACCOUNT_GROUPS];
  if (typeof value === 'string' && (ACCOUNT_GROUPS as string[]).includes(value)) return [value as AccountGroup];
  return null;
}

// Poller de sincronización multi-cuenta (Fase Operaciones, 2026-06-18) - pool dedicado de
// larga vida (a diferencia del resto de las rutas, que abren/cierran un pool por request),
// igual patrón que cualquier proceso de fondo dentro de este mismo server.ts (nunca systemd,
// se gestiona con scripts/start-web.sh / stop-web.sh). Corre cada 60s, gateado a horario de
// mercado - ver `operationsPoller.ts`.
const operationsPool = createPostgresPool(loadPostgresConfig());
setupOperationsSyncSchema(operationsPool)
  .then(() => startOperationsPoller(operationsPool))
  .catch((error) => console.error('[server] No se pudo inicializar el esquema de sync multi-cuenta:', error));

app.get('/api/config', (_req, res) => {
  res.json({
    grafanaPublicUrl: config.grafanaPublicUrl ?? null,
  });
});

app.get('/api/health', async (_req, res) => {
  const checks = await runDiagnostics();
  const ok = checks.every((check) => check.ok);

  res.status(ok ? 200 : 503).json({
    ok,
    generatedAt: new Date().toISOString(),
    checks,
  });
});

app.get('/api/trading/status', async (_req, res) => {
  const pool = createPostgresPool(loadPostgresConfig());
  const alpacaClient = createAlpacaClient(loadAlpacaConfig());
  const redis = createRedisClient(loadRedisConfig());

  try {
    await setupSettingsSchema(pool);
    await setupConditionSchema(pool);
    const settings = await getSettings(pool);
    const symbolConditions = await getMainSymbolConditions(pool);

    const [account, positions, orders, latestSignals, openOrdersCache] = await Promise.all([
      // Cuenta y posiciones se cachean en Redis (TTLs cortos) y se comparten con el check
      // "alpaca" de /api/health y con runTradingCycle(), para no pedirle a Alpaca lo mismo
      // dos veces en cada poll de 60s del dashboard.
      getCachedOrFetch(redis, ALPACA_ACCOUNT_CACHE_KEY, ALPACA_ACCOUNT_CACHE_TTL_SECONDS, () => getAccount(alpacaClient)),
      getCachedOrFetch(redis, ALPACA_POSITIONS_CACHE_KEY, ALPACA_POSITIONS_CACHE_TTL_SECONDS, () => getPositions(alpacaClient)),
      getRecentOrders(pool, 20),
      getLatestSignals(pool),
      // Las órdenes abiertas solo se refrescan en runTradingCycle(); aquí se leen de caché
      // sin disparar una llamada extra a Alpaca (si no hay caché todavía, queda en null).
      getCachedJson<AlpacaOrder[]>(redis, ALPACA_OPEN_ORDERS_CACHE_KEY),
    ]);

    const latestBySymbol = new Map(latestSignals.map((row) => [row.symbol, row]));

    const signals = await Promise.all(
      WATCHLIST.map(async (symbol) => {
        const latest = latestBySymbol.get(symbol);
        const override = MULTI_CONDITION_OVERRIDES[symbol];
        // Fase 8: mismo orden de precedencia que tradingRunner.ts - el override de
        // 2-3 condiciones (si existe) gana sobre el pick de 1 condición de symbol_conditions.
        const signal = computeSignal(
          symbol,
          await getRecentOhlcBars(pool, symbol, BARS_LOOKBACK),
          settings.riskProfile,
          override?.buyExpr ?? symbolConditions.get(symbol)?.buyConditionId ?? DEFAULT_CONDITION_ID,
          override?.sellExpr ?? symbolConditions.get(symbol)?.sellConditionId ?? DEFAULT_CONDITION_ID,
          settings.exitMode
        );

        return {
          ...signal,
          estimatedEntryPrice: signal.estimatedEntryPrice ?? latest?.estimatedEntryPrice,
          estimatedExitPrice: signal.estimatedExitPrice ?? latest?.estimatedExitPrice,
          type: ETF_SYMBOLS.includes(symbol) ? ('ETF' as const) : ('STOCK' as const),
        };
      })
    );

    const openOrdersCount = openOrdersCache?.value.length ?? null;
    const openOrdersAt = openOrdersCache?.cachedAt ?? null;

    res.json({ ok: true, generatedAt: new Date().toISOString(), account, positions, signals, orders, openOrdersCount, openOrdersAt });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await redis.quit();
    await pool.end();
  }
});

app.get('/api/trading/chart/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();

  if (!WATCHLIST.includes(symbol)) {
    res.status(404).json({ ok: false, error: `Símbolo no soportado: ${symbol}` });
    return;
  }

  const use1H = req.query.tf === '1H';
  const pool = createPostgresPool(loadPostgresConfig());

  try {
    if (use1H) {
      const bars = await getRecentOhlcBars1H(pool, symbol, CHART_LOOKBACK_BARS_1H);
      const points = buildChartSeries1H(bars);
      res.json({ ok: true, symbol, timeframe: '1Hour', points });
    } else {
      const bars = await getRecentOhlcBars(pool, symbol, CHART_LOOKBACK_BARS);
      const points = buildChartSeries(bars);
      res.json({ ok: true, symbol, timeframe: '1Day', points });
    }
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.post('/api/trading/run', async (_req, res) => {
  try {
    // Mismo guard que cronTrade.ts: el botón manual del dashboard no debe colocar
    // órdenes reales con el mercado cerrado (fines de semana/feriados) - antes de
    // este chequeo, un click manual fuera de horario igual ejecutaba el ciclo
    // completo y Alpaca encolaba la orden para la siguiente sesión sin avisar.
    const clock = await getMarketClock(createAlpacaClient(loadAlpacaConfig()));
    if (!clock.isOpen) {
      res.json({
        ok: true,
        skipped: true,
        reason: 'MARKET_CLOSED',
        message: `Mercado cerrado (próxima apertura: ${clock.nextOpen}). Ciclo no ejecutado.`,
        nextOpen: clock.nextOpen,
        finishedAt: new Date().toISOString(),
      });
      return;
    }

    const result = await runTradingCycle();
    res.json({ ok: true, finishedAt: new Date().toISOString(), ...result });
  } catch (error) {
    res.status(500).json({
      ok: false,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

const VALID_RISK_PRESETS = ['conservador', 'moderado', 'agresivo', 'flujo_de_caja', 'personalizado'];
const VALID_CLAUDE_MODELS = CLAUDE_MODEL_OPTIONS.map((model) => model.id);

app.get('/api/settings', async (_req, res) => {
  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupSettingsSchema(pool);
    const settings = await getSettings(pool);

    res.json({ ok: true, settings, presets: RISK_PROFILE_PRESETS, models: CLAUDE_MODEL_OPTIONS });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.post('/api/settings', async (req, res) => {
  const body = req.body ?? {};
  const { riskPreset, riskProfile } = body;
  const claudeModel = body.claudeModel ?? null;

  if (!VALID_RISK_PRESETS.includes(riskPreset)) {
    res.status(400).json({ ok: false, error: `riskPreset inválido: debe ser uno de ${VALID_RISK_PRESETS.join(', ')}.` });
    return;
  }

  if (
    typeof riskProfile !== 'object' || riskProfile === null ||
    typeof riskProfile.positionSizePct !== 'number' || riskProfile.positionSizePct <= 0 || riskProfile.positionSizePct > 1 ||
    typeof riskProfile.maxPositions !== 'number' || !Number.isInteger(riskProfile.maxPositions) ||
    riskProfile.maxPositions < 1 || riskProfile.maxPositions > 20
  ) {
    res.status(400).json({
      ok: false,
      error: 'riskProfile inválido: positionSizePct debe estar en (0,1] y maxPositions debe ser un entero entre 1 y 20.',
    });
    return;
  }

  if (claudeModel !== null && !VALID_CLAUDE_MODELS.includes(claudeModel)) {
    res.status(400).json({ ok: false, error: `claudeModel inválido: debe ser uno de ${VALID_CLAUDE_MODELS.join(', ')} o null.` });
    return;
  }

  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupSettingsSchema(pool);
    await saveSettings(pool, {
      riskPreset,
      riskProfile: {
        positionSizePct: riskProfile.positionSizePct,
        stopLossPct: 0.03,   // no se usa (siempre signal_only), mantenido en DB por compatibilidad
        takeProfitPct: 0.06, // no se usa (siempre signal_only), mantenido en DB por compatibilidad
        maxPositions: riskProfile.maxPositions,
      },
      claudeModel,
      exitMode: 'signal_only', // siempre: nunca se usan bracket orders
    });

    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.post('/api/settings/trading-enabled', async (req, res) => {
  const enabled = req.body?.enabled;

  if (typeof enabled !== 'boolean') {
    res.status(400).json({ ok: false, error: 'enabled debe ser boolean.' });
    return;
  }

  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupSettingsSchema(pool);
    await setTradingEnabled(pool, enabled);

    res.json({ ok: true, tradingEnabled: enabled, savedAt: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

// Tarea 4 (experimento de sesgo de Claude) - flag default false (ver setupSettingsSchema);
// activarlo/desactivarlo es siempre una acción manual y explícita del usuario, nunca automática.
app.post('/api/settings/claude-experiment-enabled', async (req, res) => {
  const enabled = req.body?.enabled;

  if (typeof enabled !== 'boolean') {
    res.status(400).json({ ok: false, error: 'enabled debe ser boolean.' });
    return;
  }

  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupSettingsSchema(pool);
    await setClaudeExperimentEnabled(pool, enabled);

    res.json({ ok: true, claudeExperimentEnabled: enabled, savedAt: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.post('/api/ingest', async (_req, res) => {
  try {
    const summary = await runIngest();
    res.json({ ok: true, finishedAt: new Date().toISOString(), summary });
  } catch (error) {
    res.status(500).json({
      ok: false,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/api/backtesting/run', async (_req, res) => {
  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupBacktestSchema(pool);
    const result = await runBacktestForWatchlist(pool);
    res.json({ ok: true, finishedAt: new Date().toISOString(), ...result });
  } catch (error) {
    res.status(500).json({
      ok: false,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await pool.end();
  }
});

app.get('/api/backtesting/results', async (_req, res) => {
  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupBacktestSchema(pool);
    const run = await getLatestBacktestRun(pool);
    res.json({ ok: true, generatedAt: new Date().toISOString(), run });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

const VALID_BACKTEST_GROUPS = [...BACKTEST_GROUPS, 'all'];

// Backtest segmentado por clasificación (backtest-by-classification, Fase 10) - rutas nuevas,
// no reemplazan /api/backtesting/run|results (legacy, sin filtrar por grupo, sin cambios).
app.post('/api/backtest/run', async (req, res) => {
  const group = req.body?.group;

  if (!VALID_BACKTEST_GROUPS.includes(group)) {
    res.status(400).json({ ok: false, error: `group inválido: debe ser uno de ${VALID_BACKTEST_GROUPS.join(', ')}.` });
    return;
  }

  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupBacktestSchema(pool);

    if (group === 'all') {
      const results = await runBacktestForAllGroups(pool);
      res.json({ ok: true, finishedAt: new Date().toISOString(), group: 'all', results });
    } else {
      const result = await runBacktestForGroup(pool, group as BacktestGroup);
      res.json({ ok: true, finishedAt: new Date().toISOString(), group, ...result });
    }
  } catch (error) {
    res.status(500).json({
      ok: false,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await pool.end();
  }
});

app.get('/api/backtest/results', async (req, res) => {
  const group = req.query.group as string | undefined;

  if (group !== undefined && !BACKTEST_GROUPS.includes(group as BacktestGroup)) {
    res.status(400).json({ ok: false, error: `group inválido: debe ser uno de ${BACKTEST_GROUPS.join(', ')} (u omitirse).` });
    return;
  }

  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupBacktestSchema(pool);
    const run = await getLatestBacktestRun(pool, group ?? null);
    res.json({ ok: true, generatedAt: new Date().toISOString(), group: group ?? null, run });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.get('/api/conditions', async (_req, res) => {
  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupConditionSchema(pool);
    await setupBacktestSchema(pool);
    const symbolConditions = await getSymbolConditions(pool);
    const latestRun = await getLatestBacktestRun(pool);

    const periodStart = latestRun?.run.startDate ? new Date(latestRun.run.startDate).toISOString().slice(0, 10) : null;
    const periodEnd = latestRun?.run.endDate ? new Date(latestRun.run.endDate).toISOString().slice(0, 10) : null;

    // Buy & Hold (con dividendos reinvertidos, adjustment=all) sobre el mismo
    // período del último backtest. Best-effort: si Alpaca falla, queda en null
    // y el resto de /api/conditions sigue funcionando igual.
    const buyHoldReturns = new Map<string, number>();
    if (periodStart && periodEnd) {
      try {
        const marketDataClient = createMarketDataClient(loadAlpacaConfig());
        const [startCloses, endCloses] = await Promise.all([
          getAdjustedCloses(marketDataClient, WATCHLIST, periodStart),
          getAdjustedCloses(marketDataClient, WATCHLIST, periodEnd),
        ]);

        for (const symbol of WATCHLIST) {
          const startClose = startCloses.get(symbol);
          const endClose = endCloses.get(symbol);
          if (startClose !== undefined && endClose !== undefined) {
            buyHoldReturns.set(symbol, ((endClose - startClose) / startClose) * 100);
          }
        }
      } catch (error) {
        console.warn('No se pudo calcular Buy & Hold con dividendos:', error instanceof Error ? error.message : error);
      }
    }

    const conditions: object[] = [];
    for (const symbol of WATCHLIST) {
      const rows = symbolConditions.get(symbol);
      const buyHoldReturnPct = buyHoldReturns.get(symbol) ?? null;
      const override = MULTI_CONDITION_OVERRIDES[symbol];
      // Fase 8: si hay override, `buyConditionId`/`sellConditionId` deben reflejar la
      // expresión REALMENTE activa (no la fila vieja de symbol_conditions, Fase 7) - pero
      // trades/winRate/retorno/drawdown siguen siendo los de la última corrida de
      // `npm run backtest` (1 condición, tier 1) porque ese loop no recalcula el override;
      // `overrideTier` le avisa al frontend que esas métricas no son del combo activo.
      const buyConditionId = override?.buyExpr;
      const buyConditionLabel = override ? labelConditionExpr(override.buyExpr) : undefined;
      const sellConditionId = override?.sellExpr;
      const sellConditionLabel = override ? labelConditionExpr(override.sellExpr) : undefined;

      if (!rows || rows.length === 0) {
        const buyCondition = CONDITIONS.find((c) => c.id === DEFAULT_CONDITION_ID) ?? CONDITIONS[0];
        conditions.push({
          symbol,
          timeframe: '1Day',
          system: 'main',
          buyConditionId: buyConditionId ?? buyCondition.id,
          buyConditionLabel: buyConditionLabel ?? buyCondition.label,
          sellConditionId: sellConditionId ?? buyCondition.id,
          sellConditionLabel: sellConditionLabel ?? buyCondition.label,
          trades: 0,
          winRatePct: null,
          totalReturnPct: 0,
          avgReturnPct: null,
          maxDrawdownPct: 0,
          updatedAt: null,
          buyHoldReturnPct,
          overrideTier: override?.tier ?? null,
        });
        continue;
      }

      for (const row of rows) {
        conditions.push({
          symbol,
          timeframe: row.timeframe,
          system: 'main',
          buyConditionId: buyConditionId ?? row.buyConditionId,
          buyConditionLabel: buyConditionLabel ?? row.buyConditionLabel,
          sellConditionId: sellConditionId ?? row.sellConditionId,
          sellConditionLabel: sellConditionLabel ?? row.sellConditionLabel,
          trades: row.trades,
          winRatePct: row.winRatePct,
          totalReturnPct: row.totalReturnPct,
          avgReturnPct: row.avgReturnPct,
          maxDrawdownPct: row.maxDrawdownPct,
          updatedAt: row.updatedAt,
          buyHoldReturnPct,
          overrideTier: override?.tier ?? null,
        });
      }
    }

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      conditions,
      catalog: CONDITIONS.map((c) => ({ id: c.id, label: c.label })),
      buyHoldPeriod: periodStart && periodEnd ? { start: periodStart, end: periodEnd } : null,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.get('/api/assessments', async (_req, res) => {
  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupTradingSchema(pool);
    const assessments = await getLatestAssessments(pool);
    res.json({ ok: true, generatedAt: new Date().toISOString(), assessments });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

// ── Visibilidad de costo de Claude (Tarea 5) - solo lectura, sin ningún bloqueo ────────────

function parseDaysParam(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 365) : fallback;
}

app.get('/api/claude-usage', async (req, res) => {
  const days = parseDaysParam(req.query.days, 30);
  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupClaudeUsageSchema(pool);
    const [today, history] = await Promise.all([getTodayClaudeUsage(pool), getClaudeUsage(pool, days)]);
    res.json({ ok: true, generatedAt: new Date().toISOString(), days, today, history });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

// ── Experimento de sesgo de Claude (Tarea 4) - solo lectura ─────────────────────────────────

app.get('/api/claude-experiment/summary', async (req, res) => {
  const days = parseDaysParam(req.query.days, 7);
  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupClaudeExperimentSchema(pool);
    const summary = await getExperimentSummary(pool, days);
    res.json({ ok: true, generatedAt: new Date().toISOString(), days, summary });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.get('/api/claude-experiment/disagreements', async (req, res) => {
  const days = parseDaysParam(req.query.days, 7);
  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupClaudeExperimentSchema(pool);
    const disagreements = await getExperimentDisagreements(pool, days);
    res.json({ ok: true, generatedAt: new Date().toISOString(), days, disagreements });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.get('/api/claude-experiment/cost', async (req, res) => {
  const days = parseDaysParam(req.query.days, 7);
  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupClaudeExperimentSchema(pool);
    const cost = await getExperimentCost(pool, days);
    res.json({ ok: true, generatedAt: new Date().toISOString(), days, cost });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.get('/api/symbol-classifications', async (_req, res) => {
  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupSymbolClassificationSchema(pool);
    const classifications = await getAllSymbolClassifications(pool);
    res.json(classifications);
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.post('/api/symbol-classifications/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const status = req.body?.status;

  if (!WATCHLIST.includes(symbol)) {
    res.status(400).json({ ok: false, error: `Símbolo no soportado: ${symbol}` });
    return;
  }

  if (!SYMBOL_CLASSIFICATION_STATUSES.includes(status)) {
    res.status(400).json({ ok: false, error: `status inválido: debe ser uno de ${SYMBOL_CLASSIFICATION_STATUSES.join(', ')}.` });
    return;
  }

  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupSymbolClassificationSchema(pool);
    await setSymbolClassification(pool, symbol, status);
    res.json({ ok: true, symbol, status, updatedAt: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

// ── Operaciones multi-cuenta (Fase 2026-06-18) ──────────────────────────────────────────
// Fuente de verdad: las tablas *_snapshot/account_state, escritas por el poller de 60s
// (operationsPoller.ts) y por POST /api/operations/sync - NUNCA se pega a trading_orders/
// trading_signals (historial propio del bot, posiblemente desactualizado/mezclado) para
// estas vistas. account_group de trading_orders/trading_signals queda como etiqueta de
// análisis (ver tradingRunner.ts), no como fuente de la tab Operaciones.

app.get('/api/operations', async (req, res) => {
  const groups = parseAccountParam(req.query.account);
  if (!groups) {
    res.status(400).json({ ok: false, error: `account inválido: debe ser uno de ${VALID_ACCOUNT_GROUPS_OR_ALL.join(', ')}.` });
    return;
  }

  const pool = createPostgresPool(loadPostgresConfig());
  try {
    await setupOperationsSyncSchema(pool);
    const accounts: Record<string, object> = {};

    for (const group of groups) {
      const [positions, pendingOrders, executedOrders, stateRows] = await Promise.all([
        pool.query(`SELECT symbol, qty, avg_entry_price, current_price, market_value, unrealized_pl, synced_at FROM positions_snapshot WHERE account_group = $1 ORDER BY symbol`, [group]),
        pool.query(`SELECT alpaca_order_id, symbol, side, qty, order_type, limit_price, status, submitted_at FROM pending_orders_snapshot WHERE account_group = $1 ORDER BY submitted_at DESC NULLS LAST`, [group]),
        pool.query(`SELECT alpaca_order_id, symbol, side, qty, order_type, limit_price, status, submitted_at FROM executed_orders_snapshot WHERE account_group = $1 ORDER BY submitted_at DESC NULLS LAST LIMIT 30`, [group]),
        pool.query(`SELECT equity, cash, buying_power, positions_count, pending_orders_count, last_sync_at, last_sync_ok, last_error FROM account_state WHERE account_group = $1`, [group]),
      ]);

      accounts[group] = {
        accountState: stateRows.rows[0] ?? null,
        positions: positions.rows,
        pendingOrders: pendingOrders.rows,
        executedOrders: executedOrders.rows,
      };
    }

    res.json({ ok: true, generatedAt: new Date().toISOString(), pollerIntervalSeconds: POLLER_INTERVAL_SECONDS, accounts });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.get('/api/account-status', async (req, res) => {
  const groups = parseAccountParam(req.query.account);
  if (!groups) {
    res.status(400).json({ ok: false, error: `account inválido: debe ser uno de ${VALID_ACCOUNT_GROUPS_OR_ALL.join(', ')}.` });
    return;
  }

  const pool = createPostgresPool(loadPostgresConfig());
  try {
    await setupOperationsSyncSchema(pool);
    const accounts: Record<string, object | null> = {};

    for (const group of groups) {
      const { rows } = await pool.query(
        `SELECT equity, cash, buying_power, positions_count, pending_orders_count, last_sync_at, last_sync_ok, last_error FROM account_state WHERE account_group = $1`,
        [group]
      );
      accounts[group] = rows[0] ?? null;
    }

    res.json({ ok: true, generatedAt: new Date().toISOString(), pollerIntervalSeconds: POLLER_INTERVAL_SECONDS, accounts });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.post('/api/operations/sync', async (req, res) => {
  const account = req.body?.account ?? 'all';
  const groups = parseAccountParam(account);
  if (!groups) {
    res.status(400).json({ ok: false, error: `account inválido: debe ser uno de ${VALID_ACCOUNT_GROUPS_OR_ALL.join(', ')}.` });
    return;
  }

  const pool = createPostgresPool(loadPostgresConfig());
  try {
    await setupOperationsSyncSchema(pool);

    if (account === 'all') {
      const results = await syncAllAccounts(pool, 'manual');
      res.json({ ok: true, finishedAt: new Date().toISOString(), results });
    } else {
      const result = await syncAccountState(pool, groups[0], 'manual');
      res.json({ ok: true, finishedAt: new Date().toISOString(), result });
    }
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.get('/api/sync-log', async (req, res) => {
  const groups = parseAccountParam(req.query.account);
  if (!groups) {
    res.status(400).json({ ok: false, error: `account inválido: debe ser uno de ${VALID_ACCOUNT_GROUPS_OR_ALL.join(', ')}.` });
    return;
  }
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 200);

  const pool = createPostgresPool(loadPostgresConfig());
  try {
    await setupOperationsSyncSchema(pool);
    const { rows } = await pool.query(
      `SELECT id, account_group, sync_type, started_at, finished_at, positions_count, orders_count, errors
       FROM sync_log WHERE account_group = ANY($1) ORDER BY started_at DESC LIMIT $2`,
      [groups, limit]
    );
    res.json({ ok: true, generatedAt: new Date().toISOString(), entries: rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.get('/api/sync-discrepancies', async (req, res) => {
  const groups = parseAccountParam(req.query.account);
  if (!groups) {
    res.status(400).json({ ok: false, error: `account inválido: debe ser uno de ${VALID_ACCOUNT_GROUPS_OR_ALL.join(', ')}.` });
    return;
  }
  const since = typeof req.query.since === 'string' ? new Date(req.query.since) : new Date(Date.now() - 24 * 60 * 60 * 1000);

  const pool = createPostgresPool(loadPostgresConfig());
  try {
    await setupOperationsSyncSchema(pool);
    const { rows } = await pool.query(
      `SELECT id, account_group, symbol, type, db_state, alpaca_state, detected_at
       FROM sync_discrepancies WHERE account_group = ANY($1) AND detected_at >= $2 ORDER BY detected_at DESC`,
      [groups, since]
    );
    res.json({ ok: true, generatedAt: new Date().toISOString(), since: since.toISOString(), discrepancies: rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.get('/api/orders/pending', async (req, res) => {
  const groups = parseAccountParam(req.query.account);
  if (!groups) {
    res.status(400).json({ ok: false, error: `account inválido: debe ser uno de ${VALID_ACCOUNT_GROUPS_OR_ALL.join(', ')}.` });
    return;
  }

  const pool = createPostgresPool(loadPostgresConfig());
  try {
    await setupOperationsSyncSchema(pool);
    const { rows } = await pool.query(
      `SELECT account_group, alpaca_order_id, symbol, side, qty, order_type, limit_price, status, submitted_at
       FROM pending_orders_snapshot WHERE account_group = ANY($1) ORDER BY submitted_at DESC NULLS LAST`,
      [groups]
    );
    res.json({ ok: true, generatedAt: new Date().toISOString(), orders: rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.get('/api/orders/stale', async (req, res) => {
  const groups = parseAccountParam(req.query.account);
  if (!groups) {
    res.status(400).json({ ok: false, error: `account inválido: debe ser uno de ${VALID_ACCOUNT_GROUPS_OR_ALL.join(', ')}.` });
    return;
  }

  const pool = createPostgresPool(loadPostgresConfig());
  try {
    await setupOperationsSyncSchema(pool);
    await setupSettingsSchema(pool);
    const settings = await getSettings(pool);

    const { rows } = await pool.query(
      `SELECT account_group, alpaca_order_id, symbol, side, qty, order_type, limit_price, status, submitted_at
       FROM pending_orders_snapshot
       WHERE account_group = ANY($1) AND side = 'buy' AND submitted_at < NOW() - ($2 || ' minutes')::INTERVAL
       ORDER BY submitted_at ASC`,
      [groups, settings.pendingOrderTimeoutMin]
    );

    res.json({ ok: true, generatedAt: new Date().toISOString(), timeoutMin: settings.pendingOrderTimeoutMin, autoCancelEnabled: settings.autoCancelStaleOrders, orders: rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.post('/api/orders/:orderId/cancel', async (req, res) => {
  const orderId = req.params.orderId;
  const groups = parseAccountParam(req.query.account);

  if (!groups || groups.length !== 1) {
    res.status(400).json({ ok: false, error: `account inválido: debe ser uno de ${ACCOUNT_GROUPS.join(', ')} (no se acepta 'all' acá).` });
    return;
  }
  const group = groups[0];

  const client = getAlpacaClient(group);
  if (!client) {
    res.status(400).json({ ok: false, error: `Sin credenciales configuradas para el grupo '${group}'.` });
    return;
  }

  const pool = createPostgresPool(loadPostgresConfig());
  try {
    await cancelOrder(client, orderId);
    // Re-sync inmediato del grupo para que positions_snapshot/pending_orders_snapshot
    // reflejen la cancelación sin esperar al próximo tick del poller de 60s.
    await setupOperationsSyncSchema(pool);
    const result = await syncAccountState(pool, group, 'post_order');
    res.json({ ok: true, orderId, group, cancelledAt: new Date().toISOString(), result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.get('/api/positions/:symbol/exit-price', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!WATCHLIST.includes(symbol)) {
    res.status(400).json({ ok: false, error: `Símbolo no soportado: ${symbol}` });
    return;
  }

  const pool = createPostgresPool(loadPostgresConfig());
  try {
    await setupSymbolClassificationSchema(pool);
    await setupOperationsSyncSchema(pool);

    // El grupo se DERIVA server-side de la clasificación actual del símbolo (no se confía
    // en un `account` que mande el cliente) - es el mismo criterio que usa el botón "Vender
    // al precio estimado" para decidir a qué cuenta correspondería la posición.
    const classification = await getSymbolClassification(pool, symbol);
    const accountGroup = classificationToAccountGroup(classification);

    const [estimate, positionRow] = await Promise.all([
      computeExitPriceEstimate(pool, symbol),
      pool.query(`SELECT qty FROM positions_snapshot WHERE account_group = $1 AND symbol = $2`, [accountGroup, symbol]),
    ]);

    res.json({
      ok: true,
      symbol,
      accountGroup,
      hasPosition: positionRow.rows.length > 0,
      qty: positionRow.rows[0]?.qty ?? null,
      ...estimate,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.post('/api/positions/:symbol/sell-at-estimate', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!WATCHLIST.includes(symbol)) {
    res.status(400).json({ ok: false, error: `Símbolo no soportado: ${symbol}` });
    return;
  }

  const pool = createPostgresPool(loadPostgresConfig());
  try {
    await setupSymbolClassificationSchema(pool);
    await setupOperationsSyncSchema(pool);

    const classification = await getSymbolClassification(pool, symbol);
    const accountGroup = classificationToAccountGroup(classification);

    const client = getAlpacaClient(accountGroup);
    if (!client) {
      res.status(400).json({ ok: false, error: `Sin credenciales configuradas para el grupo '${accountGroup}' (clasificación '${classification}' de ${symbol}).` });
      return;
    }

    const estimate = await computeExitPriceEstimate(pool, symbol);
    if (estimate.price === null) {
      res.status(400).json({ ok: false, error: `Sin precio de salida proyectable para ${symbol} (motivo: ${estimate.reason}).` });
      return;
    }

    // Posición REAL al momento de confirmar (no el snapshot, que puede tener hasta 60s) -
    // esta es la única acción de esta fase que envía una orden real a una cuenta por grupo,
    // y solo ocurre cuando el usuario confirma explícitamente desde la UI.
    const positions = await getPositions(client);
    const position = positions.find((p) => p.symbol === symbol);
    if (!position) {
      res.status(404).json({ ok: false, error: `Sin posición abierta para ${symbol} en la cuenta '${accountGroup}'.` });
      return;
    }

    const order = await placeSellOrder(client, { symbol, qty: position.qty, limitPrice: estimate.price });
    await syncAccountState(pool, accountGroup, 'post_order');

    res.json({ ok: true, symbol, accountGroup, qty: position.qty, limitPrice: estimate.price, alpacaOrderId: order.id, placedAt: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await pool.end();
  }
});

app.get('/api/snapshots', async (_req, res) => {
  try {
    const minioConfig = loadMinioConfig();
    const minioClient = createMinioClient(minioConfig);

    const [ingestSnapshots, tradingSnapshots] = await Promise.all([
      listSnapshots(minioClient, minioConfig, 'ingest/'),
      listSnapshots(minioClient, minioConfig, 'trading/'),
    ]);

    const snapshots = [
      ...ingestSnapshots.map((snapshot) => ({ ...snapshot, type: 'ingest' as const })),
      ...tradingSnapshots.map((snapshot) => ({ ...snapshot, type: 'trading' as const })),
    ]
      .sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1))
      .slice(0, SNAPSHOTS_LIMIT);

    res.json({ ok: true, snapshots });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/snapshots/download', async (req, res) => {
  const key = String(req.query.key ?? '');

  if (!SNAPSHOT_KEY_PATTERN.test(key)) {
    res.status(400).json({ ok: false, error: 'Key de snapshot inválida' });
    return;
  }

  try {
    const minioConfig = loadMinioConfig();
    const minioClient = createMinioClient(minioConfig);
    const stream = await getSnapshotStream(minioClient, minioConfig, key);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(key)}"`);
    stream.on('error', (error) => {
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: error.message });
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.listen(config.port, () => {
  console.log(`🌐 Vibe Bots web escuchando en http://0.0.0.0:${config.port}`);
  if (config.grafanaPublicUrl) {
    console.log(`   Grafana público: ${config.grafanaPublicUrl}`);
  } else {
    console.log('   GRAFANA_PUBLIC_URL no configurado: los paneles de Grafana no se mostrarán.');
  }
});
