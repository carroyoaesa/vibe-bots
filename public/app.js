const healthGrid = document.getElementById('health-grid');
const healthUpdated = document.getElementById('health-updated');
const refreshHealthBtn = document.getElementById('refresh-health');
const runIngestBtn = document.getElementById('run-ingest');
const ingestResult = document.getElementById('ingest-result');
const statusBadge = document.getElementById('status-badge');

const tradingToggleStatus = document.getElementById('trading-toggle-status');
const tradingToggleBtn = document.getElementById('trading-toggle-btn');
const claudeCostBanner = document.getElementById('claude-cost-banner');

const experimentToggleStatus = document.getElementById('experiment-toggle-status');
const experimentToggleBtn = document.getElementById('experiment-toggle-btn');
const experimentUpdated = document.getElementById('experiment-updated');
const refreshExperimentBtn = document.getElementById('refresh-experiment');
const experimentSummaryTableBody = document.querySelector('#experiment-summary-table tbody');
const experimentCostDiv = document.getElementById('experiment-cost');
const experimentDisagreementsTableBody = document.querySelector('#experiment-disagreements-table tbody');
let claudeExperimentEnabled = false;

const sidebarHealth = document.getElementById('sidebar-health');
const sidebarAccount = document.getElementById('sidebar-account');
const sidebarPositions = document.getElementById('sidebar-positions');

const riskPresetSelect = document.getElementById('risk-preset');
const riskPositionSizeInput = document.getElementById('risk-position-size');
const riskMaxPositionsInput = document.getElementById('risk-max-positions');
const claudeModelSelect = document.getElementById('claude-model');
const saveSettingsBtn = document.getElementById('save-settings');
const settingsResult = document.getElementById('settings-result');
const settingsUpdated = document.getElementById('settings-updated');

const backtestingPeriod = document.getElementById('backtesting-period');
const backtestingPortfolio = document.getElementById('backtesting-portfolio');
const conditionsTableBody = document.querySelector('#conditions-table tbody');
const conditionsTableNote = document.getElementById('conditions-table-note');
const runBacktestBtn = document.getElementById('run-backtest');
const backtestingResult = document.getElementById('backtesting-result');
const backtestGroupFilter = document.getElementById('backtest-group-filter');

const resumenTableBody = document.querySelector('#resumen-table tbody');
const resumenCount = document.getElementById('resumen-count');
const filterEstado = document.getElementById('f-estado');
const filterTipo = document.getElementById('f-tipo');
const filterSenal = document.getElementById('f-senal');
const filterSearch = document.getElementById('f-search');

const detailContent = document.getElementById('detail-content');

const positionsTableBody = document.querySelector('#positions-table tbody');
const ordersTableBody = document.querySelector('#orders-table tbody');
const pendingOrdersTableBody = document.querySelector('#pending-orders-table tbody');
const runTradeBtn = document.getElementById('run-trade');
const tradeResult = document.getElementById('trade-result');
const opsSyncBtn = document.getElementById('ops-sync-btn');
const opsAccountPills = document.getElementById('ops-account-pills');
const opsBanner = document.getElementById('ops-banner');
const opsAlerts = document.getElementById('ops-alerts');
const staleCleanupToggleStatus = document.getElementById('stale-cleanup-toggle-status');
const staleCleanupToggleBtn = document.getElementById('stale-cleanup-toggle-btn');
const staleCleanupTimeoutSpan = document.getElementById('stale-cleanup-timeout');
let autoCancelStaleOrders = false;

const snapshotsTableBody = document.querySelector('#snapshots-table tbody');
const refreshSnapshotsBtn = document.getElementById('refresh-snapshots');
const snapshotsUpdated = document.getElementById('snapshots-updated');

const chartInstances = {};
let tradingEnabled = true;

// Refleja TIER1_SYMBOLS de strategy/hybridConfig.ts — señal "main" calculada sobre velas 1H.
const HYBRID_TIER1_SYMBOLS = ['SPY', 'XLU'];

// Estado central de la pestaña Resumen/Detalle (Fase 2 - UI con tabs).
const state = {
  classifications: {},
  mainSignals: [],
  hybridSignals: [],
  assessmentsBySymbol: new Map(),
  backtestSummaryBySymbol: new Map(),
  positionsBySymbol: new Map(),
  positions: [],
  selectedSymbol: null,
  filters: { estado: 'todos', tipo: 'todos', senal: 'todos', search: '' },
  chartToggles: { ma: true, bb: true, osc: true },
  opsAccount: 'all',
  exitPriceBySymbol: new Map(),
  experimentBySymbol: {},
  experimentVariantSelection: {},
};

// ── Tabs ──
function activateTab(tabKey) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabKey));
  document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${tabKey}`));
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
});

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
  renderSidebarHealth(data);
}

function renderSidebarHealth(data) {
  const total = data.checks.length;
  const failing = data.checks.filter((check) => !check.ok).map((check) => check.name);
  const okCount = total - failing.length;

  sidebarHealth.innerHTML = failing.length === 0
    ? `<span class="pl-positive">✅ ${okCount}/${total} OK</span>`
    : `<span class="pl-negative">⚠️ ${okCount}/${total} OK</span><br><span class="muted">Fallan: ${failing.join(', ')}</span>`;

  statusBadge.textContent = failing.length === 0 ? '✅ Todo OK' : `⚠️ ${failing.length} con error`;
  statusBadge.classList.toggle('tag-ok', failing.length === 0);
  statusBadge.classList.toggle('tag-error', failing.length > 0);
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

// ── Experimento de sesgo de Claude (Tarea 4) ──

function renderExperimentToggle(enabled) {
  claudeExperimentEnabled = enabled;
  experimentToggleStatus.textContent = enabled
    ? 'Experimento (B/C/D): ACTIVADO'
    : 'Experimento (B/C/D): apagado (solo variante A, sin costo extra)';
  experimentToggleStatus.classList.toggle('toggle-on', enabled);
  experimentToggleStatus.classList.toggle('toggle-off', !enabled);
  experimentToggleBtn.textContent = enabled ? '⏸ Apagar' : '▶ Encender';
  experimentToggleBtn.disabled = false;
}

async function toggleClaudeExperiment() {
  const next = !claudeExperimentEnabled;
  const confirmMessage = next
    ? 'Esto activa las variantes B/C/D del experimento: por cada símbolo con señal BUY técnica se hacen 3 llamadas extra a Claude (costo real, ver sección Experimentos). ¿Continuar?'
    : 'Esto apaga las variantes B/C/D - solo sigue corriendo la variante A (control, sin costo extra). ¿Continuar?';

  if (!window.confirm(confirmMessage)) return;

  experimentToggleBtn.disabled = true;
  try {
    const res = await fetch('/api/settings/claude-experiment-enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    const data = await res.json();
    if (data.ok) {
      renderExperimentToggle(data.claudeExperimentEnabled);
    } else {
      experimentToggleBtn.disabled = false;
      window.alert(`Error: ${data.error}`);
    }
  } catch (error) {
    experimentToggleBtn.disabled = false;
    window.alert(`Error: ${error}`);
  }
}

function fmtPct(value) {
  return value === null || value === undefined ? '—' : `${Number(value).toFixed(1)}%`;
}

function renderExperimentSummaryTable(summary) {
  experimentSummaryTableBody.innerHTML = '';
  if (summary.length === 0) {
    experimentSummaryTableBody.innerHTML = '<tr><td colspan="7" class="muted">Sin evaluaciones todavía (necesita al menos 1 señal BUY técnica en el período).</td></tr>';
    return;
  }
  summary.forEach((row) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${row.variant}</strong></td>
      <td>${row.evaluations}</td>
      <td>${fmtPct(row.buyRatePct)}</td>
      <td>${fmtPct(row.holdRatePct)}</td>
      <td>${fmtPct(row.avoidRatePct)}</td>
      <td>${row.avgScore !== null ? fmtNum(row.avgScore) : '—'}</td>
      <td>${row.avgConfidence !== null ? fmtNum(row.avgConfidence) : '—'}</td>
    `;
    experimentSummaryTableBody.appendChild(tr);
  });
}

function renderExperimentCost(cost) {
  if (cost.evaluations === 0) {
    experimentCostDiv.innerHTML = '<span class="muted">Sin gasto del experimento (B/C/D) en el período - flag apagado o sin señales BUY.</span>';
    return;
  }
  const byVariant = cost.byVariant.map((v) => `${v.variant}: $${v.costUsd.toFixed(4)} (${v.evaluations} eval.)`).join(' · ');
  experimentCostDiv.innerHTML = `<strong>$${cost.totalCostUsd.toFixed(4)}</strong> total · ${cost.totalTokens} tokens · ${byVariant}`;
}

function renderExperimentDisagreements(disagreements) {
  experimentDisagreementsTableBody.innerHTML = '';
  if (disagreements.length === 0) {
    experimentDisagreementsTableBody.innerHTML = '<tr><td colspan="4" class="muted">Sin desacuerdos A vs B en el período (o experimento apagado).</td></tr>';
    return;
  }
  disagreements.forEach((row) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${row.symbol}</strong></td>
      <td>${new Date(row.ts).toLocaleString()}</td>
      <td><span class="${recommendationClass(row.recommendationA)}">${row.recommendationA.toUpperCase()}</span></td>
      <td><span class="${recommendationClass(row.recommendationB)}">${row.recommendationB.toUpperCase()}</span></td>
    `;
    experimentDisagreementsTableBody.appendChild(tr);
  });
}

async function loadClaudeExperiment() {
  refreshExperimentBtn.disabled = true;
  try {
    const [summaryRes, costRes, disagreementsRes] = await Promise.all([
      fetch('/api/claude-experiment/summary?days=7'),
      fetch('/api/claude-experiment/cost?days=7'),
      fetch('/api/claude-experiment/disagreements?days=7'),
    ]);
    const [summaryData, costData, disagreementsData] = await Promise.all([
      summaryRes.json(),
      costRes.json(),
      disagreementsRes.json(),
    ]);

    if (summaryData.ok) renderExperimentSummaryTable(summaryData.summary);
    if (costData.ok) renderExperimentCost(costData.cost);
    if (disagreementsData.ok) renderExperimentDisagreements(disagreementsData.disagreements);

    experimentUpdated.textContent = `Última actualización: ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    experimentSummaryTableBody.innerHTML = `<tr><td colspan="7" class="muted">Error: ${error}</td></tr>`;
  } finally {
    refreshExperimentBtn.disabled = false;
  }
}

// ── Limpieza automática de órdenes BUY huérfanas/desalineadas ──

function renderStaleCleanupToggle(enabled, timeoutMin) {
  autoCancelStaleOrders = enabled;
  if (staleCleanupTimeoutSpan) staleCleanupTimeoutSpan.textContent = timeoutMin;
  staleCleanupToggleStatus.textContent = enabled
    ? 'Limpieza automática de órdenes huérfanas/desalineadas: ACTIVADA'
    : 'Limpieza automática de órdenes huérfanas/desalineadas: apagada (solo se muestran, no se cancelan solas)';
  staleCleanupToggleStatus.classList.toggle('toggle-on', enabled);
  staleCleanupToggleStatus.classList.toggle('toggle-off', !enabled);
  staleCleanupToggleBtn.textContent = enabled ? '⏸ Apagar' : '▶ Activar';
  staleCleanupToggleBtn.disabled = false;
}

async function toggleAutoCancelStaleOrders() {
  const next = !autoCancelStaleOrders;
  const confirmMessage = next
    ? 'Esto activa la cancelación automática de órdenes BUY huérfanas/desalineadas (ver detalle arriba) - si la señal sigue siendo BUY ese ciclo, se reemplazan solas con una orden nueva al precio recalculado. ¿Continuar?'
    : 'Esto apaga la cancelación automática - las órdenes huérfanas/desalineadas solo se van a mostrar para que las cancelés manualmente. ¿Continuar?';

  if (!window.confirm(confirmMessage)) return;

  staleCleanupToggleBtn.disabled = true;
  try {
    const res = await fetch('/api/settings/auto-cancel-stale-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    const data = await res.json();
    if (data.ok) {
      renderStaleCleanupToggle(data.autoCancelStaleOrders, Number(staleCleanupTimeoutSpan?.textContent) || 60);
    } else {
      staleCleanupToggleBtn.disabled = false;
      window.alert(`Error: ${data.error}`);
    }
  } catch (error) {
    staleCleanupToggleBtn.disabled = false;
    window.alert(`Error: ${error}`);
  }
}

// ── Visibilidad de costo de Claude (Tarea 5) ──

async function loadClaudeUsageBanner() {
  try {
    const res = await fetch('/api/claude-usage?days=1');
    const data = await res.json();
    if (!data.ok) {
      claudeCostBanner.textContent = 'Claude hoy: error';
      return;
    }
    const today = data.today;
    claudeCostBanner.textContent = today
      ? `Claude hoy: $${today.totalCostUsd.toFixed(2)} · ${today.callsCount} llamada${today.callsCount === 1 ? '' : 's'}`
      : 'Claude hoy: $0.00 · 0 llamadas';
  } catch (error) {
    claudeCostBanner.textContent = `Claude hoy: error (${error})`;
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
    renderExperimentToggle(data.settings.claudeExperimentEnabled);
    renderStaleCleanupToggle(data.settings.autoCancelStaleOrders, data.settings.pendingOrderTimeoutMin);

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
 * Parsea el formato unificado de `ai_assessments.recommendation` (Tarea 2, 2026-06-21):
 * '<buy|hold|avoid>-<fresh|stale>' o el literal 'not-evaluated'. Devuelve `null` para
 * 'not-evaluated' (o cualquier valor inesperado) - el caller debe tratarlo como "sin evaluación".
 */
function parseAiRecommendation(raw) {
  if (!raw) return null;
  const match = /^(buy|hold|avoid)-(fresh|stale)$/.exec(raw);
  return match ? { rec: match[1], state: match[2] } : null;
}

/** Texto relativo corto ("hace 5min", "hace 2h") para el timestamp de una evaluación de IA. */
function relativeTimeShort(ts) {
  if (!ts) return '';
  const minutes = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (minutes < 1) return 'recién';
  if (minutes < 60) return `hace ${minutes}min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours}h`;
  return `hace ${Math.round(hours / 24)}d`;
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

  const parsed = parseAiRecommendation(assessment.recommendation);
  if (!parsed) {
    return '<p class="muted">No consultado este ciclo (sin señal BUY técnica, o símbolo bloqueado manualmente).</p>';
  }

  const staleLabel = parsed.state === 'stale' ? ' <span class="ai-stale-label">(obsoleta - la señal técnica cambió)</span>' : '';

  return `
    <p>
      <span class="${recommendationClass(parsed.rec)}">${parsed.rec.toUpperCase()}</span>${staleLabel}
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

/**
 * Color representativo por condición, usado como badge en la tabla de backtest
 * para identificar de un vistazo qué símbolos comparten la misma condición.
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
 * Overlays de gráfico por condición activa, usando los campos de `ChartPoint`
 * (`strategy/chart.ts`). `price`: líneas en el eje de precio (`y`), mismas unidades
 * que "Precio". `oscillator`: panel secundario (`y1`), con `levels` (umbrales de la
 * condición) dibujados como líneas punteadas grises.
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
 * Extrae los ids de condición conocidos (claves de `CONDITION_CHART_CONFIG`) presentes en
 * una expresión de condición (id simple o combinación AND/OR de 2-3). No necesita parsear
 * la lógica AND/OR - alcanza con tokenizar identificadores y quedarse con los que matchean
 * el catálogo; "AND"/"OR" nunca matchean ninguna clave, así que se descartan solos.
 */
function extractConditionIds(expr) {
  const tokens = String(expr ?? '').match(/[A-Za-z0-9_]+/g) ?? [];
  const seen = new Set();
  const ids = [];
  for (const tok of tokens) {
    if (CONDITION_CHART_CONFIG[tok] && !seen.has(tok)) {
      seen.add(tok);
      ids.push(tok);
    }
  }
  return ids;
}

/**
 * Combina los overlays de gráfico de TODAS las condiciones hoja presentes en la expresión
 * de compra y la de venta: los overlays de precio (`price`) se concatenan (sin duplicar por
 * `key`); el panel oscilador (`oscillator`) se toma de la primera condición (en orden compra,
 * luego venta) que defina uno.
 */
function mergeConditionChartConfig(buyConditionId, sellConditionId) {
  const ids = [...extractConditionIds(buyConditionId), ...extractConditionIds(sellConditionId)];
  const uniqueIds = [...new Set(ids)];

  const priceByKey = new Map();
  let oscillator;
  for (const id of uniqueIds) {
    const config = CONDITION_CHART_CONFIG[id] ?? {};
    (config.price ?? []).forEach((overlay) => {
      if (!priceByKey.has(overlay.key)) priceByKey.set(overlay.key, overlay);
    });
    if (!oscillator && config.oscillator) oscillator = config.oscillator;
  }

  return {
    price: Array.from(priceByKey.values()),
    oscillator,
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

    if (!canvas) return;

    if (!result.ok || !result.points || result.points.length === 0) {
      canvas.classList.add('hidden');
      if (noDataMsg) noDataMsg.classList.remove('hidden');
      return;
    }

    canvas.classList.remove('hidden');
    if (noDataMsg) noDataMsg.classList.add('hidden');

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

    // Toggle de overlays (Fase 3): "Bollinger" controla las bandas (key bb*), "Medias
    // móviles" el resto de los overlays de precio (SMA/EMA/canal Donchian).
    (chartConfig.price ?? []).forEach((overlay) => {
      const isBollinger = overlay.key.startsWith('bb');
      if (isBollinger && !state.chartToggles.bb) return;
      if (!isBollinger && !state.chartToggles.ma) return;

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

    const oscillator = state.chartToggles.osc ? chartConfig.oscillator : undefined;
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

// ── Operaciones multi-cuenta ──
const ACCOUNT_LABELS = { aptos: '✅ Aptos', observados: '🟡 Observados', bloqueados: '❌ Bloqueados' };

function accountBadge(group) {
  return `<span class="badge-account badge-account-${group}">${ACCOUNT_LABELS[group] ?? group}</span>`;
}

function selectedAccountGroups() {
  return state.opsAccount === 'all' ? ['aptos', 'observados', 'bloqueados'] : [state.opsAccount];
}

function renderOperationsBanner(accounts) {
  const groups = selectedAccountGroups();
  const rows = groups.map((g) => accounts[g]?.accountState).filter(Boolean);

  if (rows.length === 0) {
    opsBanner.innerHTML = '<span class="muted">Sin datos de cuenta todavía - hacé clic en "Sincronizar ahora".</span>';
    return;
  }

  const equity = rows.reduce((s, r) => s + Number(r.equity ?? 0), 0);
  const cash = rows.reduce((s, r) => s + Number(r.cash ?? 0), 0);
  const buyingPower = rows.reduce((s, r) => s + Number(r.buying_power ?? 0), 0);
  const lastSyncs = groups.map((g) => accounts[g]?.accountState?.last_sync_at).filter(Boolean).map((d) => new Date(d));
  const oldestSync = lastSyncs.length > 0 ? new Date(Math.min(...lastSyncs.map((d) => d.getTime()))) : null;
  const nextInSeconds = oldestSync ? Math.max(0, 60 - Math.round((Date.now() - oldestSync.getTime()) / 1000)) : null;

  opsBanner.innerHTML = `
    <span><span class="stat-label">Equity</span>${fmtMoney(equity)}</span>
    <span><span class="stat-label">Cash</span>${fmtMoney(cash)}</span>
    <span><span class="stat-label">Buying power</span>${fmtMoney(buyingPower)}</span>
    <span class="ops-sync-indicator">${oldestSync ? `Última sync: ${oldestSync.toLocaleTimeString()} · próxima en ${nextInSeconds}s` : 'Sin sincronizar todavía'}</span>
  `;
}

function renderOperationsAlerts(discrepancies, staleOrders) {
  const chips = [];
  if (discrepancies.length > 0) {
    chips.push(`<span class="alert-chip">⚠️ ${discrepancies.length} discrepancia(s) DB vs Alpaca (24h)</span>`);
  }
  if (staleOrders.length > 0) {
    chips.push(`<span class="alert-chip alert-chip-warn">🐌 ${staleOrders.length} orden(es) huérfana(s) (>${staleOrders[0]?.timeoutMin ?? ''}min pendiente)</span>`);
  }
  opsAlerts.classList.toggle('hidden', chips.length === 0);
  opsAlerts.innerHTML = chips.join('');
}

function renderOperationsPositions(accounts) {
  positionsTableBody.innerHTML = '';
  const groups = selectedAccountGroups();
  const rows = [];
  for (const g of groups) {
    for (const p of accounts[g]?.positions ?? []) rows.push({ group: g, ...p });
  }

  if (rows.length === 0) {
    positionsTableBody.innerHTML = '<tr><td colspan="9" class="muted">Sin posiciones abiertas.</td></tr>';
    return;
  }

  rows.forEach((position) => {
    const exit = state.exitPriceBySymbol.get(position.symbol);
    const exitCell = exit && exit.price !== null
      ? `<span title="${(exit.source ?? '').replace(/"/g, '&quot;')}">${fmtMoney(exit.price)}</span>`
      : `<span class="muted" title="${exit?.reason === 'no_projectable' ? 'La condición de venta activa no tiene un nivel proyectable (ej. RSI)' : exit?.reason === 'insufficient_history' ? 'Histórico insuficiente para calcular indicadores' : 'Sin calcular todavía'}">—</span>`;
    const sellDisabled = !exit || exit.price === null;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${accountBadge(position.group)}</td>
      <td>${position.symbol}</td>
      <td>${fmtNum(position.qty, 0)}</td>
      <td>${fmtMoney(position.avg_entry_price ?? position.avgEntryPrice)}</td>
      <td>${fmtMoney(position.current_price ?? position.currentPrice)}</td>
      <td>${fmtMoney(position.market_value ?? position.marketValue)}</td>
      <td class="${Number(position.unrealized_pl ?? position.unrealizedPl) >= 0 ? 'pl-positive' : 'pl-negative'}">${fmtMoney(position.unrealized_pl ?? position.unrealizedPl)}</td>
      <td>${exitCell}</td>
      <td><button class="btn-small" data-sell-symbol="${position.symbol}" ${sellDisabled ? 'disabled' : ''}>Vender al precio estimado</button></td>
    `;
    positionsTableBody.appendChild(tr);
  });
}

function renderOperationsPendingOrders(accounts, staleIds) {
  pendingOrdersTableBody.innerHTML = '';
  const groups = selectedAccountGroups();
  const rows = [];
  for (const g of groups) {
    for (const o of accounts[g]?.pendingOrders ?? []) rows.push({ group: g, ...o });
  }

  if (rows.length === 0) {
    pendingOrdersTableBody.innerHTML = '<tr><td colspan="8" class="muted">Sin órdenes pendientes.</td></tr>';
    return;
  }

  rows.forEach((order) => {
    const isStale = staleIds.has(order.alpaca_order_id);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${accountBadge(order.group)}</td>
      <td>${order.symbol}${isStale ? '<span class="badge-stale" title="Pendiente más del timeout configurado">huérfana</span>' : ''}</td>
      <td>${order.side.toUpperCase()}</td>
      <td>${fmtNum(order.qty, 0)}</td>
      <td>${order.limit_price !== null ? fmtMoney(order.limit_price) : '—'}</td>
      <td>${order.submitted_at ? new Date(order.submitted_at).toLocaleString() : '—'}</td>
      <td>${order.status}</td>
      <td><button class="btn-small" data-cancel-order="${order.alpaca_order_id}" data-cancel-group="${order.group}">Cancelar</button></td>
    `;
    pendingOrdersTableBody.appendChild(tr);
  });
}

function renderOrdersTable(accounts) {
  ordersTableBody.innerHTML = '';
  const groups = selectedAccountGroups();
  const rows = [];
  for (const g of groups) {
    for (const o of accounts[g]?.executedOrders ?? []) rows.push({ group: g, ...o });
  }

  if (rows.length === 0) {
    ordersTableBody.innerHTML = '<tr><td colspan="7" class="muted">Sin órdenes ejecutadas todavía.</td></tr>';
    return;
  }

  rows.forEach((order) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${accountBadge(order.group)}</td>
      <td>${order.submitted_at ? new Date(order.submitted_at).toLocaleString() : '—'}</td>
      <td>${order.symbol}</td>
      <td>${order.side.toUpperCase()}</td>
      <td>${fmtNum(order.qty, 0)}</td>
      <td>${order.order_type ?? '—'}</td>
      <td>${order.status}</td>
    `;
    ordersTableBody.appendChild(tr);
  });
}

async function loadOperations() {
  try {
    const accountParam = state.opsAccount;
    const [opsRes, discRes, staleRes] = await Promise.all([
      fetch(`/api/operations?account=${accountParam}`),
      fetch(`/api/sync-discrepancies?account=${accountParam}`),
      fetch(`/api/orders/stale?account=${accountParam}`),
    ]);
    const opsData = await opsRes.json();
    const discData = await discRes.json();
    const staleData = await staleRes.json();

    if (!opsData.ok) {
      opsBanner.innerHTML = `<span class="muted">Error: ${opsData.error}</span>`;
      return;
    }

    const accounts = opsData.accounts;
    const staleOrders = staleData.ok ? staleData.orders.map((o) => ({ ...o, timeoutMin: staleData.timeoutMin })) : [];
    const staleIds = new Set(staleOrders.map((o) => o.alpaca_order_id));

    renderOperationsBanner(accounts);
    renderOperationsAlerts(discData.ok ? discData.discrepancies : [], staleOrders);
    renderOperationsPendingOrders(accounts, staleIds);
    renderOrdersTable(accounts);

    // Precio estimado de salida: una sola vez por símbolo con posición abierta en el alcance actual.
    const symbolsWithPosition = [...new Set(selectedAccountGroups().flatMap((g) => (accounts[g]?.positions ?? []).map((p) => p.symbol)))];
    await Promise.all(symbolsWithPosition.map(async (symbol) => {
      try {
        const res = await fetch(`/api/positions/${symbol}/exit-price`);
        const data = await res.json();
        if (data.ok) state.exitPriceBySymbol.set(symbol, data);
      } catch { /* best-effort */ }
    }));

    renderOperationsPositions(accounts);
  } catch (error) {
    opsBanner.innerHTML = `<span class="muted">Error: ${error}</span>`;
  }
}

async function syncOperations() {
  opsSyncBtn.disabled = true;
  opsSyncBtn.textContent = '🔄 Sincronizando...';
  try {
    await fetch('/api/operations/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: state.opsAccount }),
    });
    await loadOperations();
  } catch (error) {
    opsBanner.innerHTML = `<span class="muted">Error al sincronizar: ${error}</span>`;
  } finally {
    opsSyncBtn.disabled = false;
    opsSyncBtn.textContent = '🔄 Sincronizar ahora';
  }
}

async function cancelPendingOrder(orderId, group) {
  if (!window.confirm(`¿Cancelar la orden pendiente ${orderId} (cuenta ${group})?`)) return;
  try {
    const res = await fetch(`/api/orders/${orderId}/cancel?account=${group}`, { method: 'POST' });
    const data = await res.json();
    if (!data.ok) window.alert(`Error: ${data.error}`);
  } catch (error) {
    window.alert(`Error: ${error}`);
  } finally {
    await loadOperations();
  }
}

async function sellAtEstimate(symbol) {
  const exit = state.exitPriceBySymbol.get(symbol);
  if (!exit || exit.price === null) return;
  if (!window.confirm(`¿Vender ${symbol} (cuenta ${exit.accountGroup}) a precio límite ${fmtMoney(exit.price)}?`)) return;

  try {
    const res = await fetch(`/api/positions/${symbol}/sell-at-estimate`, { method: 'POST' });
    const data = await res.json();
    if (!data.ok) window.alert(`Error: ${data.error}`);
  } catch (error) {
    window.alert(`Error: ${error}`);
  } finally {
    await loadOperations();
  }
}

opsAccountPills.addEventListener('click', (event) => {
  const btn = event.target.closest('.account-pill');
  if (!btn) return;
  state.opsAccount = btn.dataset.account;
  opsAccountPills.querySelectorAll('.account-pill').forEach((p) => p.classList.toggle('active', p === btn));
  loadOperations();
});

positionsTableBody.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-sell-symbol]');
  if (btn) sellAtEstimate(btn.dataset.sellSymbol);
});

pendingOrdersTableBody.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-cancel-order]');
  if (btn) cancelPendingOrder(btn.dataset.cancelOrder, btn.dataset.cancelGroup);
});

opsSyncBtn.addEventListener('click', syncOperations);

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

/**
 * Forma corta para una condición o expresión de condición (puede ser un id simple
 * o una combinación de 2-3 con AND/OR). Para expresiones compuestas, sustituye cada
 * id hoja conocido por su forma corta y conserva AND/OR/&/|/paréntesis tal cual, para
 * no volcar la expresión cruda completa (puede tener 60+ caracteres) en un badge angosto.
 */
function condShort(id) {
  if (!id) return id;
  if (COND_SHORT[id] !== undefined) return COND_SHORT[id];
  let short = id;
  for (const [key, value] of Object.entries(COND_SHORT)) {
    short = short.split(key).join(value);
  }
  return short;
}

// Clases CSS para la recomendación de Claude (paralelo a signalClass para la señal técnica).
function aiRecClass(rec) {
  if (rec === 'buy')   return 'signal-buy';
  if (rec === 'avoid') return 'signal-sell';
  return 'signal-hold';
}

const CONDITIONS_TABLE_COLUMNS = [
  { key: 'symbol', type: 'string', getValue: (c) => c.symbol },
  { key: 'group', type: 'string', getValue: (c) => STATUS_TO_BACKTEST_GROUP[state.classifications[c.symbol] ?? 'apto'] },
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

const RESUMEN_TABLE_COLUMNS = [
  { key: 'symbol', type: 'string', getValue: (r) => r.symbol },
  { key: 'type', type: 'string', getValue: (r) => r.type },
  { key: 'estado', type: 'string', getValue: (r) => r.classification },
  { key: 'signal', type: 'string', getValue: (r) => r.signal },
  { key: 'aiRec', type: 'string', getValue: (r) => r.aiRecommendation ?? '' },
  { key: 'entryPrice', type: 'number', getValue: (r) => r.estimatedEntryPrice ?? null },
  { key: 'conditions', type: 'string', getValue: (r) => (r.buyConditionId ?? '') + '→' + (r.sellConditionId ?? '') },
];

const conditionsSortState = { key: null, direction: 'asc' };
const resumenSortState = { key: 'symbol', direction: 'asc' };

let latestConditions = [];
let lastBacktestingRun = null;

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

// ── Clasificación manual por símbolo (apto/observar/bloqueado) ──

function renderStatusSelect(symbol, status) {
  const opt = (value, label) => `<option value="${value}" ${status === value ? 'selected' : ''}>${label}</option>`;
  return `<select class="status-select status-${status}" data-symbol="${symbol}">`
    + opt('apto', '✅ Apto') + opt('observar', '🟡 Observar') + opt('bloqueado', '❌ Bloqueado')
    + `</select>`;
}

async function updateClassification(symbol, status, selectEl) {
  const previous = state.classifications[symbol] ?? 'apto';
  if (selectEl) selectEl.disabled = true;
  try {
    const res = await fetch(`/api/symbol-classifications/${symbol}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const data = await res.json();
    if (!data.ok) {
      window.alert(`Error: ${data.error}`);
      if (selectEl) selectEl.value = previous;
      return;
    }
    state.classifications[symbol] = status;
    renderResumenTable();
    if (state.selectedSymbol === symbol) renderDetail();
  } catch (error) {
    window.alert(`Error: ${error}`);
    if (selectEl) selectEl.value = previous;
  } finally {
    if (selectEl) selectEl.disabled = false;
  }
}

async function loadClassifications() {
  try {
    const res = await fetch('/api/symbol-classifications');
    const data = await res.json();
    state.classifications = data;
    renderResumenTable();
    if (state.selectedSymbol) renderDetail();
  } catch (error) {
    console.error('Error al cargar clasificaciones:', error);
  }
}

// ── Pestaña Resumen ──

function getResumenRows() {
  return state.mainSignals.map((signal) => ({
    ...signal,
    classification: state.classifications[signal.symbol] ?? 'apto',
  }));
}

function applyResumenFilters(rows) {
  const { estado, tipo, senal, search } = state.filters;
  const query = search.trim().toUpperCase();

  return rows.filter((row) => {
    if (estado !== 'todos' && row.classification !== estado) return false;
    if (tipo !== 'todos' && row.type !== tipo) return false;
    if (senal !== 'todos' && row.signal !== senal) return false;
    if (query && !row.symbol.includes(query)) return false;
    return true;
  });
}

/**
 * Celda "IA" de la tab Resumen: por defecto muestra la variante 'A' (producción, con su estado
 * fresh/stale/not-evaluated). Si el símbolo tuvo alguna vez variantes B/C/D (experimento activo
 * en algún ciclo pasado), agrega un dropdown para ver qué hubiera recomendado cada una - sin
 * tener que ir a la sección "Experimentos" de Sistema. La selección por símbolo se guarda en
 * `state.experimentVariantSelection` para sobrevivir el refresco automático de la tabla (60s).
 */
function renderAiCell(row) {
  const exp = state.experimentBySymbol[row.symbol];
  const availableVariants = exp ? Object.keys(exp.variants) : [];
  const hasExperimentVariants = availableVariants.length > 1;

  const storedSelection = state.experimentVariantSelection[row.symbol];
  const selectedVariant = availableVariants.includes(storedSelection) ? storedSelection : 'A';

  let badge;
  if (selectedVariant !== 'A' && exp?.variants[selectedVariant]) {
    const v = exp.variants[selectedVariant];
    const conf = v.confidence != null ? ` ${Math.round(v.confidence * 100)}%` : '';
    badge = `<span class="${aiRecClass(v.recommendation)}" title="${v.rationale ?? ''}">${v.recommendation}${conf}</span>`;
  } else {
    const parsedAi = parseAiRecommendation(row.aiRecommendation);
    if (!parsedAi) {
      badge = '<span class="muted" title="Sin señal BUY técnica este ciclo, o símbolo bloqueado">— no consultado</span>';
    } else {
      const conf = row.aiConfidence != null ? ` ${Math.round(row.aiConfidence * 100)}%` : '';
      badge = parsedAi.state === 'stale'
        ? `<span class="ai-stale" title="${row.aiRationale ?? ''} (obsoleta: la señal técnica cambió desde la última evaluación)">${parsedAi.rec}${conf} · obsoleta</span>`
        : `<span class="${aiRecClass(parsedAi.rec)}" title="${row.aiRationale ?? ''}">${parsedAi.rec}${conf} · ${relativeTimeShort(row.aiTs)}</span>`;
    }
  }

  if (!hasExperimentVariants) return badge;

  const options = availableVariants
    .map((v) => `<option value="${v}" ${v === selectedVariant ? 'selected' : ''}>${v}</option>`)
    .join('');
  const dropdown = `<select class="ai-variant-select" data-symbol="${row.symbol}" title="Ver qué hubiera recomendado cada variante del experimento (A=control, B=sin señal técnica, C=solo señal técnica, D=orden invertido)">${options}</select>`;
  return `${badge} ${dropdown}`;
}

function renderResumenTable() {
  const allRows = getResumenRows();
  const filtered = applyResumenFilters(allRows);
  const sorted = sortRows(filtered, RESUMEN_TABLE_COLUMNS, resumenSortState);

  resumenCount.textContent = `${sorted.length} de ${allRows.length} símbolos`;
  resumenTableBody.innerHTML = '';

  if (sorted.length === 0) {
    const hasActiveFilters = Object.values(state.filters).some((value) => value && value !== 'todos');
    resumenTableBody.innerHTML = hasActiveFilters
      ? '<tr><td colspan="7" class="muted">Sin símbolos para los filtros aplicados. <a href="#" id="clear-filters-link">Limpiar filtros</a></td></tr>'
      : '<tr><td colspan="7" class="muted">Sin señales todavía. Ejecutá la ingesta y un ciclo de trading.</td></tr>';
  } else {
    sorted.forEach((row) => {
      const tr = document.createElement('tr');
      tr.className = `row-${row.classification} clickable-row`;
      tr.dataset.symbol = row.symbol;

      const buyShort = condShort(row.buyConditionId);
      const sellShort = condShort(row.sellConditionId);
      const condCell = row.buyConditionId === row.sellConditionId
        ? `<span class="cond-badge" title="${row.buyConditionLabel ?? ''}">${buyShort}</span>`
        : `<span class="cond-badge" title="Compra: ${row.buyConditionLabel ?? ''}">${buyShort}</span>`
          + `<span class="cond-arrow">→</span>`
          + `<span class="cond-badge" title="Venta: ${row.sellConditionLabel ?? ''}">${sellShort}</span>`;

      const aiCell = renderAiCell(row);

      const entry = row.estimatedEntryPrice != null ? fmtMoney(row.estimatedEntryPrice) : '—';

      tr.innerHTML = `
        <td><strong>${row.symbol}</strong></td>
        <td class="muted">${row.type === 'ETF' ? 'ETF' : 'Acción'}</td>
        <td>${renderStatusSelect(row.symbol, row.classification)}</td>
        <td><span class="${signalClass(row.signal)}">${row.signal}</span></td>
        <td class="ai-rec-cell">${aiCell}</td>
        <td class="price-cell">${entry}</td>
        <td class="cond-cell">${condCell}</td>
      `;
      resumenTableBody.appendChild(tr);
    });
  }

  updateSortIndicators('resumen-table', resumenSortState);

  const clearFiltersLink = document.getElementById('clear-filters-link');
  if (clearFiltersLink) {
    clearFiltersLink.addEventListener('click', (event) => {
      event.preventDefault();
      state.filters = { estado: 'todos', tipo: 'todos', senal: 'todos', search: '' };
      filterEstado.value = 'todos';
      filterTipo.value = 'todos';
      filterSenal.value = 'todos';
      filterSearch.value = '';
      renderResumenTable();
    });
  }
}

resumenTableBody.addEventListener('change', (event) => {
  const statusSelect = event.target.closest('select.status-select');
  if (statusSelect) {
    updateClassification(statusSelect.dataset.symbol, statusSelect.value, statusSelect);
    return;
  }

  const variantSelect = event.target.closest('select.ai-variant-select');
  if (variantSelect) {
    state.experimentVariantSelection[variantSelect.dataset.symbol] = variantSelect.value;
    renderResumenTable();
  }
});

resumenTableBody.addEventListener('click', (event) => {
  if (event.target.closest('select')) return;
  const tr = event.target.closest('tr[data-symbol]');
  if (!tr) return;
  openDetail(tr.dataset.symbol);
});

filterEstado.addEventListener('change', () => { state.filters.estado = filterEstado.value; renderResumenTable(); });
filterTipo.addEventListener('change', () => { state.filters.tipo = filterTipo.value; renderResumenTable(); });
filterSenal.addEventListener('change', () => { state.filters.senal = filterSenal.value; renderResumenTable(); });
filterSearch.addEventListener('input', () => { state.filters.search = filterSearch.value; renderResumenTable(); });

// ── Pestaña Detalle ──

function openDetail(symbol) {
  if (state.selectedSymbol && state.selectedSymbol !== symbol && chartInstances[state.selectedSymbol]) {
    chartInstances[state.selectedSymbol].destroy();
    delete chartInstances[state.selectedSymbol];
  }
  state.selectedSymbol = symbol;
  activateTab('detalle');
  renderDetail();
}

function renderDetail() {
  const symbol = state.selectedSymbol;
  if (!symbol) {
    detailContent.innerHTML = '<div class="empty-state">Hacé clic en una fila de "Resumen" para ver el detalle de un símbolo.</div>';
    return;
  }

  const signal = state.mainSignals.find((s) => s.symbol === symbol);
  if (!signal) {
    detailContent.innerHTML = `<div class="empty-state">Sin datos para ${symbol} todavía.</div>`;
    return;
  }

  const classification = state.classifications[symbol] ?? 'apto';
  const assessment = state.assessmentsBySymbol.get(symbol);
  const backtestSummary = state.backtestSummaryBySymbol.get(symbol);
  const position = state.positionsBySymbol.get(symbol);
  const hybrid = state.hybridSignals.find((h) => h.symbol === symbol);

  detailContent.innerHTML = `
    <div class="symbol-report-card detail-card">
      <div class="symbol-report-header">
        <h4>${symbol} <span class="muted" style="font-size:0.8em">${signal.type === 'ETF' ? 'ETF' : 'Acción'} · ${signal.systemLabel ?? '1D'}</span></h4>
        <div class="detail-header-actions">
          <span class="signal-badge ${signalClass(signal.signal)}">${signal.signal}</span>
          ${renderStatusSelect(symbol, classification)}
        </div>
      </div>
      <div class="symbol-stats-grid">${renderSymbolStats(signal)}</div>
      <p class="muted symbol-reason">Motivo: ${signal.reason}</p>
      <div class="symbol-position">${signal.positionLine ?? renderPositionLine(position)}</div>
      <div class="chart-toggles">
        <label><input type="checkbox" id="toggle-ma" ${state.chartToggles.ma ? 'checked' : ''}> Medias móviles</label>
        <label><input type="checkbox" id="toggle-bb" ${state.chartToggles.bb ? 'checked' : ''}> Bollinger</label>
        <label><input type="checkbox" id="toggle-osc" ${state.chartToggles.osc ? 'checked' : ''}> Oscilador</label>
      </div>
      <div class="chart-canvas-wrap detail-chart-canvas-wrap"><canvas id="detail-chart-canvas"></canvas></div>
      <p class="muted chart-no-data hidden" id="detail-chart-empty">Sin datos históricos todavía. Ejecutá la ingesta.</p>
      <div class="symbol-subsection">
        <h5>Evaluación de IA (Claude)</h5>
        <div class="symbol-assessment">${renderAssessmentBlock(assessment)}</div>
      </div>
      <div class="symbol-subsection">
        <h5>Backtest</h5>
        <div class="symbol-backtest">${renderBacktestBlock(backtestSummary)}</div>
      </div>
      ${hybrid ? `
      <div class="symbol-subsection">
        <h5>Sistema ${hybrid.system === 'shadow' ? 'sombra' : 'paralelo'} (1H)</h5>
        <p class="muted">Señal: <span class="${signalClass(hybrid.signal)}">${hybrid.signal}</span> · ${hybrid.reason ?? ''}</p>
      </div>` : ''}
    </div>
  `;

  detailContent.querySelector('select.status-select').addEventListener('change', (event) => {
    updateClassification(symbol, event.target.value, event.target);
  });

  const redrawChart = () => renderSymbolCharts([{
    signal,
    cardKey: symbol,
    canvas: document.getElementById('detail-chart-canvas'),
    noDataMsg: document.getElementById('detail-chart-empty'),
  }]);

  [['toggle-ma', 'ma'], ['toggle-bb', 'bb'], ['toggle-osc', 'osc']].forEach(([id, key]) => {
    document.getElementById(id).addEventListener('change', (event) => {
      state.chartToggles[key] = event.target.checked;
      redrawChart();
    });
  });

  redrawChart();
}

// ── Sidebar (cuenta / posiciones) ──

function renderSidebarAccount(account, openOrdersCount) {
  if (!account) {
    sidebarAccount.textContent = 'Sin datos.';
    return;
  }
  const openOrdersText = typeof openOrdersCount === 'number' ? `<br>Órdenes abiertas: ${openOrdersCount}` : '';
  sidebarAccount.innerHTML =
    `Equity: ${fmtMoney(account.equity)}<br>Cash: ${fmtMoney(account.cash)}<br>` +
    `Buying power: ${fmtMoney(account.buyingPower)}${openOrdersText}`;
}

function renderSidebarPositions(positions) {
  sidebarPositions.innerHTML = positions.length === 0
    ? 'Sin posiciones abiertas.'
    : `<strong>${positions.length}</strong> posiciones abiertas`;
}

// Mapea el value del selector de grupo (Backtest) al status de symbol_classifications.
const BACKTEST_GROUP_TO_STATUS = { aptos: 'apto', observados: 'observar', bloqueados: 'bloqueado' };
const STATUS_TO_BACKTEST_GROUP = { apto: 'aptos', observar: 'observados', bloqueado: 'bloqueados' };

function getConditionsRowsForGroup() {
  const group = backtestGroupFilter.value;
  if (group === 'all') return latestConditions;
  const status = BACKTEST_GROUP_TO_STATUS[group];
  return latestConditions.filter((c) => (state.classifications[c.symbol] ?? 'apto') === status);
}

function renderConditionsTable() {
  conditionsTableBody.innerHTML = '';
  const rows = getConditionsRowsForGroup();
  if (rows.length === 0) {
    conditionsTableBody.innerHTML = '<tr><td colspan="12" class="muted">Sin datos todavía. Ejecutá un backtest.</td></tr>';
  } else {
    const sorted = sortRows(rows, CONDITIONS_TABLE_COLUMNS, conditionsSortState);
    sorted.forEach((c) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${c.symbol}</td>
        <td>${accountBadge(STATUS_TO_BACKTEST_GROUP[state.classifications[c.symbol] ?? 'apto'])}</td>
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

/**
 * Aplica el grupo seleccionado en el selector de Backtest: 'all' reusa el último run
 * legacy/general ya cargado por loadSymbolReports (sin refetch); un grupo específico
 * pide su propio último run segmentado a GET /api/backtest/results?group=. En ambos
 * casos también refiltra #conditions-table (client-side, por symbol_classifications).
 */
async function loadBacktestGroupView() {
  const group = backtestGroupFilter.value;

  if (group === 'all') {
    renderBacktestingSummary(lastBacktestingRun);
  } else {
    try {
      const res = await fetch(`/api/backtest/results?group=${group}`);
      const data = await res.json();
      renderBacktestingSummary(data.ok ? data.run : null);
    } catch (error) {
      backtestingPeriod.textContent = `Error al cargar el backtest del grupo: ${error}`;
    }
  }

  renderConditionsTable();
}

backtestGroupFilter.addEventListener('change', loadBacktestGroupView);

async function loadSymbolReports() {
  try {
    const [statusRes, assessmentsRes, backtestingRes, conditionsRes, experimentLatestRes] = await Promise.all([
      fetch('/api/trading/status'),
      fetch('/api/assessments'),
      fetch('/api/backtesting/results'),
      fetch('/api/conditions'),
      fetch('/api/claude-experiment/latest'),
    ]);

    const statusData = await statusRes.json();
    if (!statusData.ok) {
      sidebarAccount.textContent = `Error: ${statusData.error}`;
      return;
    }

    const assessmentsData = await assessmentsRes.json();
    const backtestingData = await backtestingRes.json();
    const conditionsData = await conditionsRes.json();
    const experimentLatestData = await experimentLatestRes.json();
    state.experimentBySymbol = experimentLatestData.ok ? experimentLatestData.bySymbol : {};

    const { account, positions, signals, hybridSignals, parallelPositions, openOrdersCount } = statusData;

    renderSidebarAccount(account, openOrdersCount);
    renderSidebarPositions(positions);

    const assessmentsBySymbol = new Map(
      (assessmentsData.ok ? assessmentsData.assessments : []).map((a) => [a.symbol, a])
    );
    const positionsBySymbol = new Map(positions.map((p) => [p.symbol, p]));

    const run = backtestingData.ok ? backtestingData.run : null;
    lastBacktestingRun = run;
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
        aiTs:               assessment?.ts ?? null,
      };
      if (HYBRID_TIER1_SYMBOLS.includes(signal.symbol)) {
        return { ...signal, systemLabel: '1H', chartQuery: '?tf=1H', ...aiFields };
      }
      return { ...signal, systemLabel: '1D', ...aiFields };
    });

    // Decorar señales híbridas 1H (tier 2 / shadow) con systemLabel y tipo heredado.
    const decoratedHybridSignals = (hybridSignals ?? []).map((signal) => {
      const systemLabel = signal.system === 'shadow' ? '1H · Sombra' : '1H · Paralelo';
      const mainSignal = signals.find((s) => s.symbol === signal.symbol);
      return { ...signal, systemLabel, type: mainSignal?.type ?? 'STOCK' };
    });

    state.mainSignals = decoratedSignals;
    state.hybridSignals = decoratedHybridSignals;
    state.assessmentsBySymbol = assessmentsBySymbol;
    state.backtestSummaryBySymbol = backtestSummaryBySymbol;
    state.positionsBySymbol = positionsBySymbol;
    state.positions = positions;

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

    renderResumenTable();
    await loadBacktestGroupView();
    if (state.selectedSymbol) renderDetail();

    await loadOperations();
  } catch (error) {
    sidebarAccount.textContent = `Error: ${error}`;
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
  const group = backtestGroupFilter.value;
  runBacktestBtn.disabled = true;
  backtestingResult.textContent = group === 'all'
    ? 'Ejecutando backtest (aptos, observados, bloqueados)...'
    : `Ejecutando backtest (grupo: ${group})...`;
  try {
    const res = await fetch('/api/backtest/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group }),
    });
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
experimentToggleBtn.addEventListener('click', toggleClaudeExperiment);
refreshExperimentBtn.addEventListener('click', loadClaudeExperiment);
staleCleanupToggleBtn.addEventListener('click', toggleAutoCancelStaleOrders);

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

setupSortableTable('resumen-table', resumenSortState, renderResumenTable);
setupSortableTable('conditions-table', conditionsSortState, renderConditionsTable);

loadHealth();
loadSettings();
loadClassifications();
loadSymbolReports();
loadSnapshots();
loadClaudeUsageBanner();
loadClaudeExperiment();
setInterval(loadHealth, 60000);
setInterval(loadSymbolReports, 60000);
setInterval(loadClaudeUsageBanner, 60000);
setInterval(loadClaudeExperiment, 60000);
setInterval(loadClassifications, 60000);
