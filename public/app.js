const healthGrid = document.getElementById('health-grid');
const healthUpdated = document.getElementById('health-updated');
const refreshHealthBtn = document.getElementById('refresh-health');
const runIngestBtn = document.getElementById('run-ingest');
const ingestResult = document.getElementById('ingest-result');
const grafanaContainer = document.getElementById('grafana-container');

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
const signalsTableBodyEtf = document.querySelector('#signals-table-etf tbody');
const signalsTableBodyStock = document.querySelector('#signals-table-stock tbody');
const signalChartsEtf = document.getElementById('signal-charts-etf');
const signalChartsStock = document.getElementById('signal-charts-stock');
const positionsTableBody = document.querySelector('#positions-table tbody');
const ordersTableBody = document.querySelector('#orders-table tbody');
const runTradeBtn = document.getElementById('run-trade');
const tradeResult = document.getElementById('trade-result');

const snapshotsTableBody = document.querySelector('#snapshots-table tbody');
const refreshSnapshotsBtn = document.getElementById('refresh-snapshots');
const snapshotsUpdated = document.getElementById('snapshots-updated');

const assessmentsTableBody = document.querySelector('#assessments-table tbody');
const refreshAssessmentsBtn = document.getElementById('refresh-assessments');
const assessmentsUpdated = document.getElementById('assessments-updated');

const backtestingTableBody = document.querySelector('#backtesting-table tbody');
const backtestingPeriod = document.getElementById('backtesting-period');
const backtestingPortfolio = document.getElementById('backtesting-portfolio');
const runBacktestBtn = document.getElementById('run-backtest');
const backtestingResult = document.getElementById('backtesting-result');
const backtestingUpdated = document.getElementById('backtesting-updated');

const chartInstances = {};

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

function renderSignalsTable(tbody, signals) {
  tbody.innerHTML = '';
  if (signals.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="muted">Sin señales todavía. Ejecutá la ingesta y un ciclo de trading.</td></tr>';
    return;
  }

  signals.forEach((signal) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${signal.symbol}</td>
      <td>${fmtMoney(signal.price)}</td>
      <td>${fmtNum(signal.smaFast)}</td>
      <td>${fmtNum(signal.smaSlow)}</td>
      <td>${fmtNum(signal.rsi)}</td>
      <td>${signal.momentum !== null ? `${fmtNum(signal.momentum)}%` : '—'}</td>
      <td>${signal.estimatedEntryPrice !== null ? fmtMoney(signal.estimatedEntryPrice) : '—'}</td>
      <td>${signal.estimatedExitPrice !== null ? fmtMoney(signal.estimatedExitPrice) : '—'}</td>
      <td><span class="${signalClass(signal.signal)}">${signal.signal}</span></td>
      <td class="muted">${signal.reason}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderTradingStatus(data) {
  const { account, positions, signals, orders } = data;

  tradingAccount.textContent =
    `Cuenta ${account.accountNumber} (${account.status}) · Equity: ${fmtMoney(account.equity)} · ` +
    `Cash: ${fmtMoney(account.cash)} · Buying power: ${fmtMoney(account.buyingPower)}`;

  const etfSignals = signals.filter((signal) => signal.type === 'ETF').sort((a, b) => attractivenessScore(b) - attractivenessScore(a));
  const stockSignals = signals.filter((signal) => signal.type === 'STOCK').sort((a, b) => attractivenessScore(b) - attractivenessScore(a));

  renderSignalsTable(signalsTableBodyEtf, etfSignals);
  renderSignalsTable(signalsTableBodyStock, stockSignals);

  renderSignalCharts(signalChartsEtf, etfSignals);
  renderSignalCharts(signalChartsStock, stockSignals);

  positionsTableBody.innerHTML = '';
  if (positions.length === 0) {
    positionsTableBody.innerHTML = '<tr><td colspan="6" class="muted">Sin posiciones abiertas.</td></tr>';
  } else {
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

  ordersTableBody.innerHTML = '';
  if (orders.length === 0) {
    ordersTableBody.innerHTML = '<tr><td colspan="8" class="muted">Sin órdenes registradas.</td></tr>';
  } else {
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
}

async function renderSignalCharts(container, signals) {
  if (signals.length === 0) {
    container.innerHTML = '<p class="muted">Sin datos todavía. Ejecutá la ingesta y un ciclo de trading.</p>';
    return;
  }

  const results = await Promise.all(
    signals.map(async (signal) => {
      try {
        const res = await fetch(`/api/trading/chart/${signal.symbol}`);
        const data = await res.json();
        return { symbol: signal.symbol, ok: data.ok, points: data.points, error: data.error };
      } catch (error) {
        return { symbol: signal.symbol, ok: false, error: String(error) };
      }
    })
  );

  const seenSymbols = new Set(results.map((result) => result.symbol));
  container.querySelectorAll('.chart-card').forEach((card) => {
    const symbol = card.id.replace('chart-card-', '');
    if (!seenSymbols.has(symbol)) {
      if (chartInstances[symbol]) {
        chartInstances[symbol].destroy();
        delete chartInstances[symbol];
      }
      card.remove();
    }
  });

  results.forEach((result, index) => {
    let card = document.getElementById(`chart-card-${result.symbol}`);
    let canvas;
    let noDataMsg;

    if (!card) {
      card = document.createElement('div');
      card.className = 'chart-card';
      card.id = `chart-card-${result.symbol}`;

      const title = document.createElement('h4');
      title.textContent = result.symbol;
      card.appendChild(title);

      const canvasWrap = document.createElement('div');
      canvasWrap.className = 'chart-canvas-wrap';

      canvas = document.createElement('canvas');
      canvasWrap.appendChild(canvas);
      card.appendChild(canvasWrap);

      noDataMsg = document.createElement('p');
      noDataMsg.className = 'muted chart-no-data';
      noDataMsg.textContent = 'Sin datos históricos todavía. Ejecutá la ingesta.';
      card.appendChild(noDataMsg);

      container.appendChild(card);
    } else {
      canvas = card.querySelector('canvas');
      noDataMsg = card.querySelector('.chart-no-data');
    }

    // Mantener el orden según el ranking de atractivo.
    if (container.children[index] !== card) {
      container.insertBefore(card, container.children[index] ?? null);
    }

    if (chartInstances[result.symbol]) {
      chartInstances[result.symbol].destroy();
      delete chartInstances[result.symbol];
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

    const signal = signals.find((s) => s.symbol === result.symbol);
    if (signal && signal.estimatedEntryPrice !== null) {
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
    if (signal && signal.estimatedExitPrice !== null) {
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

    chartInstances[result.symbol] = new Chart(canvas, {
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

async function loadTradingStatus() {
  try {
    const res = await fetch('/api/trading/status');
    const data = await res.json();
    if (data.ok) {
      renderTradingStatus(data);
    } else {
      tradingAccount.textContent = `Error al cargar estado de trading: ${data.error}`;
    }
  } catch (error) {
    tradingAccount.textContent = `Error al cargar estado de trading: ${error}`;
  }
}

async function runTradingCycle() {
  const confirmed = window.confirm(
    'Esto calcula señales y, según el perfil de riesgo, puede abrir o cerrar posiciones REALES ' +
    '(con dinero simulado) en la cuenta paper de Alpaca. ¿Continuar?'
  );
  if (!confirmed) return;

  runTradeBtn.disabled = true;
  tradeResult.textContent = 'Ejecutando ciclo de trading...';
  try {
    const res = await fetch('/api/trading/run', { method: 'POST' });
    const data = await res.json();
    tradeResult.textContent = JSON.stringify(data, null, 2);
    if (data.ok) {
      await loadTradingStatus();
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

function recommendationClass(recommendation) {
  if (recommendation === 'buy') return 'signal-buy';
  if (recommendation === 'avoid') return 'signal-sell';
  return 'signal-hold';
}

function renderAssessments(assessments) {
  assessmentsTableBody.innerHTML = '';
  if (assessments.length === 0) {
    assessmentsTableBody.innerHTML = '<tr><td colspan="8" class="muted">Sin evaluaciones todavía (requiere ANTHROPIC_API_KEY y un ciclo de trading).</td></tr>';
    return;
  }

  assessments.forEach((assessment) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${assessment.symbol}</td>
      <td>${new Date(assessment.ts).toLocaleString()}</td>
      <td>${fmtNum(assessment.score)}</td>
      <td><span class="${recommendationClass(assessment.recommendation)}">${assessment.recommendation.toUpperCase()}</span></td>
      <td>${assessment.confidence !== null ? fmtNum(assessment.confidence) : '—'}</td>
      <td>${assessment.adjustedEntryPrice !== null ? fmtMoney(assessment.adjustedEntryPrice) : '—'}</td>
      <td>${assessment.adjustedExitPrice !== null ? fmtMoney(assessment.adjustedExitPrice) : '—'}</td>
      <td class="muted">${assessment.rationale ?? ''}</td>
    `;
    assessmentsTableBody.appendChild(tr);
  });
}

async function loadAssessments() {
  refreshAssessmentsBtn.disabled = true;
  try {
    const res = await fetch('/api/assessments');
    const data = await res.json();
    if (data.ok) {
      renderAssessments(data.assessments);
      assessmentsUpdated.textContent = `Última actualización: ${new Date().toLocaleTimeString()}`;
    } else {
      assessmentsTableBody.innerHTML = `<tr><td colspan="8" class="muted">Error: ${data.error}</td></tr>`;
    }
  } catch (error) {
    assessmentsTableBody.innerHTML = `<tr><td colspan="8" class="muted">Error al cargar evaluaciones: ${error}</td></tr>`;
  } finally {
    refreshAssessmentsBtn.disabled = false;
  }
}

function renderBacktesting(run) {
  if (!run) {
    backtestingTableBody.innerHTML = '<tr><td colspan="6" class="muted">Sin corridas todavía. Ejecutá un backtest.</td></tr>';
    backtestingPeriod.textContent = '';
    backtestingPortfolio.textContent = '';
    return;
  }

  const { run: meta, trades } = run;
  const summary = meta.summary || {};
  const symbols = summary.symbols || [];
  const portfolio = summary.portfolio || {};

  const startDate = meta.startDate ? String(meta.startDate).slice(0, 10) : 'n/a';
  const endDate = meta.endDate ? String(meta.endDate).slice(0, 10) : 'n/a';
  backtestingPeriod.textContent =
    `Periodo: ${startDate} → ${endDate} ` +
    `(última corrida: ${new Date(meta.runAt).toLocaleString()}, ${trades.length} trades guardados)`;

  backtestingTableBody.innerHTML = '';
  if (symbols.length === 0) {
    backtestingTableBody.innerHTML = '<tr><td colspan="6" class="muted">Sin resultados por símbolo.</td></tr>';
  } else {
    symbols.forEach((s) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${s.symbol}</td>
        <td>${s.trades}</td>
        <td>${s.winRate !== null ? `${fmtNum(s.winRate, 1)}%` : '—'}</td>
        <td class="${s.totalReturnPct >= 0 ? 'pl-positive' : 'pl-negative'}">${fmtNum(s.totalReturnPct)}%</td>
        <td>${s.avgReturnPct !== null ? `${fmtNum(s.avgReturnPct)}%` : '—'}</td>
        <td>${fmtNum(s.maxDrawdownPct)}%</td>
      `;
      backtestingTableBody.appendChild(tr);
    });
  }

  backtestingPortfolio.textContent =
    `Portafolio: ${portfolio.symbols ?? '—'} símbolos · ${portfolio.totalTrades ?? 0} trades · ` +
    `retorno prom. ${portfolio.avgReturnPct !== null && portfolio.avgReturnPct !== undefined ? `${fmtNum(portfolio.avgReturnPct)}%` : '—'} · ` +
    `win rate prom. ${portfolio.avgWinRatePct !== null && portfolio.avgWinRatePct !== undefined ? `${fmtNum(portfolio.avgWinRatePct, 1)}%` : '—'} · ` +
    `mejor: ${portfolio.bestSymbol ?? '—'} · peor: ${portfolio.worstSymbol ?? '—'}`;
}

async function loadBacktesting() {
  try {
    const res = await fetch('/api/backtesting/results');
    const data = await res.json();
    if (data.ok) {
      renderBacktesting(data.run);
      backtestingUpdated.textContent = `Última actualización: ${new Date().toLocaleTimeString()}`;
    } else {
      backtestingTableBody.innerHTML = `<tr><td colspan="6" class="muted">Error: ${data.error}</td></tr>`;
    }
  } catch (error) {
    backtestingTableBody.innerHTML = `<tr><td colspan="6" class="muted">Error al cargar backtesting: ${error}</td></tr>`;
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
      await loadBacktesting();
    }
  } catch (error) {
    backtestingResult.textContent = `Error: ${error}`;
  } finally {
    runBacktestBtn.disabled = false;
  }
}

async function loadGrafana() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();

    if (data.grafanaPublicUrl) {
      grafanaContainer.innerHTML = '';
      const iframe = document.createElement('iframe');
      iframe.src = data.grafanaPublicUrl;
      iframe.title = 'Vibe Bots - Grafana';
      iframe.loading = 'lazy';
      grafanaContainer.appendChild(iframe);
    } else {
      grafanaContainer.innerHTML = '<p class="muted">Configura GRAFANA_PUBLIC_URL para mostrar el dashboard aquí.</p>';
    }
  } catch (error) {
    grafanaContainer.innerHTML = `<p class="muted">Error al cargar configuración de Grafana: ${error}</p>`;
  }
}

refreshHealthBtn.addEventListener('click', loadHealth);
runIngestBtn.addEventListener('click', runIngest);
runTradeBtn.addEventListener('click', runTradingCycle);
refreshSnapshotsBtn.addEventListener('click', loadSnapshots);
refreshAssessmentsBtn.addEventListener('click', loadAssessments);
runBacktestBtn.addEventListener('click', runBacktest);
saveSettingsBtn.addEventListener('click', saveSettings);

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
loadGrafana();
loadSettings();
loadTradingStatus();
loadSnapshots();
loadAssessments();
loadBacktesting();
setInterval(loadHealth, 60000);
setInterval(loadTradingStatus, 60000);
setInterval(loadAssessments, 60000);
