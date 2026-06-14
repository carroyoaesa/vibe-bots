const healthGrid = document.getElementById('health-grid');
const healthUpdated = document.getElementById('health-updated');
const refreshHealthBtn = document.getElementById('refresh-health');
const runIngestBtn = document.getElementById('run-ingest');
const ingestResult = document.getElementById('ingest-result');

const tradingToggleStatus = document.getElementById('trading-toggle-status');
const tradingToggleBtn = document.getElementById('trading-toggle-btn');

const riskPresetSelect = document.getElementById('risk-preset');
const riskPositionSizeInput = document.getElementById('risk-position-size');
const riskStopLossInput = document.getElementById('risk-stop-loss');
const riskTakeProfitInput = document.getElementById('risk-take-profit');
const riskMaxPositionsInput = document.getElementById('risk-max-positions');
const claudeModelSelect = document.getElementById('claude-model');
const saveSettingsBtn = document.getElementById('save-settings');
const settingsResult = document.getElementById('settings-result');
const settingsUpdated = document.getElementById('settings-updated');

const tradingAccount = document.getElementById('trading-account');
const backtestingPeriod = document.getElementById('backtesting-period');
const backtestingPortfolio = document.getElementById('backtesting-portfolio');
const symbolReportsEtf = document.getElementById('symbol-reports-etf');
const symbolReportsStock = document.getElementById('symbol-reports-stock');
const positionsTableBody = document.querySelector('#positions-table tbody');
const ordersTableBody = document.querySelector('#orders-table tbody');
const runTradeBtn = document.getElementById('run-trade');
const tradeResult = document.getElementById('trade-result');
const runBacktestBtn = document.getElementById('run-backtest');
const backtestingResult = document.getElementById('backtesting-result');

const snapshotsTableBody = document.querySelector('#snapshots-table tbody');
const refreshSnapshotsBtn = document.getElementById('refresh-snapshots');
const snapshotsUpdated = document.getElementById('snapshots-updated');

const chartInstances = {};
let tradingEnabled = true;

function renderHealth(data) {
  healthGrid.innerHTML = '';

  data.checks.forEach((check) => {
    const card = document.createElement('div');
    card.className = `health-card ${check.ok ? 'ok' : 'error'}`;

    const title = document.createElement('h3');
    title.textContent = `${check.emoji} ${check.name}`;
    card.appendChild(title);

    const status = document.createElement('div');
    status.className = 'status';
    status.textContent = check.ok ? 'OK' : 'ERROR';
    card.appendChild(status);

    if (check.ok) {
      const list = document.createElement('ul');
      check.summary.forEach((line) => {
        const item = document.createElement('li');
        item.textContent = line;
        list.appendChild(item);
      });
      card.appendChild(list);
    } else {
      const error = document.createElement('p');
      error.className = 'error-message';
      error.textContent = check.error;
      card.appendChild(error);
    }

    healthGrid.appendChild(card);
  });

  healthUpdated.textContent = `Última actualización: ${new Date(data.generatedAt).toLocaleTimeString()}`;
}

async function loadHealth() {
  refreshHealthBtn.disabled = true;
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    renderHealth(data);
  } catch (error) {
    healthGrid.innerHTML = `<p class="muted">Error al cargar el estado: ${error}</p>`;
  } finally {
    refreshHealthBtn.disabled = false;
  }
}

async function runIngest() {
  runIngestBtn.disabled = true;
  ingestResult.textContent = 'Ejecutando ingesta...';
  try {
    const res = await fetch('/api/ingest', { method: 'POST' });
    const data = await res.json();
    ingestResult.textContent = JSON.stringify(data, null, 2);
    if (data.ok) {
      await loadHealth();
      await loadSnapshots();
    }
  } catch (error) {
    ingestResult.textContent = `Error: ${error}`;
  } finally {
    runIngestBtn.disabled = false;
  }
}

function renderTradingToggle(enabled) {
  tradingEnabled = enabled;
  tradingToggleStatus.textContent = enabled
    ? 'Órdenes a Alpaca: ACTIVADAS'
    : 'Órdenes a Alpaca: DESACTIVADAS (compra y venta bloqueadas)';
  tradingToggleStatus.classList.toggle('toggle-on', enabled);
  tradingToggleStatus.classList.toggle('toggle-off', !enabled);
  tradingToggleBtn.textContent = enabled ? '⏸ Desactivar' : '▶ Activar';
  tradingToggleBtn.disabled = false;
}

async function toggleTradingEnabled() {
  const next = !tradingEnabled;
  const confirmMessage = next
    ? 'Esto reactiva las órdenes a Alpaca: el bot podrá volver a abrir y cerrar posiciones reales (dinero simulado) en la cuenta paper. ¿Continuar?'
    : 'Esto desactiva las órdenes a Alpaca: el bot dejará de abrir y cerrar posiciones, pero seguirá calculando señales y evaluaciones de IA. ¿Continuar?';

  if (!window.confirm(confirmMessage)) return;

  tradingToggleBtn.disabled = true;
  try {
    const res = await fetch('/api/settings/trading-enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    const data = await res.json();
    if (data.ok) {
      renderTradingToggle(data.tradingEnabled);
    } else {
      tradingToggleBtn.disabled = false;
      window.alert(`Error: ${data.error}`);
    }
  } catch (error) {
    tradingToggleBtn.disabled = false;
    window.alert(`Error: ${error}`);
  }
}

let riskPresets = {};

function fillRiskInputs(riskProfile) {
  riskPositionSizeInput.value = (riskProfile.positionSizePct * 100).toFixed(1);
  riskStopLossInput.value = (riskProfile.stopLossPct * 100).toFixed(1);
  riskTakeProfitInput.value = (riskProfile.takeProfitPct * 100).toFixed(1);
  riskMaxPositionsInput.value = riskProfile.maxPositions;
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (!data.ok) {
      settingsResult.textContent = `Error al cargar configuración: ${data.error}`;
      return;
    }

    riskPresets = data.presets;

    claudeModelSelect.innerHTML = '';
    data.models.forEach((model) => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.label;
      claudeModelSelect.appendChild(option);
    });

    riskPresetSelect.value = data.settings.riskPreset;
    fillRiskInputs(data.settings.riskProfile);
    claudeModelSelect.value = data.settings.claudeModel || data.models[0].id;

    renderTradingToggle(data.settings.tradingEnabled);

    settingsUpdated.textContent = `Última actualización: ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    settingsResult.textContent = `Error al cargar configuración: ${error}`;
  }
}

async function saveSettings() {
  saveSettingsBtn.disabled = true;
  settingsResult.textContent = 'Guardando...';
  try {
    const body = {
      riskPreset: riskPresetSelect.value,
      riskProfile: {
        positionSizePct: Number(riskPositionSizeInput.value) / 100,
        stopLossPct: Number(riskStopLossInput.value) / 100,
        takeProfitPct: Number(riskTakeProfitInput.value) / 100,
        maxPositions: Number(riskMaxPositionsInput.value),
      },
      claudeModel: claudeModelSelect.value,
    };

    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    settingsResult.textContent = JSON.stringify(data, null, 2);
    if (data.ok) {
      settingsUpdated.textContent = `Guardado: ${new Date(data.savedAt).toLocaleTimeString()}`;
    }
  } catch (error) {
    settingsResult.textContent = `Error: ${error}`;
  } finally {
    saveSettingsBtn.disabled = false;
  }
}

function fmtMoney(value) {
  return `$${Number(value).toFixed(2)}`;
}

function fmtNum(value, decimals = 2) {
  return value === null || value === undefined ? '—' : Number(value).toFixed(decimals);
}

function signalClass(signal) {
  if (signal === 'BUY') return 'signal-buy';
  if (signal === 'SELL') return 'signal-sell';
  return 'signal-hold';
}

function recommendationClass(recommendation) {
  if (recommendation === 'buy') return 'signal-buy';
  if (recommendation === 'avoid') return 'signal-sell';
  return 'signal-hold';
}

/**
 * Puntaje de "qué tan conveniente es comprar ahora": prioriza señal BUY/HOLD/SELL,
 * y dentro de cada una favorece momentum positivo, RSI cercano a neutral (no sobrecomprado)
 * y tendencia alcista (SMA10 por encima de SMA30).
 */
function attractivenessScore(signal) {
  const signalScore = { BUY: 2, HOLD: 1, SELL: 0 }[signal.signal] ?? 1;
  const momentumScore = signal.momentum !== null ? signal.momentum / 10 : 0;
  const rsiScore = signal.rsi !== null ? (50 - Math.abs(signal.rsi - 50)) / 50 : 0;
  const trendScore = signal.smaFast !== null && signal.smaSlow ? (signal.smaFast - signal.smaSlow) / signal.smaSlow : 0;

  return signalScore * 10 + momentumScore + rsiScore + trendScore * 10;
}

function renderSymbolStats(signal) {
  const stat = (label, value) => `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value">${value}</span></div>`;

  return [
    stat('Precio', fmtMoney(signal.price)),
    stat('SMA10', fmtNum(signal.smaFast)),
    stat('SMA30', fmtNum(signal.smaSlow)),
    stat('RSI', fmtNum(signal.rsi)),
    stat('Momentum', signal.momentum !== null ? `${fmtNum(signal.momentum)}%` : '—'),
    stat('Precio est. entrada', signal.estimatedEntryPrice !== null ? fmtMoney(signal.estimatedEntryPrice) : '—'),
    stat('Precio est. salida', signal.estimatedExitPrice !== null ? fmtMoney(signal.estimatedExitPrice) : '—'),
  ].join('');
}

function renderPositionLine(position) {
  if (!position) {
    return '<p class="muted">Sin posición abierta.</p>';
  }

  return `<p class="muted">Posición abierta: ${fmtNum(position.qty, 0)} acciones · entrada ${fmtMoney(position.avgEntryPrice)} · ` +
    `actual ${fmtMoney(position.currentPrice)} · valor ${fmtMoney(position.marketValue)} · ` +
    `P/L <span class="${position.unrealizedPl >= 0 ? 'pl-positive' : 'pl-negative'}">${fmtMoney(position.unrealizedPl)}</span></p>`;
}

function renderAssessmentBlock(assessment) {
  if (!assessment) {
    return '<p class="muted">Sin evaluación todavía (requiere ANTHROPIC_API_KEY y un ciclo de trading).</p>';
  }

  return `
    <p>
      <span class="${recommendationClass(assessment.recommendation)}">${assessment.recommendation.toUpperCase()}</span>
      · Score ${fmtNum(assessment.score)} · Confianza ${assessment.confidence !== null ? fmtNum(assessment.confidence) : '—'}
      · ${new Date(assessment.ts).toLocaleString()}
    </p>
    <p class="muted">
      Ajuste entrada: ${assessment.adjustedEntryPrice !== null ? fmtMoney(assessment.adjustedEntryPrice) : '—'}
      · Ajuste salida: ${assessment.adjustedExitPrice !== null ? fmtMoney(assessment.adjustedExitPrice) : '—'}
    </p>
    <p class="muted">${assessment.rationale ?? ''}</p>
  `;
}

function renderBacktestBlock(summary) {
  if (!summary) {
    return '<p class="muted">Sin backtest todavía. Ejecutá un backtest.</p>';
  }

  return `
    <p class="muted">
      Trades: ${summary.trades} · Win rate: ${summary.winRate !== null ? `${fmtNum(summary.winRate, 1)}%` : '—'} ·
      Retorno total: <span class="${summary.totalReturnPct >= 0 ? 'pl-positive' : 'pl-negative'}">${fmtNum(summary.totalReturnPct)}%</span> ·
      Retorno prom.: ${summary.avgReturnPct !== null ? `${fmtNum(summary.avgReturnPct)}%` : '—'} ·
      Max drawdown: ${fmtNum(summary.maxDrawdownPct)}%
    </p>
  `;
}

function renderSymbolCard(container, index, signal, assessment, backtestSummary, position) {
  const symbol = signal.symbol;
  let card = document.getElementById(`symbol-card-${symbol}`);

  if (!card) {
    card = document.createElement('div');
    card.className = 'symbol-report-card';
    card.id = `symbol-card-${symbol}`;
    card.innerHTML = `
      <div class="symbol-report-header">
        <h4>${symbol}</h4>
        <span class="signal-badge"></span>
      </div>
      <div class="symbol-stats-grid"></div>
      <p class="muted symbol-reason"></p>
      <div class="symbol-position"></div>
      <div class="chart-canvas-wrap">
        <canvas></canvas>
      </div>
      <p class="muted chart-no-data hidden">Sin datos históricos todavía. Ejecutá la ingesta.</p>
      <div class="symbol-subsection">
        <h5>Evaluación de IA (Claude)</h5>
        <div class="symbol-assessment"></div>
      </div>
      <div class="symbol-subsection">
        <h5>Backtest</h5>
        <div class="symbol-backtest"></div>
      </div>
    `;
    container.appendChild(card);
  }

  // Mantener el orden según el ranking de atractivo.
  if (container.children[index] !== card) {
    container.insertBefore(card, container.children[index] ?? null);
  }

  const badge = card.querySelector('.signal-badge');
  badge.className = `signal-badge ${signalClass(signal.signal)}`;
  badge.textContent = signal.signal;

  card.querySelector('.symbol-stats-grid').innerHTML = renderSymbolStats(signal);
  card.querySelector('.symbol-reason').textContent = `Motivo: ${signal.reason}`;
  card.querySelector('.symbol-position').innerHTML = renderPositionLine(position);
  card.querySelector('.symbol-assessment').innerHTML = renderAssessmentBlock(assessment);
  card.querySelector('.symbol-backtest').innerHTML = renderBacktestBlock(backtestSummary);

  return {
    signal,
    canvas: card.querySelector('canvas'),
    noDataMsg: card.querySelector('.chart-no-data'),
  };
}

function renderSymbolReportsGroup(container, signals, assessmentsBySymbol, backtestSummaryBySymbol, positionsBySymbol) {
  if (signals.length === 0) {
    container.innerHTML = '<p class="muted">Sin señales todavía. Ejecutá la ingesta y un ciclo de trading.</p>';
    return [];
  }

  const seenSymbols = new Set(signals.map((signal) => signal.symbol));
  container.querySelectorAll('.symbol-report-card').forEach((card) => {
    const symbol = card.id.replace('symbol-card-', '');
    if (!seenSymbols.has(symbol)) {
      if (chartInstances[symbol]) {
        chartInstances[symbol].destroy();
        delete chartInstances[symbol];
      }
      card.remove();
    }
  });

  return signals.map((signal, index) => renderSymbolCard(
    container,
    index,
    signal,
    assessmentsBySymbol.get(signal.symbol),
    backtestSummaryBySymbol.get(signal.symbol),
    positionsBySymbol.get(signal.symbol)
  ));
}

async function renderSymbolCharts(entries) {
  if (entries.length === 0) return;

  const results = await Promise.all(
    entries.map(async (entry) => {
      try {
        const res = await fetch(`/api/trading/chart/${entry.signal.symbol}`);
        const data = await res.json();
        return { ...entry, ok: data.ok, points: data.points, error: data.error };
      } catch (error) {
        return { ...entry, ok: false, error: String(error) };
      }
    })
  );

  results.forEach((result) => {
    const { signal, canvas, noDataMsg } = result;

    if (chartInstances[signal.symbol]) {
      chartInstances[signal.symbol].destroy();
      delete chartInstances[signal.symbol];
    }

    if (!result.ok || !result.points || result.points.length === 0) {
      canvas.classList.add('hidden');
      noDataMsg.classList.remove('hidden');
      return;
    }

    canvas.classList.remove('hidden');
    noDataMsg.classList.add('hidden');

    const labels = result.points.map((point) => new Date(point.ts).toLocaleDateString());
    const closes = result.points.map((point) => point.close);
    const smaFast = result.points.map((point) => point.smaFast);
    const smaSlow = result.points.map((point) => point.smaSlow);

    const datasets = [
      {
        label: 'Precio',
        data: closes,
        borderColor: '#4a82f0',
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.1,
      },
      {
        label: 'SMA10',
        data: smaFast,
        borderColor: '#2ecc71',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.1,
      },
      {
        label: 'SMA30',
        data: smaSlow,
        borderColor: '#e67e22',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.1,
      },
    ];

    if (signal.estimatedEntryPrice !== null) {
      datasets.push({
        label: 'Precio est. entrada',
        data: labels.map(() => signal.estimatedEntryPrice),
        borderColor: '#f1c40f',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [6, 4],
        pointRadius: 0,
        tension: 0,
      });
    }
    if (signal.estimatedExitPrice !== null) {
      datasets.push({
        label: 'Precio est. salida',
        data: labels.map(() => signal.estimatedExitPrice),
        borderColor: '#9b59b6',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [6, 4],
        pointRadius: 0,
        tension: 0,
      });
    }

    chartInstances[signal.symbol] = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { color: '#9aa0a6', maxTicksLimit: 8 }, grid: { color: '#2a2e35' } },
          y: { ticks: { color: '#9aa0a6' }, grid: { color: '#2a2e35' } },
        },
        plugins: {
          legend: { labels: { color: '#c7c9cc' } },
        },
      },
    });
  });
}

function renderPositionsTable(positions) {
  positionsTableBody.innerHTML = '';
  if (positions.length === 0) {
    positionsTableBody.innerHTML = '<tr><td colspan="6" class="muted">Sin posiciones abiertas.</td></tr>';
    return;
  }

  positions.forEach((position) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${position.symbol}</td>
      <td>${fmtNum(position.qty, 0)}</td>
      <td>${fmtMoney(position.avgEntryPrice)}</td>
      <td>${fmtMoney(position.currentPrice)}</td>
      <td>${fmtMoney(position.marketValue)}</td>
      <td class="${position.unrealizedPl >= 0 ? 'pl-positive' : 'pl-negative'}">${fmtMoney(position.unrealizedPl)}</td>
    `;
    positionsTableBody.appendChild(tr);
  });
}

function renderOrdersTable(orders) {
  ordersTableBody.innerHTML = '';
  if (orders.length === 0) {
    ordersTableBody.innerHTML = '<tr><td colspan="8" class="muted">Sin órdenes registradas.</td></tr>';
    return;
  }

  orders.forEach((order) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(order.ts).toLocaleString()}</td>
      <td>${order.symbol}</td>
      <td>${order.side.toUpperCase()}</td>
      <td>${fmtNum(order.qty, 0)}</td>
      <td>${order.orderType}</td>
      <td>${order.takeProfitPrice !== null ? fmtMoney(order.takeProfitPrice) : '—'}</td>
      <td>${order.stopLossPrice !== null ? fmtMoney(order.stopLossPrice) : '—'}</td>
      <td>${order.status}</td>
    `;
    ordersTableBody.appendChild(tr);
  });
}

function renderBacktestingSummary(run) {
  if (!run) {
    backtestingPeriod.textContent = '';
    backtestingPortfolio.textContent = '';
    return;
  }

  const { run: meta, trades } = run;
  const summary = meta.summary || {};
  const portfolio = summary.portfolio || {};

  const startDate = meta.startDate ? String(meta.startDate).slice(0, 10) : 'n/a';
  const endDate = meta.endDate ? String(meta.endDate).slice(0, 10) : 'n/a';

  backtestingPeriod.textContent =
    `Backtest - Periodo: ${startDate} → ${endDate} ` +
    `(última corrida: ${new Date(meta.runAt).toLocaleString()}, ${trades.length} trades guardados)`;

  backtestingPortfolio.textContent =
    `Portafolio: ${portfolio.symbols ?? '—'} símbolos · ${portfolio.totalTrades ?? 0} trades · ` +
    `retorno prom. ${portfolio.avgReturnPct !== null && portfolio.avgReturnPct !== undefined ? `${fmtNum(portfolio.avgReturnPct)}%` : '—'} · ` +
    `win rate prom. ${portfolio.avgWinRatePct !== null && portfolio.avgWinRatePct !== undefined ? `${fmtNum(portfolio.avgWinRatePct, 1)}%` : '—'} · ` +
    `mejor: ${portfolio.bestSymbol ?? '—'} · peor: ${portfolio.worstSymbol ?? '—'}`;
}

async function loadSymbolReports() {
  try {
    const [statusRes, assessmentsRes, backtestingRes] = await Promise.all([
      fetch('/api/trading/status'),
      fetch('/api/assessments'),
      fetch('/api/backtesting/results'),
    ]);

    const statusData = await statusRes.json();
    if (!statusData.ok) {
      tradingAccount.textContent = `Error al cargar estado de trading: ${statusData.error}`;
      return;
    }

    const assessmentsData = await assessmentsRes.json();
    const backtestingData = await backtestingRes.json();

    const { account, positions, signals, orders, openOrdersCount } = statusData;

    const openOrdersText = typeof openOrdersCount === 'number'
      ? ` · Órdenes abiertas en Alpaca: ${openOrdersCount}`
      : '';

    tradingAccount.textContent =
      `Cuenta ${account.accountNumber} (${account.status}) · Equity: ${fmtMoney(account.equity)} · ` +
      `Cash: ${fmtMoney(account.cash)} · Buying power: ${fmtMoney(account.buyingPower)}${openOrdersText}`;

    const assessmentsBySymbol = new Map(
      (assessmentsData.ok ? assessmentsData.assessments : []).map((a) => [a.symbol, a])
    );
    const positionsBySymbol = new Map(positions.map((p) => [p.symbol, p]));

    const run = backtestingData.ok ? backtestingData.run : null;
    renderBacktestingSummary(run);
    const backtestSummaryBySymbol = new Map(
      (run?.run?.summary?.symbols ?? []).map((s) => [s.symbol, s])
    );

    const etfSignals = signals.filter((signal) => signal.type === 'ETF').sort((a, b) => attractivenessScore(b) - attractivenessScore(a));
    const stockSignals = signals.filter((signal) => signal.type === 'STOCK').sort((a, b) => attractivenessScore(b) - attractivenessScore(a));

    const etfEntries = renderSymbolReportsGroup(symbolReportsEtf, etfSignals, assessmentsBySymbol, backtestSummaryBySymbol, positionsBySymbol);
    const stockEntries = renderSymbolReportsGroup(symbolReportsStock, stockSignals, assessmentsBySymbol, backtestSummaryBySymbol, positionsBySymbol);

    await Promise.all([renderSymbolCharts(etfEntries), renderSymbolCharts(stockEntries)]);

    renderPositionsTable(positions);
    renderOrdersTable(orders);
  } catch (error) {
    tradingAccount.textContent = `Error al cargar resumen por símbolo: ${error}`;
  }
}

async function runTradingCycle() {
  const confirmed = window.confirm(
    'Esto calcula señales y, según el perfil de riesgo, puede abrir o cerrar posiciones REALES ' +
    '(con dinero simulado) en la cuenta paper de Alpaca, salvo que el interruptor "Órdenes a Alpaca" ' +
    'esté desactivado. ¿Continuar?'
  );
  if (!confirmed) return;

  runTradeBtn.disabled = true;
  tradeResult.textContent = 'Ejecutando ciclo de trading...';
  try {
    const res = await fetch('/api/trading/run', { method: 'POST' });
    const data = await res.json();
    tradeResult.textContent = JSON.stringify(data, null, 2);
    if (data.ok) {
      await loadSymbolReports();
      await loadSnapshots();
    }
  } catch (error) {
    tradeResult.textContent = `Error: ${error}`;
  } finally {
    runTradeBtn.disabled = false;
  }
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderSnapshots(snapshots) {
  snapshotsTableBody.innerHTML = '';
  if (snapshots.length === 0) {
    snapshotsTableBody.innerHTML = '<tr><td colspan="4" class="muted">Sin snapshots todavía. Ejecutá una ingesta o un ciclo de trading.</td></tr>';
    return;
  }

  snapshots.forEach((snapshot) => {
    const tr = document.createElement('tr');
    const typeLabel = snapshot.type === 'ingest' ? 'Ingesta' : 'Trading';
    tr.innerHTML = `
      <td>${typeLabel}</td>
      <td>${new Date(snapshot.lastModified).toLocaleString()}</td>
      <td>${fmtBytes(snapshot.size)}</td>
      <td><a href="/api/snapshots/download?key=${encodeURIComponent(snapshot.key)}">⬇️ Descargar</a></td>
    `;
    snapshotsTableBody.appendChild(tr);
  });
}

async function loadSnapshots() {
  refreshSnapshotsBtn.disabled = true;
  try {
    const res = await fetch('/api/snapshots');
    const data = await res.json();
    if (data.ok) {
      renderSnapshots(data.snapshots);
      snapshotsUpdated.textContent = `Última actualización: ${new Date().toLocaleTimeString()}`;
    } else {
      snapshotsTableBody.innerHTML = `<tr><td colspan="4" class="muted">Error: ${data.error}</td></tr>`;
    }
  } catch (error) {
    snapshotsTableBody.innerHTML = `<tr><td colspan="4" class="muted">Error al cargar snapshots: ${error}</td></tr>`;
  } finally {
    refreshSnapshotsBtn.disabled = false;
  }
}

async function runBacktest() {
  runBacktestBtn.disabled = true;
  backtestingResult.textContent = 'Ejecutando backtest...';
  try {
    const res = await fetch('/api/backtesting/run', { method: 'POST' });
    const data = await res.json();
    backtestingResult.textContent = JSON.stringify(data, null, 2);
    if (data.ok) {
      await loadSymbolReports();
    }
  } catch (error) {
    backtestingResult.textContent = `Error: ${error}`;
  } finally {
    runBacktestBtn.disabled = false;
  }
}

refreshHealthBtn.addEventListener('click', loadHealth);
runIngestBtn.addEventListener('click', runIngest);
runTradeBtn.addEventListener('click', runTradingCycle);
refreshSnapshotsBtn.addEventListener('click', loadSnapshots);
runBacktestBtn.addEventListener('click', runBacktest);
saveSettingsBtn.addEventListener('click', saveSettings);
tradingToggleBtn.addEventListener('click', toggleTradingEnabled);

riskPresetSelect.addEventListener('change', () => {
  const preset = riskPresetSelect.value;
  if (preset !== 'personalizado' && riskPresets[preset]) {
    fillRiskInputs(riskPresets[preset]);
  }
});

[riskPositionSizeInput, riskStopLossInput, riskTakeProfitInput, riskMaxPositionsInput].forEach((input) => {
  input.addEventListener('input', () => {
    riskPresetSelect.value = 'personalizado';
  });
});

loadHealth();
loadSettings();
loadSymbolReports();
loadSnapshots();
setInterval(loadHealth, 60000);
setInterval(loadSymbolReports, 60000);
