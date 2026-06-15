/**
 * Configuración del sistema híbrido por símbolo ("hibrido", basado en `phase1_full20`
 * de `bots/backtests` y el análisis de clasificación de los 20 símbolos del watchlist).
 *
 * No es un híbrido global 1D/1H: de los 20 símbolos, solo estos 5 tienen un combo 1H
 * (`SCALE_1H=8`, ver `./conditions1h.ts`) distinto del pick 1D de `symbol_conditions`,
 * en 3 niveles:
 *
 *  - tier 1 ("in-place"): la señal principal (la que decide BUY/SELL/orden) se calcula
 *    con el combo 1H en vez del pick 1D de `symbol_conditions`. Reemplaza, no agrega.
 *  - tier 2 ("paralelo"): además del flujo 1D normal (sin cambios), se evalúa el combo
 *    1H y, si genera señal, opera con su propio presupuesto de riesgo
 *    (`PARALLEL_RISK_PROFILE`) y posiciones trackeadas en `parallel_positions`
 *    (`services/parallelStore.ts`), independientes de la posición 1D.
 *  - tier 'shadow': igual que tier 2 pero solo registra la señal (`trading_signals`,
 *    `system='shadow'`) - nunca coloca órdenes ni toca `parallel_positions`.
 *
 * Los 13 símbolos restantes (no listados aquí) no tienen entrada -> siguen 100% en el
 * pick 1D de `symbol_conditions`, sin cambios.
 */
import { RiskProfile } from './config';

export type HybridTier = 1 | 2 | 'shadow';

export interface HybridSymbolConfig {
  tier: HybridTier;
  /** Combo 1H (`SCALE_1H=8`, `strategy/conditions.ts#CONDITIONS`), validado en `phase1_full20`. */
  buyConditionId: string;
  sellConditionId: string;
}

export const HYBRID_CONFIG: Record<string, HybridSymbolConfig> = {
  // Tier 1 - refinamiento in-place (mismo combo que el 1D activo, ejecutado sobre velas 1H).
  SPY: { tier: 1, buyConditionId: 'bollinger_reversion', sellConditionId: 'sma_cross_10_30' },
  XLU: { tier: 1, buyConditionId: 'bollinger_reversion', sellConditionId: 'macd_cross' },

  // Tier 2 - sistema paralelo con presupuesto de riesgo separado (combo 1H distinto del 1D activo).
  MS: { tier: 2, buyConditionId: 'stochastic_cross', sellConditionId: 'ema_cross_12_26' },
  QQQM: { tier: 2, buyConditionId: 'stochastic_cross', sellConditionId: 'ema_cross_12_26' },

  // Tier 'shadow' - solo logging, sin órdenes (acumular trades antes de promover a tier 2).
  SCHD: { tier: 'shadow', buyConditionId: 'cci_reversal', sellConditionId: 'sma_cross_20_50' },
};

/** Símbolos con ingesta/evaluación 1H adicional (tiers 1, 2 y 'shadow'). */
export const HYBRID_SYMBOLS = Object.keys(HYBRID_CONFIG);

export const TIER1_SYMBOLS = HYBRID_SYMBOLS.filter((s) => HYBRID_CONFIG[s].tier === 1);
export const TIER2_SYMBOLS = HYBRID_SYMBOLS.filter((s) => HYBRID_CONFIG[s].tier === 2);
export const SHADOW_SYMBOLS = HYBRID_SYMBOLS.filter((s) => HYBRID_CONFIG[s].tier === 'shadow');

/**
 * Presupuesto de riesgo del sistema paralelo (Tier 2: MS, QQQM) - independiente de
 * `bot_settings`/`RISK_PROFILE`. Posiciones más chicas que el perfil "moderado" (10%)
 * porque son EXPOSICIÓN ADICIONAL sobre la misma posición 1D del símbolo. `maxPositions=2`
 * = como máximo una posición paralela abierta por símbolo (MS y QQQM son los únicos
 * elegibles). Siempre opera en modo `signal_only` (sin TP/SL, sale solo por señal SELL
 * del combo 1H) independientemente de `bot_settings.exitMode`.
 */
export const PARALLEL_RISK_PROFILE: RiskProfile = {
  positionSizePct: 0.05,
  stopLossPct: 0,
  takeProfitPct: 0,
  maxPositions: 2,
};
