import path from 'path';
import express from 'express';
import { loadWebConfig, loadAlpacaConfig, loadPostgresConfig, loadMinioConfig } from './config';
import { runDiagnostics } from './diagnostics';
import { runIngest } from './ingestRunner';
import { runTradingCycle } from './tradingRunner';
import { createPostgresPool } from './services/db';
import { createMinioClient, listSnapshots, getSnapshotStream } from './services/storage';
import { createAlpacaClient, getAccount, getPositions } from './services/alpaca';
import { getRecentOrders } from './services/tradingStore';
import { getRecentBars, getCloses } from './services/marketStore';
import { buildChartSeries } from './strategy/chart';
import { computeSignal } from './strategy/signals';
import { WATCHLIST, ETF_SYMBOLS } from './watchlist';

const CHART_LOOKBACK_BARS = 90;
const SIGNAL_CLOSES_LOOKBACK = 60;
const SNAPSHOT_KEY_PATTERN = /^(ingest|trading)\/[A-Za-z0-9_\-:.]+\.json$/;
const SNAPSHOTS_LIMIT = 30;

const config = loadWebConfig();
const app = express();

app.use(express.static(path.join(__dirname, '..', 'public')));

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
    const [account, positions, orders] = await Promise.all([
      getAccount(alpacaClient),
      getPositions(alpacaClient),
      getRecentOrders(pool, 20),
    ]);

    const signals = await Promise.all(
      WATCHLIST.map(async (symbol) => {
        const closes = await getCloses(pool, symbol, SIGNAL_CLOSES_LOOKBACK);
        const signal = computeSignal(symbol, closes);
        return { ...signal, type: ETF_SYMBOLS.includes(symbol) ? ('ETF' as const) : ('STOCK' as const) };
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
