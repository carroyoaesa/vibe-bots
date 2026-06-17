import path from 'path';
import express from 'express';
import { loadWebConfig, loadAlpacaConfig, loadPostgresConfig, loadMinioConfig, loadRedisConfig } from './config';
import { runDiagnostics } from './diagnostics';
import { runIngest } from './ingestRunner';
import { runTradingCycle } from './tradingRunner';
import { createPostgresPool } from './services/db';
import { createMinioClient, listSnapshots, getSnapshotStream } from './services/storage';
import { createAlpacaClient, getAccount, getPositions, AlpacaOrder } from './services/alpaca';
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
import { runBacktestForWatchlist } from './backtestRunner';
import { setupSettingsSchema, getSettings, saveSettings, setTradingEnabled } from './services/settingsStore';
import { setupConditionSchema, getSymbolConditions, getMainSymbolConditions } from './services/conditionStore';
import { CLAUDE_MODEL_OPTIONS } from './services/claude';
import { MULTI_CONDITION_OVERRIDES } from './strategy/multiConditionOverrides';

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
