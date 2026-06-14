import path from 'path';
import express from 'express';
import { loadWebConfig, loadAlpacaConfig, loadPostgresConfig, loadMinioConfig } from './config';
import { runDiagnostics } from './diagnostics';
import { runIngest } from './ingestRunner';
import { runTradingCycle } from './tradingRunner';
import { createPostgresPool } from './services/db';
import { createMinioClient, listSnapshots, getSnapshotStream } from './services/storage';
import { createAlpacaClient, getAccount, getPositions } from './services/alpaca';
import { setupTradingSchema, getRecentOrders, getLatestAssessments, getLatestSignals } from './services/tradingStore';
import { getRecentBars, getCloses } from './services/marketStore';
import { buildChartSeries } from './strategy/chart';
import { computeSignal } from './strategy/signals';
import { RISK_PROFILE_PRESETS } from './strategy/config';
import { WATCHLIST, ETF_SYMBOLS } from './watchlist';
import { setupBacktestSchema, getLatestBacktestRun } from './services/backtestStore';
import { runBacktestForWatchlist } from './backtestRunner';
import { setupSettingsSchema, getSettings, saveSettings } from './services/settingsStore';
import { CLAUDE_MODEL_OPTIONS } from './services/claude';

const CHART_LOOKBACK_BARS = 90;
const SIGNAL_CLOSES_LOOKBACK = 60;
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

  try {
    await setupSettingsSchema(pool);
    const settings = await getSettings(pool);

    const [account, positions, orders, latestSignals] = await Promise.all([
      getAccount(alpacaClient),
      getPositions(alpacaClient),
      getRecentOrders(pool, 20),
      getLatestSignals(pool),
    ]);

    const latestBySymbol = new Map(latestSignals.map((row) => [row.symbol, row]));

    const signals = await Promise.all(
      WATCHLIST.map(async (symbol) => {
        const closes = await getCloses(pool, symbol, SIGNAL_CLOSES_LOOKBACK);
        const signal = computeSignal(symbol, closes, settings.riskProfile);
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

    res.json({ ok: true, generatedAt: new Date().toISOString(), account, positions, signals, orders });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
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
    const bars = await getRecentBars(pool, symbol, CHART_LOOKBACK_BARS);
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
    });

    res.json({ ok: true, savedAt: new Date().toISOString() });
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
