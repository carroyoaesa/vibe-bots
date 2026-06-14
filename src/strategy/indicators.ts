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
