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
import { getRecentOhlcBars } from './services/marketStore';
import { createMarketDataClient, getAdjustedCloses } from './services/marketData';
import { buildChartSeries } from './strategy/chart';
import { computeSignal } from './strategy/signals';
import { CONDITIONS, DEFAULT_CONDITION_ID } from './strategy/conditions';
import { RISK_PROFILE_PRESETS } from './strategy/config';
import { WATCHLIST, ETF_SYMBOLS } from './watchlist';
import { setupBacktestSchema, getLatestBacktestRun } from './services/backtestStore';
import { runBacktestForWatchlist } from './backtestRunner';
import { setupSettingsSchema, getSettings, saveSettings, setTradingEnabled } from './services/settingsStore';
import { setupConditionSchema, getSymbolConditions } from './services/conditionStore';
import { CLAUDE_MODEL_OPTIONS } from './services/claude';

// Velas para el gráfico por símbolo: suficientes para que SMA50/EMA26/Donchian etc.
// (los indicadores de mayor período entre las 12 condiciones) tengan ~100 puntos
// válidos dentro de la ventana visible (Fase 6.1).
const CHART_LOOKBACK_BARS = 150;
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
    const symbolConditions = await getSymbolConditions(pool);

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
        const bars = await getRecentOhlcBars(pool, symbol, BARS_LOOKBACK);
        const pick = symbolConditions.get(symbol);
        const buyConditionId = pick?.buyConditionId ?? DEFAULT_CONDITION_ID;
        const sellConditionId = pick?.sellConditionId ?? DEFAULT_CONDITION_ID;
        const signal = computeSignal(symbol, bars, settings.riskProfile, buyConditionId, sellConditionId);
        const latest = latestBySymbol.get(symbol);

        return {
          ...signal,
          // Refleja el último precio verificado/ajustado por la fase de IA (si lo hay),
          // sin llamar a Claude en cada poll del dashboard.
          estimatedEntryPrice: latest?.estimatedEntryPrice ?? signal.estimatedEntryPrice,
          estimatedExitPrice: latest?.estimatedExitPrice ?? signal.estimatedExitPrice,
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

  const pool = createPostgresPool(loadPostgresConfig());

  try {
    const bars = await getRecentOhlcBars(pool, symbol, CHART_LOOKBACK_BARS);
    const points = buildChartSeries(bars);

    res.json({ ok: true, symbol, points });
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

const VALID_RISK_PRESETS = ['conservador', 'moderado', 'agresivo', 'personalizado'];
const VALID_CLAUDE_MODELS = CLAUDE_MODEL_OPTIONS.map((model) => model.id);
const VALID_EXIT_MODES = ['bracket', 'signal_only'];

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
  const exitMode = body.exitMode ?? 'bracket';

  if (!VALID_RISK_PRESETS.includes(riskPreset)) {
    res.status(400).json({ ok: false, error: `riskPreset inválido: debe ser uno de ${VALID_RISK_PRESETS.join(', ')}.` });
    return;
  }

  if (
    typeof riskProfile !== 'object' || riskProfile === null ||
    typeof riskProfile.positionSizePct !== 'number' || riskProfile.positionSizePct <= 0 || riskProfile.positionSizePct > 1 ||
    typeof riskProfile.stopLossPct !== 'number' || riskProfile.stopLossPct <= 0 || riskProfile.stopLossPct >= 1 ||
    typeof riskProfile.takeProfitPct !== 'number' || riskProfile.takeProfitPct <= 0 || riskProfile.takeProfitPct >= 2 ||
    typeof riskProfile.maxPositions !== 'number' || !Number.isInteger(riskProfile.maxPositions) ||
    riskProfile.maxPositions < 1 || riskProfile.maxPositions > 20
  ) {
    res.status(400).json({
      ok: false,
      error: 'riskProfile inválido: positionSizePct debe estar en (0,1], stopLossPct en (0,1), takeProfitPct en (0,2) y maxPositions debe ser un entero entre 1 y 20.',
    });
    return;
  }

  if (claudeModel !== null && !VALID_CLAUDE_MODELS.includes(claudeModel)) {
    res.status(400).json({ ok: false, error: `claudeModel inválido: debe ser uno de ${VALID_CLAUDE_MODELS.join(', ')} o null.` });
    return;
  }

  if (!VALID_EXIT_MODES.includes(exitMode)) {
    res.status(400).json({ ok: false, error: `exitMode inválido: debe ser uno de ${VALID_EXIT_MODES.join(', ')}.` });
    return;
  }

  const pool = createPostgresPool(loadPostgresConfig());

  try {
    await setupSettingsSchema(pool);
    await saveSettings(pool, {
      riskPreset,
      riskProfile: {
        positionSizePct: riskProfile.positionSizePct,
        stopLossPct: riskProfile.stopLossPct,
        takeProfitPct: riskProfile.takeProfitPct,
        maxPositions: riskProfile.maxPositions,
      },
      claudeModel,
      exitMode,
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

    const conditions = WATCHLIST.map((symbol) => {
      const row = symbolConditions.get(symbol);
      const buyCondition = CONDITIONS.find((c) => c.id === (row?.buyConditionId ?? DEFAULT_CONDITION_ID)) ?? CONDITIONS[0];
      const sellCondition = CONDITIONS.find((c) => c.id === (row?.sellConditionId ?? DEFAULT_CONDITION_ID)) ?? CONDITIONS[0];

      return {
        symbol,
        buyConditionId: row?.buyConditionId ?? buyCondition.id,
        buyConditionLabel: row?.buyConditionLabel ?? buyCondition.label,
        sellConditionId: row?.sellConditionId ?? sellCondition.id,
        sellConditionLabel: row?.sellConditionLabel ?? sellCondition.label,
        trades: row?.trades ?? 0,
        winRatePct: row?.winRatePct ?? null,
        totalReturnPct: row?.totalReturnPct ?? 0,
        avgReturnPct: row?.avgReturnPct ?? null,
        maxDrawdownPct: row?.maxDrawdownPct ?? 0,
        updatedAt: row?.updatedAt ?? null,
        buyHoldReturnPct: buyHoldReturns.get(symbol) ?? null,
      };
    });

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
