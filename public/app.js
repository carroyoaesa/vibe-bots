const healthGrid = document.getElementById('health-grid');
const healthUpdated = document.getElementById('health-updated');
const refreshHealthBtn = document.getElementById('refresh-health');
const runIngestBtn = document.getElementById('run-ingest');
const ingestResult = document.getElementById('ingest-result');
const grafanaContainer = document.getElementById('grafana-container');

const tradingAccount = document.getElementById('trading-account');
const signalsTableBody = document.querySelector('#signals-table tbody');
const positionsTableBody = document.querySelector('#positions-table tbody');
const ordersTableBody = document.querySelector('#orders-table tbody');
const runTradeBtn = document.getElementById('run-trade');
const tradeResult = document.getElementById('trade-result');

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
    }
  } catch (error) {
    ingestResult.textContent = `Error: ${error}`;
  } finally {
    runIngestBtn.disabled = false;
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

function renderTradingStatus(data) {
  const { account, positions, signals, orders } = data;

  tradingAccount.textContent =
    `Cuenta ${account.accountNumber} (${account.status}) · Equity: ${fmtMoney(account.equity)} · ` +
    `Cash: ${fmtMoney(account.cash)} · Buying power: ${fmtMoney(account.buyingPower)}`;

  signalsTableBody.innerHTML = '';
  if (signals.length === 0) {
    signalsTableBody.innerHTML = '<tr><td colspan="8" class="muted">Sin señales todavía. Ejecutá un ciclo de trading.</td></tr>';
  } else {
    signals.forEach((signal) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${signal.symbol}</td>
        <td>${fmtMoney(signal.price)}</td>
        <td>${fmtNum(signal.smaFast)}</td>
        <td>${fmtNum(signal.smaSlow)}</td>
        <td>${fmtNum(signal.rsi)}</td>
        <td>${signal.momentum !== null ? `${fmtNum(signal.momentum)}%` : '—'}</td>
        <td><span class="${signalClass(signal.signal)}">${signal.signal}</span></td>
        <td class="muted">${signal.reason}</td>
      `;
      signalsTableBody.appendChild(tr);
    });
  }

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
    }
  } catch (error) {
    tradeResult.textContent = `Error: ${error}`;
  } finally {
    runTradeBtn.disabled = false;
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

loadHealth();
loadGrafana();
loadTradingStatus();
setInterval(loadHealth, 60000);
setInterval(loadTradingStatus, 60000);
