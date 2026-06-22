import { ChartPoint } from './chart';

export interface PriceOverlay {
  key: keyof ChartPoint;
  label: string;
  color: string;
}

export interface OscillatorConfig {
  label: string;
  series: { key: keyof ChartPoint; label: string; color: string }[];
  min?: number;
  max?: number;
  levels?: number[];
}

export interface ConditionChartConfig {
  price?: PriceOverlay[];
  oscillator?: OscillatorConfig;
}

/**
 * Puerto a TypeScript de `CONDITION_CHART_CONFIG`/`mergeConditionChartConfig`
 * (`public/app.js`) - mismo contenido, usado por el render de gráficos del lado del
 * servidor (alertas por email, `services/chartImage.ts`). No hay un módulo compartido
 * entre frontend (script plano, sin bundler) y backend (TS), así que se duplica acá
 * deliberadamente; si `app.js` cambia sus overlays, replicar el cambio en este archivo.
 */
export const CONDITION_CHART_CONFIG: Record<string, ConditionChartConfig> = {
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
    price: [{ key: 'sma50', label: 'SMA50', color: '#e67e22' }],
    oscillator: {
      label: 'RSI(14)',
      series: [{ key: 'rsi14', label: 'RSI14', color: '#2ecc71' }],
      min: 0,
      max: 100,
      levels: [40],
    },
  },
};

function extractConditionIds(expr: string): string[] {
  const tokens = String(expr ?? '').match(/[A-Za-z0-9_]+/g) ?? [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const tok of tokens) {
    if (CONDITION_CHART_CONFIG[tok] && !seen.has(tok)) {
      seen.add(tok);
      ids.push(tok);
    }
  }
  return ids;
}

export function mergeConditionChartConfig(buyConditionId: string, sellConditionId: string): ConditionChartConfig {
  const ids = [...extractConditionIds(buyConditionId), ...extractConditionIds(sellConditionId)];
  const uniqueIds = [...new Set(ids)];

  const priceByKey = new Map<string, PriceOverlay>();
  let oscillator: OscillatorConfig | undefined;
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
