/**
 * Indicadores técnicos básicos sobre series de precios de cierre (orden ascendente por fecha).
 * Devuelven `null` cuando no hay suficiente historial para calcular el valor.
 */

export function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;

  const slice = closes.slice(-period);
  const sum = slice.reduce((acc, value) => acc + value, 0);
  return sum / period;
}

/**
 * RSI simple (media de ganancias/pérdidas sin suavizado de Wilder), suficiente
 * como filtro de sobrecompra/sobreventa en la Fase 2.
 */
export function rsi(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) {
      gains += change;
    } else {
      losses -= change;
    }
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Retorno porcentual entre el cierre actual y el de hace `period` sesiones. */
export function momentum(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;

  const past = closes[closes.length - 1 - period];
  const current = closes[closes.length - 1];

  if (past === 0) return null;

  return ((current - past) / past) * 100;
}

/** Serie de SMA alineada con `values` (null en los puntos sin suficiente historial). */
export function smaSeries(values: number[], period: number): (number | null)[] {
  return values.map((_, index) => sma(values.slice(0, index + 1), period));
}

/** Serie de RSI alineada con `values` (null en los puntos sin suficiente historial). */
export function rsiSeries(values: number[], period: number): (number | null)[] {
  return values.map((_, index) => rsi(values.slice(0, index + 1), period));
}

/**
 * Estima el cierre de la próxima sesión que haría que la SMA rápida alcance el
 * valor actual de `smaSlow` (aproximación de "precio de entrada" para un cruce
 * alcista, asumiendo que la SMA lenta no cambia significativamente con un dato nuevo).
 */
export function estimateEntryPrice(closes: number[], fastPeriod: number, smaSlow: number | null): number | null {
  if (smaSlow === null || closes.length < fastPeriod) return null;

  const previousCloses = closes.slice(-fastPeriod, -1);
  const sumPrevious = previousCloses.reduce((acc, value) => acc + value, 0);

  return fastPeriod * smaSlow - sumPrevious;
}
