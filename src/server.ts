import path from 'path';
import express from 'express';
import { loadWebConfig, loadAlpacaConfig, loadPostgresConfig } from './config';
import { runDiagnostics } from './diagnostics';
import { runIngest } from './ingestRunner';
import { runTradingCycle } from './tradingRunner';
import { createPostgresPool } from './services/db';
import { createAlpacaClient, getAccount, getPositions } from './services/alpaca';
import { getLatestSignals, getRecentOrders } from './services/tradingStore';

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
    const [account, positions, signals, orders] = await Promise.all([
      getAccount(alpacaClient),
      getPositions(alpacaClient),
      getLatestSignals(pool),
      getRecentOrders(pool, 20),
    ]);

    res.json({ ok: true, generatedAt: new Date().toISOString(), account, positions, signals, orders });
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

app.listen(config.port, () => {
  console.log(`🌐 Vibe Bots web escuchando en http://0.0.0.0:${config.port}`);
  if (config.grafanaPublicUrl) {
    console.log(`   Grafana público: ${config.grafanaPublicUrl}`);
  } else {
    console.log('   GRAFANA_PUBLIC_URL no configurado: los paneles de Grafana no se mostrarán.');
  }
});
