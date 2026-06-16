const healthGrid = document.getElementById('health-grid');
const healthUpdated = document.getElementById('health-updated');
const refreshHealthBtn = document.getElementById('refresh-health');
const runIngestBtn = document.getElementById('run-ingest');
const ingestResult = document.getElementById('ingest-result');

const tradingToggleStatus = document.getElementById('trading-toggle-status');
const tradingToggleBtn = document.getElementById('trading-toggle-btn');

const riskPresetSelect = document.getElementById('risk-preset');
const riskPositionSizeInput = document.getElementById('risk-position-size');
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
const signalsSummaryTableBody = document.querySelector('#signals-summary-table tbody');
const conditionsTableBody = document.querySelector('#conditions-table tbody');
const conditionsTableNote = document.getElementById('conditions-table-note');
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

// Refleja TIER1_SYMBOLS de strategy/hybridConfig.ts — señal "main" calculada sobre velas 1H.
const HYBRID_TIER1_SYMBOLS = ['SPY', 'XLU'];
const HYBRID_TIER2_SYMBOLS = ['MS', 'QQQM'];
const HYBRID_SHADOW_SYMBOLS = ['SCHD'];

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

  const conditionStats = signal.buyConditionId === signal.sellConditionId
    ? [stat('Condición activa', signal.buyConditionLabel ?? '—')]
    : [
        stat('Condición compra', signal.buyConditionLabel ?? '—'),
        stat('Condición venta', signal.sellConditionLabel ?? '—'),
      ];

  return [
    stat('Precio', fmtMoney(signal.price)),
    ...conditionStats,
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
  const cardKey = signal.cardKey ?? symbol;
  let card = document.getElementById(`symbol-card-${cardKey}`);

  if (!card) {
    card = document.createElement('div');
    card.className = 'symbol-report-card';
    card.id = `symbol-card-${cardKey}`;
    card.innerHTML = `
      <div class="symbol-report-header">
        <h4>${symbol}${signal.cardBadge ? ` <span class="muted" style="font-size:0.8em">${signal.cardBadge}</span>` : ''}</h4>
        <span class="signal-badge"></span>
      </div>
      <div class="symbol-stats-grid"></div>
      <p class="muted symbol-reason"></p>
      <div class="symbol-position"></div>
      <div class="chart-canvas-wrap">
        <canvas></canvas>
      </div>
      <p class="muted chart-no-data hidden">Sin datos históricos todavía. Ejecutá la ingesta.</p>
      ${signal.hideAssessment ? '' : `<div class="symbol-subsection">
        <h5>Evaluación de IA (Claude)</h5>
        <div class="symbol-assessment"></div>
      </div>`}
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
  card.querySelector('.symbol-position').innerHTML = signal.positionLine ?? renderPositionLine(position);
  if (!signal.hideAssessment) {
    card.querySelector('.symbol-assessment').innerHTML = renderAssessmentBlock(assessment);
  }
  card.querySelector('.symbol-backtest').innerHTML = renderBacktestBlock(backtestSummary);

  return {
    signal,
    cardKey,
    canvas: card.querySelector('canvas'),
    noDataMsg: card.querySelector('.chart-no-data'),
  };
}

function renderSymbolReportsGroup(container, signals, assessmentsBySymbol, backtestSummaryBySymbol, positionsBySymbol) {
  if (signals.length === 0) {
    container.innerHTML = '<p class="muted">Sin señales todavía. Ejecutá la ingesta y un ciclo de trading.</p>';
    return [];
  }

  const seenCardKeys = new Set(signals.map((signal) => signal.cardKey ?? signal.symbol));
  container.querySelectorAll('.symbol-report-card').forEach((card) => {
    const cardKey = card.id.replace('symbol-card-', '');
    if (!seenCardKeys.has(cardKey)) {
      if (chartInstances[cardKey]) {
        chartInstances[cardKey].destroy();
        delete chartInstances[cardKey];
      }
      card.remove();
    }
  });

  return signals.map((signal, index) => renderSymbolCard(
    container,
    index,
    signal,
    assessmentsBySymbol.get(signal.symbol),
    backtestSummaryBySymbol.get(signal.cardKey ?? signal.symbol),
    positionsBySymbol.get(signal.symbol)
  ));
}

/**
 * Color representativo por condición, usado como badge en "Condición
 * activa"/"Condición" (tablas de resumen y de backtest) para identificar
 * de un vistazo qué símbolos comparten la misma condición.
 */
const CONDITION_COLORS = {
  sma_cross_10_30: '#2ecc71',
  sma_cross_20_50: '#16a085',
  ema_cross_12_26: '#1abc9c',
  macd_cross: '#4a82f0',
  rsi_reversal_30_70: '#9b59b6',
  bollinger_reversion: '#e67e22',
  bollinger_breakout: '#d35400',
  stochastic_cross: '#e74c3c',
  williams_r_reversal: '#c0392b',
  cci_reversal: '#e84393',
  donchian_breakout_20: '#f1c40f',
  trend_pullback_sma50: '#3498db',
};

function conditionBadge(conditionId, label) {
  const text = label ?? '—';
  if (!conditionId) return text;
  const color = CONDITION_COLORS[conditionId] ?? '#9aa0a6';
  return `<span class="condition-dot" style="background-color: ${color}"></span>${text}`;
}

/**
 * Overlays de gráfico por condición activa (Fase 6.1), usando los campos de
 * `ChartPoint` (`strategy/chart.ts`). `price`: líneas en el eje de precio (`y`),
 * mismas unidades que "Precio". `oscillator`: panel secundario (`y1`), con
 * `levels` (umbrales de la condición) dibujados como líneas punteadas grises.
 */
const CONDITION_CHART_CONFIG = {
  sma_cross_10_30: {
    price: [
      { key: 'sma10', label: 'SMA10', color: '#2ecc71' },
      { key: 'sma30', label: 'SMA30', color: '#e67e22' },
    ],
  },
  sma_cross_20_50: {
    price: [
      { key: 'sma20', label: 'SMA20', color: '#2ecc71' },
      { key: 'sma50', label: 'SMA50', color: '#e67e22' },
    ],
  },
  ema_cross_12_26: {
    price: [
      { key: 'ema12', label: 'EMA12', color: '#2ecc71' },
      { key: 'ema26', label: 'EMA26', color: '#e67e22' },
    ],
  },
  macd_cross: {
    oscillator: {
      label: 'MACD(12,26,9)',
      series: [
        { key: 'macd', label: 'MACD', color: '#2ecc71' },
        { key: 'macdSignal', label: 'Señal', color: '#e67e22' },
      ],
    },
  },
  rsi_reversal_30_70: {
    oscillator: {
      label: 'RSI(14)',
      series: [{ key: 'rsi14', label: 'RSI14', color: '#2ecc71' }],
      min: 0,
      max: 100,
      levels: [30, 70],
    },
  },
  bollinger_reversion: {
    price: [
      { key: 'bbUpper', label: 'BB sup', color: '#e67e22' },
      { key: 'bbMiddle', label: 'BB media', color: '#9aa0a6' },
      { key: 'bbLower', label: 'BB inf', color: '#2ecc71' },
    ],
  },
  bollinger_breakout: {
    price: [
      { key: 'bbUpper', label: 'BB sup', color: '#e67e22' },
      { key: 'bbMiddle', label: 'BB media', color: '#9aa0a6' },
      { key: 'bbLower', label: 'BB inf', color: '#2ecc71' },
    ],
  },
  stochastic_cross: {
    oscillator: {
      label: 'Estocástico(14,3)',
      series: [
        { key: 'stochK', label: '%K', color: '#2ecc71' },
        { key: 'stochD', label: '%D', color: '#e67e22' },
      ],
      min: 0,
      max: 100,
      levels: [20, 80],
    },
  },
  williams_r_reversal: {
    oscillator: {
      label: 'Williams %R(14)',
      series: [{ key: 'williamsR', label: '%R', color: '#2ecc71' }],
      min: -100,
      max: 0,
      levels: [-80, -20],
    },
  },
  cci_reversal: {
    oscillator: {
      label: 'CCI(20)',
      series: [{ key: 'cci20', label: 'CCI20', color: '#2ecc71' }],
      levels: [-100, 100],
    },
  },
  donchian_breakout_20: {
    price: [
      { key: 'priorHigh20', label: 'Canal sup (20)', color: '#e67e22' },
      { key: 'priorLow10', label: 'Canal inf (10)', color: '#2ecc71' },
    ],
  },
  trend_pullback_sma50: {
    price: [
      { key: 'sma50', label: 'SMA50', color: '#e67e22' },
    ],
    oscillator: {
      label: 'RSI(14)',
      series: [{ key: 'rsi14', label: 'RSI14', color: '#2ecc71' }],
      min: 0,
      max: 100,
      levels: [40],
    },
  },
};

/**
 * Combina los overlays de gráfico (Fase 6.1) de la condición de compra y la de venta
 * (Fase 7) cuando son distintas: los overlays de precio (`price`) de ambas se
 * concatenan (sin duplicar por `key`); el panel oscilador (`oscillator`) se toma de
 * la condición de compra si define uno, o de la de venta si no.
 */
function mergeConditionChartConfig(buyConditionId, sellConditionId) {
  const buyConfig = CONDITION_CHART_CONFIG[buyConditionId] ?? {};
  if (buyConditionId === sellConditionId) return buyConfig;

  const sellConfig = CONDITION_CHART_CONFIG[sellConditionId] ?? {};

  const priceByKey = new Map();
  [...(buyConfig.price ?? []), ...(sellConfig.price ?? [])].forEach((overlay) => {
    if (!priceByKey.has(overlay.key)) priceByKey.set(overlay.key, overlay);
  });

  return {
    price: Array.from(priceByKey.values()),
    oscillator: buyConfig.oscillator ?? sellConfig.oscillator,
  };
}

async function renderSymbolCharts(entries) {
  if (entries.length === 0) return;

  const results = await Promise.all(
    entries.map(async (entry) => {
      try {
        const chartQuery = entry.signal.chartQuery ?? '';
        const res = await fetch(`/api/trading/chart/${entry.signal.symbol}${chartQuery}`);
        const data = await res.json();
        return { ...entry, ok: data.ok, points: data.points, timeframe: data.timeframe, error: data.error };
      } catch (error) {
        return { ...entry, ok: false, error: String(error) };
      }
    })
  );

  results.forEach((result) => {
    const { signal, cardKey, canvas, noDataMsg } = result;
    const instanceKey = cardKey ?? signal.symbol;

    if (chartInstances[instanceKey]) {
      chartInstances[instanceKey].destroy();
      delete chartInstances[instanceKey];
    }

    if (!result.ok || !result.points || result.points.length === 0) {
      canvas.classList.add('hidden');
      noDataMsg.classList.remove('hidden');
      return;
    }

    canvas.classList.remove('hidden');
    noDataMsg.classList.add('hidden');

    const is1H = result.timeframe === '1Hour';
    const labels = result.points.map((point) =>
      is1H ? new Date(point.ts).toLocaleString() : new Date(point.ts).toLocaleDateString()
    );
    const closes = result.points.map((point) => point.close);
    const chartConfig = mergeConditionChartConfig(signal.buyConditionId, signal.sellConditionId);

    const datasets = [
      {
        label: 'Precio',
        data: closes,
        borderColor: '#4a82f0',
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.1,
        yAxisID: 'y',
      },
    ];

    (chartConfig.price ?? []).forEach((overlay) => {
      datasets.push({
        label: overlay.label,
        data: result.points.map((point) => point[overlay.key]),
        borderColor: overlay.color,
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.1,
        yAxisID: 'y',
      });
    });

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
        yAxisID: 'y',
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
        yAxisID: 'y',
      });
    }

    const oscillator = chartConfig.oscillator;
    if (oscillator) {
      oscillator.series.forEach((s) => {
        datasets.push({
          label: s.label,
          data: result.points.map((point) => point[s.key]),
          borderColor: s.color,
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.1,
          yAxisID: 'y1',
        });
      });

      (oscillator.levels ?? []).forEach((level) => {
        datasets.push({
          label: `Nivel ${level}`,
          data: labels.map(() => level),
          borderColor: '#7f8c8d',
          backgroundColor: 'transparent',
          borderWidth: 1,
          borderDash: [4, 4],
          pointRadius: 0,
          tension: 0,
          yAxisID: 'y1',
        });
      });
    }

    const scales = {
      x: { ticks: { color: '#9aa0a6', maxTicksLimit: 8 }, grid: { color: '#2a2e35' } },
      y: { ticks: { color: '#9aa0a6' }, grid: { color: '#2a2e35' } },
    };

    if (oscillator) {
      scales.y1 = {
        position: 'right',
        ticks: { color: '#9aa0a6' },
        grid: { drawOnChartArea: false },
        title: { display: true, text: oscillator.label, color: '#9aa0a6' },
      };
      if (oscillator.min !== undefined) scales.y1.min = oscillator.min;
      if (oscillator.max !== undefined) scales.y1.max = oscillator.max;
    }

    chartInstances[instanceKey] = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales,
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

function renderParallelPositionLine(pos) {
  if (!pos) return '<p class="muted">Sin posición paralela abierta.</p>';
  return `<p>Posición paralela · ${fmtNum(pos.qty, 0)} acc. · entrada ${fmtMoney(pos.entryPrice)} · abierta ${new Date(pos.openedAt).toLocaleString()}</p>`;
}

function renderBacktestingSummary(run) {
  if (!run) {
    backtestingPeriod.textContent = '';
    backtestingPortfolio.textContent = '';
    conditionsTableNote.textContent = '';
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

  conditionsTableNote.textContent =
    `Período del backtest: ${startDate} → ${endDate} (${trades.length} trades guardados en total). ` +
    `"Retorno total" es el retorno acumulado (compuesto) de todas las operaciones de esa condición durante ese período, ` +
    `no el resultado de una sola operación. "Buy & Hold" es el retorno de comprar al inicio del período y mantener hasta el final, ` +
    `con dividendos reinvertidos (precio ajustado por splits y dividendos). "Retorno prom." es el promedio por operación individual (columna "Trades").`;
}

/**
 * Tablas ordenables por columna (click en el encabezado): columnas `string`
 * se ordenan alfabéticamente (`localeCompare`), columnas `number` de forma
 * numérica (`null`/`undefined` van al final en ascendente). Un segundo click
 * en la misma columna invierte el sentido.
 */
// Nombres cortos para las 12 condiciones de TA (para la columna combinada compra→venta).
const COND_SHORT = {
  sma_cross_10_30:     'SMA10/30',
  sma_cross_20_50:     'SMA20/50',
  ema_cross_12_26:     'EMA12/26',
  macd_cross:          'MACD',
  rsi_reversal_30_70:  'RSI 30/70',
  bollinger_reversion: 'BB Rev.',
  bollinger_breakout:  'BB Break.',
  stochastic_cross:    'Estoc.',
  williams_r_reversal: 'Will.%R',
  cci_reversal:        'CCI',
  donchian_breakout_20:'Donchian',
  trend_pullback_sma50:'Tend.+SMA50',
};

function condShort(id) { return COND_SHORT[id] ?? id; }

// Clases CSS para la recomendación de Claude (paralelo a signalClass para la señal técnica).
function aiRecClass(rec) {
  if (rec === 'buy')   return 'signal-buy';
  if (rec === 'avoid') return 'signal-sell';
  return 'signal-hold';
}

const SIGNALS_TABLE_COLUMNS = [
  { key: 'symbol',     type: 'string', getValue: (s) => s.symbol },
  { key: 'type',       type: 'string', getValue: (s) => s.type },
  { key: 'system',     type: 'string', getValue: (s) => s.systemLabel ?? '' },
  { key: 'signal',     type: 'string', getValue: (s) => s.signal },
  { key: 'aiRec',      type: 'string', getValue: (s) => s.aiRecommendation ?? '' },
  { key: 'conditions', type: 'string', getValue: (s) => (s.buyConditionId ?? '') + '→' + (s.sellConditionId ?? '') },
  { key: 'entryPrice', type: 'number', getValue: (s) => s.estimatedEntryPrice ?? null },
  { key: 'exitPrice',  type: 'number', getValue: (s) => s.estimatedExitPrice ?? null },
  { key: 'reason',     type: 'string', getValue: (s) => s.simplifiedReason ?? s.reason ?? '' },
];

const CONDITIONS_TABLE_COLUMNS = [
  { key: 'symbol', type: 'string', getValue: (c) => c.symbol },
  { key: 'system', type: 'string', getValue: (c) => c.systemLabel ?? '' },
  { key: 'buyCondition', type: 'string', getValue: (c) => c.buyConditionLabel },
  { key: 'sellCondition', type: 'string', getValue: (c) => c.sellConditionLabel },
  { key: 'trades', type: 'number', getValue: (c) => c.trades },
  { key: 'winRate', type: 'number', getValue: (c) => c.winRatePct },
  { key: 'totalReturn', type: 'number', getValue: (c) => c.totalReturnPct },
  { key: 'buyHold', type: 'number', getValue: (c) => c.buyHoldReturnPct },
  { key: 'avgReturn', type: 'number', getValue: (c) => c.avgReturnPct },
  { key: 'maxDD', type: 'number', getValue: (c) => c.maxDrawdownPct },
  { key: 'updatedAt', type: 'number', getValue: (c) => (c.updatedAt ? new Date(c.updatedAt).getTime() : null) },
];

// Orden inicial: "Resumen de señales" agrupado por Condición de compra (a-z).
const signalsSortState = { key: 'buyCondition', direction: 'asc' };
const conditionsSortState = { key: null, direction: 'asc' };

let latestSignals = [];
let latestConditions = [];

function compareValues(va, vb, type, direction) {
  const dir = direction === 'desc' ? -1 : 1;
  if (type === 'number') {
    const na = va === null || va === undefined ? -Infinity : va;
    const nb = vb === null || vb === undefined ? -Infinity : vb;
    if (na < nb) return -1 * dir;
    if (na > nb) return 1 * dir;
    return 0;
  }
  return String(va ?? '').localeCompare(String(vb ?? '')) * dir;
}

function sortRows(rows, columns, sortState) {
  if (!sortState.key) return rows;
  const column = columns.find((c) => c.key === sortState.key);
  if (!column) return rows;
  return [...rows].sort((a, b) => compareValues(column.getValue(a), column.getValue(b), column.type, sortState.direction));
}

function updateSortIndicators(tableId, sortState) {
  document.querySelectorAll(`#${tableId} thead th[data-sort-key]`).forEach((th) => {
    let arrow = th.querySelector('.sort-arrow');
    if (!arrow) {
      arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      th.appendChild(arrow);
    }
    if (th.dataset.sortKey === sortState.key) {
      th.classList.add('sort-active');
      arrow.textContent = sortState.direction === 'asc' ? '▲' : '▼';
    } else {
      th.classList.remove('sort-active');
      arrow.textContent = '';
    }
  });
}

function setupSortableTable(tableId, sortState, onChange) {
  document.querySelectorAll(`#${tableId} thead th[data-sort-key]`).forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (sortState.key === key) {
        sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
      } else {
        sortState.key = key;
        sortState.direction = 'asc';
      }
      onChange();
    });
  });
}

function renderSignalsSummaryTable() {
  signalsSummaryTableBody.innerHTML = '';
  if (latestSignals.length === 0) {
    signalsSummaryTableBody.innerHTML = '<tr><td colspan="9" class="muted">Sin señales todavía. Ejecutá la ingesta y un ciclo de trading.</td></tr>';
  } else {
    const sorted = sortRows(latestSignals, SIGNALS_TABLE_COLUMNS, signalsSortState);
    sorted.forEach((signal) => {
      const entry = signal.estimatedEntryPrice != null ? fmtMoney(signal.estimatedEntryPrice) : '—';
      const exit_ = signal.estimatedExitPrice != null ? fmtMoney(signal.estimatedExitPrice) : '—';

      // Condiciones combinadas: "BB Rev. → SMA10/30" (o solo "BB Rev." si son iguales).
      const buyShort = condShort(signal.buyConditionId);
      const sellShort = condShort(signal.sellConditionId);
      const condCell = signal.buyConditionId === signal.sellConditionId
        ? `<span class="cond-badge" title="${signal.buyConditionLabel ?? ''}">${buyShort}</span>`
        : `<span class="cond-badge" title="Compra: ${signal.buyConditionLabel ?? ''}">${buyShort}</span>`
          + `<span class="cond-arrow">→</span>`
          + `<span class="cond-badge" title="Venta: ${signal.sellConditionLabel ?? ''}">${sellShort}</span>`;

      // Evaluación de IA: muestra recomendación + confianza (si existe).
      const rec = signal.aiRecommendation;
      const conf = signal.aiConfidence != null ? ` ${Math.round(signal.aiConfidence * 100)}%` : '';
      const aiCell = rec
        ? `<span class="${aiRecClass(rec)}" title="${signal.aiRationale ?? ''}">${rec}${conf}</span>`
        : '<span class="muted">—</span>';

      // Motivo: razón simplificada de Claude; fallback al reason técnico.
      const motivo = signal.simplifiedReason || signal.reason || '';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${signal.symbol}</td>
        <td>${signal.type}</td>
        <td class="muted">${signal.systemLabel ?? ''}</td>
        <td><span class="${signalClass(signal.signal)}">${signal.signal}</span></td>
        <td class="ai-rec-cell">${aiCell}</td>
        <td class="cond-cell">${condCell}</td>
        <td class="price-cell">${entry}</td>
        <td class="price-cell">${exit_}</td>
        <td class="muted reason-cell">${motivo}</td>
      `;
      signalsSummaryTableBody.appendChild(tr);
    });
  }
  updateSortIndicators('signals-summary-table', signalsSortState);
}

function renderConditionsTable() {
  conditionsTableBody.innerHTML = '';
  if (latestConditions.length === 0) {
    conditionsTableBody.innerHTML = '<tr><td colspan="11" class="muted">Sin datos todavía. Ejecutá un backtest.</td></tr>';
  } else {
    const sorted = sortRows(latestConditions, CONDITIONS_TABLE_COLUMNS, conditionsSortState);
    sorted.forEach((c) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${c.symbol}</td>
        <td class="muted">${c.systemLabel ?? ''}</td>
        <td>${conditionBadge(c.buyConditionId, c.buyConditionLabel)}</td>
        <td>${conditionBadge(c.sellConditionId, c.sellConditionLabel)}</td>
        <td>${c.trades}</td>
        <td>${c.winRatePct !== null ? `${fmtNum(c.winRatePct, 1)}%` : '—'}</td>
        <td class="${c.totalReturnPct >= 0 ? 'pl-positive' : 'pl-negative'}">${fmtNum(c.totalReturnPct)}%</td>
        <td class="${c.buyHoldReturnPct !== null ? (c.buyHoldReturnPct >= 0 ? 'pl-positive' : 'pl-negative') : ''}">${c.buyHoldReturnPct !== null ? `${fmtNum(c.buyHoldReturnPct)}%` : '—'}</td>
        <td>${c.avgReturnPct !== null ? `${fmtNum(c.avgReturnPct)}%` : '—'}</td>
        <td>${fmtNum(c.maxDrawdownPct)}%</td>
        <td>${c.updatedAt ? new Date(c.updatedAt).toLocaleString() : '—'}</td>
      `;
      conditionsTableBody.appendChild(tr);
    });
  }
  updateSortIndicators('conditions-table', conditionsSortState);
}

async function loadSymbolReports() {
  try {
    const [statusRes, assessmentsRes, backtestingRes, conditionsRes] = await Promise.all([
      fetch('/api/trading/status'),
      fetch('/api/assessments'),
      fetch('/api/backtesting/results'),
      fetch('/api/conditions'),
    ]);

    const statusData = await statusRes.json();
    if (!statusData.ok) {
      tradingAccount.textContent = `Error al cargar estado de trading: ${statusData.error}`;
      return;
    }

    const assessmentsData = await assessmentsRes.json();
    const backtestingData = await backtestingRes.json();
    const conditionsData = await conditionsRes.json();

    const { account, positions, signals, hybridSignals, parallelPositions, orders, openOrdersCount } = statusData;

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

    // Decorar señales "main": systemLabel, chartQuery (tier 1), y campos de evaluación AI.
    const decoratedSignals = signals.map((signal) => {
      const assessment = assessmentsBySymbol.get(signal.symbol);
      const aiFields = {
        simplifiedReason:   assessment?.simplifiedReason ?? null,
        aiRecommendation:   assessment?.recommendation ?? null,
        aiConfidence:       assessment?.confidence ?? null,
        aiRationale:        assessment?.rationale ?? null,
      };
      if (HYBRID_TIER1_SYMBOLS.includes(signal.symbol)) {
        return { ...signal, systemLabel: '1H', cardBadge: '1H', chartQuery: '?tf=1H', ...aiFields };
      }
      return { ...signal, systemLabel: '1D', ...aiFields };
    });

    // Decorar señales híbridas 1H (tier 2 / shadow) con systemLabel y tipo heredado.
    // Reutilizan la evaluación AI del símbolo main (no tienen evaluación propia).
    const decoratedHybridSignals = (hybridSignals ?? []).map((signal) => {
      const systemLabel = signal.system === 'shadow' ? '1H · Sombra' : '1H · Paralelo';
      const mainSignal = signals.find((s) => s.symbol === signal.symbol);
      const assessment = assessmentsBySymbol.get(signal.symbol);
      return {
        ...signal, systemLabel, type: mainSignal?.type ?? 'STOCK',
        simplifiedReason: assessment?.simplifiedReason ?? null,
        aiRecommendation: assessment?.recommendation ?? null,
        aiConfidence:     assessment?.confidence ?? null,
        aiRationale:      assessment?.rationale ?? null,
      };
    });

    // Tabla "Resumen de señales": main (20) + híbridas (3).
    latestSignals = [...decoratedSignals, ...decoratedHybridSignals];

    // Tabla "Condiciones por símbolo": decorar con systemLabel desde server.
    const rawConditions = conditionsData.ok ? conditionsData.conditions : [];
    latestConditions = rawConditions.map((c) => {
      let systemLabel;
      if (c.system === 'main') {
        systemLabel = c.timeframe === '1Hour' ? '1H' : '1D';
      } else if (c.system === 'parallel') {
        systemLabel = '1H · Paralelo';
      } else {
        systemLabel = '1H · Sombra';
      }
      return { ...c, systemLabel };
    });

    renderSignalsSummaryTable();
    renderConditionsTable();

    // Tarjetas por símbolo: insertar card sintética para tier2/shadow justo después de la main.
    const parallelPositionsBySymbol = new Map(
      (parallelPositions ?? []).filter((p) => p.status === 'open').map((p) => [p.symbol, p])
    );
    const conditions1HBySymbol = new Map(
      latestConditions.filter((c) => c.timeframe === '1Hour').map((c) => [c.symbol, c])
    );

    function buildHybridSyntheticSignal(hybridSig) {
      const { symbol } = hybridSig;
      const isShadow = HYBRID_SHADOW_SYMBOLS.includes(symbol);
      const systemLabel = isShadow ? '1H · Sombra' : '1H · Paralelo';
      const cond1h = conditions1HBySymbol.get(symbol);
      const backtestSummary = cond1h
        ? { trades: cond1h.trades, winRate: cond1h.winRatePct, totalReturnPct: cond1h.totalReturnPct, avgReturnPct: cond1h.avgReturnPct, maxDrawdownPct: cond1h.maxDrawdownPct }
        : null;
      const positionLine = isShadow
        ? '<p class="muted">Modo sombra: solo registra señal, sin posición.</p>'
        : renderParallelPositionLine(parallelPositionsBySymbol.get(symbol) ?? null);
      return {
        ...hybridSig,
        cardKey: symbol + '::hybrid',
        cardBadge: systemLabel,
        chartQuery: '?tf=1H',
        hideAssessment: true,
        positionLine,
        _backtestSummary: backtestSummary,
      };
    }

    function spliceHybridCards(signalList) {
      const result = [];
      for (const signal of signalList) {
        result.push(signal);
        const hybridSig = decoratedHybridSignals.find((h) => h.symbol === signal.symbol);
        if (hybridSig) {
          result.push(buildHybridSyntheticSignal(hybridSig));
        }
      }
      return result;
    }

    const etfSignals = spliceHybridCards(
      decoratedSignals.filter((signal) => signal.type === 'ETF').sort((a, b) => attractivenessScore(b) - attractivenessScore(a))
    );
    const stockSignals = spliceHybridCards(
      decoratedSignals.filter((signal) => signal.type === 'STOCK').sort((a, b) => attractivenessScore(b) - attractivenessScore(a))
    );

    // backtestSummaryBySymbol override para tarjetas sintéticas (usa _backtestSummary).
    const extendedBacktestMap = new Map(backtestSummaryBySymbol);
    [...etfSignals, ...stockSignals].forEach((signal) => {
      if (signal._backtestSummary) extendedBacktestMap.set(signal.cardKey, signal._backtestSummary);
    });

    const etfEntries = renderSymbolReportsGroup(symbolReportsEtf, etfSignals, assessmentsBySymbol, extendedBacktestMap, positionsBySymbol);
    const stockEntries = renderSymbolReportsGroup(symbolReportsStock, stockSignals, assessmentsBySymbol, extendedBacktestMap, positionsBySymbol);

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

[riskPositionSizeInput, riskMaxPositionsInput].forEach((input) => {
  input.addEventListener('input', () => {
    riskPresetSelect.value = 'personalizado';
  });
});

setupSortableTable('signals-summary-table', signalsSortState, renderSignalsSummaryTable);
setupSortableTable('conditions-table', conditionsSortState, renderConditionsTable);

loadHealth();
loadSettings();
loadSymbolReports();
loadSnapshots();
setInterval(loadHealth, 60000);
setInterval(loadSymbolReports, 60000);
