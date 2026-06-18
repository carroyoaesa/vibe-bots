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
 *
 * ⚠️ Guard rail (auditoría 2026-06-18, bug MU): la fórmula `fastPeriod*smaSlow - sumPrevious`
 * es una proyección lineal de 1 paso - cuando los cierres recientes (sumPrevious) divergen
 * mucho de `smaSlow` (rally o caída fuerte reciente, típico en nombres volátiles como MU),
 * puede devolver un valor negativo o absurdamente alto. Las ramas EMA/MACD de
 * `computeEstimatedEntryPrice` ya tenían este guard (`p > 0 && p < price*4`); esta función
 * no lo tenía - se agrega acá, con el precio actual (último close) como fallback, igual
 * que las otras ramas en `conditions.ts`.
 */
export function estimateEntryPrice(closes: number[], fastPeriod: number, smaSlow: number | null): number | null {
  if (smaSlow === null || closes.length < fastPeriod) return null;

  const previousCloses = closes.slice(-fastPeriod, -1);
  const sumPrevious = previousCloses.reduce((acc, value) => acc + value, 0);
  const estimated = fastPeriod * smaSlow - sumPrevious;

  const currentPrice = closes[closes.length - 1];
  if (estimated <= 0 || estimated > currentPrice * 4) {
    console.warn(`[estimateEntryPrice] Valor fuera de rango (${estimated.toFixed(2)}) para fastPeriod=${fastPeriod}, smaSlow=${smaSlow.toFixed(2)}, price=${currentPrice.toFixed(2)} - usando price como fallback`);
    return currentPrice;
  }

  return estimated;
}

/**
 * Indicadores adicionales (Fase 6, condiciones de estado multi-condicionales),
 * como series alineadas con el array de entrada (índice i = mismo bar). `null`
 * cuando no hay suficiente histórico todavía para ese punto.
 */
export type Series = (number | null)[];

/** Media móvil exponencial. Semilla = SMA de los primeros `period` valores. */
export function emaSeries(values: number[], period: number): Series {
  return emaFromSeries(values, period);
}

/** Igual que `emaSeries` pero tolera `null`s al inicio de la serie de entrada (p.ej. MACD). */
export function emaFromSeries(series: Series, period: number): Series {
  const result: Series = new Array(series.length).fill(null);
  const start = series.findIndex((v) => v !== null);
  if (start === -1 || series.length - start < period) return result;

  let sum = 0;
  for (let i = start; i < start + period; i++) sum += series[i] as number;
  let prev = sum / period;
  result[start + period - 1] = prev;

  const k = 2 / (period + 1);
  for (let i = start + period; i < series.length; i++) {
    prev = (series[i] as number) * k + prev * (1 - k);
    result[i] = prev;
  }
  return result;
}

/** Retorno porcentual entre el cierre actual y el de hace `period` sesiones (ROC/momentum). */
export function rocSeries(values: number[], period: number): Series {
  return values.map((_, i) => {
    if (i < period) return null;
    const past = values[i - period];
    if (past === 0) return null;
    return ((values[i] - past) / past) * 100;
  });
}

export interface MacdResult {
  macd: Series;
  signal: Series;
}

/** MACD = EMA(fast) - EMA(slow); línea de señal = EMA(signalPeriod) del MACD. */
export function macdSeries(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const emaFast = emaSeries(values, fast);
  const emaSlow = emaSeries(values, slow);
  const macd: Series = values.map((_, i) => {
    const f = emaFast[i];
    const s = emaSlow[i];
    return f !== null && s !== null ? f - s : null;
  });
  const signal = emaFromSeries(macd, signalPeriod);
  return { macd, signal };
}

export interface BollingerBands {
  upper: Series;
  middle: Series;
  lower: Series;
}

/** Bandas de Bollinger: media móvil simple ± `mult` desviaciones estándar. */
export function bollingerBands(values: number[], period = 20, mult = 2): BollingerBands {
  const middle = smaSeries(values, period);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);

  for (let i = 0; i < values.length; i++) {
    const mid = middle[i];
    if (mid === null) continue;

    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += (values[j] - mid) ** 2;
    const std = Math.sqrt(sumSq / period);

    upper[i] = mid + mult * std;
    lower[i] = mid - mult * std;
  }

  return { upper, middle, lower };
}

export interface StochasticResult {
  k: Series;
  d: Series;
}

/** Oscilador estocástico %K (rango period) suavizado con %D = SMA(dPeriod) de %K. */
export function stochasticSeries(highs: number[], lows: number[], closes: number[], period = 14, dPeriod = 3): StochasticResult {
  const k: Series = closes.map((close, i) => {
    if (i + 1 < period) return null;
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      highest = Math.max(highest, highs[j]);
      lowest = Math.min(lowest, lows[j]);
    }
    if (highest === lowest) return 50;
    return ((close - lowest) / (highest - lowest)) * 100;
  });

  const d = smaFromSeries(k, dPeriod);
  return { k, d };
}

/** SMA de una serie que puede contener `null`s al inicio. */
function smaFromSeries(series: Series, period: number): Series {
  return series.map((_, i) => {
    if (i + 1 < period) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const v = series[j];
      if (v === null) return null;
      sum += v;
    }
    return sum / period;
  });
}

/** Williams %R: posición del cierre dentro del rango high/low de `period` sesiones (0 a -100). */
export function williamsRSeries(highs: number[], lows: number[], closes: number[], period = 14): Series {
  return closes.map((close, i) => {
    if (i + 1 < period) return null;
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      highest = Math.max(highest, highs[j]);
      lowest = Math.min(lowest, lows[j]);
    }
    if (highest === lowest) return -50;
    return ((highest - close) / (highest - lowest)) * -100;
  });
}

/** Commodity Channel Index sobre el precio típico (H+L+C)/3. */
export function cciSeries(highs: number[], lows: number[], closes: number[], period = 20): Series {
  const typical = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const smaTp = smaSeries(typical, period);

  return typical.map((tp, i) => {
    const mean = smaTp[i];
    if (mean === null) return null;

    let sumDev = 0;
    for (let j = i - period + 1; j <= i; j++) sumDev += Math.abs(typical[j] - mean);
    const meanDev = sumDev / period;

    if (meanDev === 0) return 0;
    return (tp - mean) / (0.015 * meanDev);
  });
}

/** Máximo de `high` en las `period` sesiones PREVIAS a `i` (sin incluir `i`) - para rupturas de canal. */
export function priorHighSeries(highs: number[], period: number): Series {
  return highs.map((_, i) => {
    if (i < period) return null;
    let highest = -Infinity;
    for (let j = i - period; j <= i - 1; j++) highest = Math.max(highest, highs[j]);
    return highest;
  });
}

/** Mínimo de `low` en las `period` sesiones PREVIAS a `i` (sin incluir `i`) - para rupturas de canal. */
export function priorLowSeries(lows: number[], period: number): Series {
  return lows.map((_, i) => {
    if (i < period) return null;
    let lowest = Infinity;
    for (let j = i - period; j <= i - 1; j++) lowest = Math.min(lowest, lows[j]);
    return lowest;
  });
}
