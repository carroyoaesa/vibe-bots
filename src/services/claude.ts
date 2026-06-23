import axios, { AxiosInstance } from 'axios';
import { AnthropicConfig } from '../config';
import { CompanyProfile } from './fmp';
import { MacroObservation } from './fred';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

export function createAnthropicClient(config: AnthropicConfig): AxiosInstance {
  return axios.create({
    baseURL: ANTHROPIC_BASE_URL,
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
  });
}

export interface SymbolAssessmentContext {
  symbol: string;
  type: 'ETF' | 'STOCK';
  signal: 'BUY' | 'SELL' | 'HOLD';
  price: number;
  smaFast: number | null;
  smaSlow: number | null;
  rsi: number | null;
  momentum: number | null;
  estimatedEntryPrice: number | null;
  estimatedExitPrice: number | null;
  buyConditionId: string;
  buyConditionLabel: string;
  sellConditionId: string;
  sellConditionLabel: string;
  fundamentals: CompanyProfile | null;
  news: { headline: string; summary: string; publishedAt: string }[];
}

export interface SymbolAssessment {
  symbol: string;
  score: number;
  recommendation: 'buy' | 'hold' | 'avoid';
  confidence: number;
  rationale: string;
  simplifiedReason: string;
  adjustedEntryPrice: number | null;
  adjustedExitPrice: number | null;
}

export interface ClaudeUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Estimado en USD según `CLAUDE_PRICING` - `null` si el modelo no está en la tabla (no se inventa un precio). */
  costUsd: number | null;
}

/** Modelos de Claude disponibles para la fase de IA (selector en Configuración, Fase 5). */
export const CLAUDE_MODEL_OPTIONS: { id: string; label: string }[] = [
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (rápido y económico)' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (más capaz)' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 (máxima capacidad)' },
];

/**
 * Precios oficiales por millón de tokens (input/output), USD - fuente: platform.claude.com/docs/en/pricing,
 * 2026-06. Usados solo para la visibilidad de costo (Fase eficiencia/experimento) - nunca para bloquear
 * llamadas.
 */
const CLAUDE_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'claude-haiku-4-5-20251001': { inputPerM: 1.0, outputPerM: 5.0 },
  'claude-sonnet-4-6': { inputPerM: 3.0, outputPerM: 15.0 },
  'claude-opus-4-8': { inputPerM: 5.0, outputPerM: 25.0 },
};

function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const pricing = CLAUDE_PRICING[model];
  if (!pricing) return null;
  return (inputTokens / 1_000_000) * pricing.inputPerM + (outputTokens / 1_000_000) * pricing.outputPerM;
}

function extractUsage(model: string, data: any): ClaudeUsage {
  const inputTokens = Number(data.usage?.input_tokens ?? 0);
  const outputTokens = Number(data.usage?.output_tokens ?? 0);
  return {
    model: data.model ?? model,
    inputTokens,
    outputTokens,
    costUsd: estimateCostUsd(model, inputTokens, outputTokens),
  };
}

const RECORD_ASSESSMENTS_TOOL = {
  name: 'record_assessments',
  description: 'Registra la evaluación de IA para cada símbolo del watchlist.',
  input_schema: {
    type: 'object',
    properties: {
      assessments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            symbol: { type: 'string' },
            score: { type: 'number', description: 'Puntaje de -1 (muy negativo) a 1 (muy positivo)' },
            recommendation: { type: 'string', enum: ['buy', 'hold', 'avoid'] },
            confidence: { type: 'number', description: 'Confianza de 0 (baja) a 1 (alta)' },
            rationale: { type: 'string', description: 'Justificación breve (1-2 oraciones, en español) para el equipo técnico' },
            simplified_reason: {
              type: 'string',
              description: 'Explicación en español en 1 oración simple (máx. 25 palabras), sin jerga técnica, apta para un inversor no analista. Ej.: "Apple salió de zona de sobreventa y podría rebotar en los próximos días." o "Amazon sigue en tendencia bajista, esperando una señal clara de cambio."',
            },
            adjustedEntryPrice: {
              type: 'number',
              description: 'Precio de entrada ajustado, solo si difiere del "Precio est. entrada (algorítmico)" dado en el contexto. Omitir si ese estimado parece razonable.',
            },
            adjustedExitPrice: {
              type: 'number',
              description: 'Precio de salida/take-profit ajustado, solo si difiere del "Precio est. salida (algorítmico)" dado en el contexto. Omitir si ese estimado parece razonable.',
            },
          },
          required: ['symbol', 'score', 'recommendation', 'confidence', 'rationale', 'simplified_reason'],
        },
      },
    },
    required: ['assessments'],
  },
};

function buildPrompt(symbols: SymbolAssessmentContext[], macro: MacroObservation[]): string {
  const macroLines = macro.length > 0
    ? macro.map((obs) => `- ${obs.seriesId} (${obs.date}): ${obs.value ?? 'n/a'}`).join('\n')
    : '- Sin datos macro disponibles';

  const symbolBlocks = symbols.map((s) => {
    const fundamentals = s.fundamentals
      ? `Sector: ${s.fundamentals.sector ?? 'n/a'} | Industria: ${s.fundamentals.industry ?? 'n/a'} | Market cap: ${s.fundamentals.marketCap ?? 'n/a'} | Beta: ${s.fundamentals.beta ?? 'n/a'}`
      : 'Sin datos fundamentales';

    const news = s.news.length > 0
      ? s.news.map((item) => `  - (${item.publishedAt.slice(0, 10)}) ${item.headline}`).join('\n')
      : '  - Sin noticias recientes';

    const conditionLine = s.buyConditionId === s.sellConditionId
      ? `Condición activa: ${s.buyConditionLabel}`
      : `Condición de compra: ${s.buyConditionLabel} | Condición de venta: ${s.sellConditionLabel}`;

    return [
      `### ${s.symbol} (${s.type})`,
      `Señal técnica: ${s.signal} | ${conditionLine} | Precio: ${s.price} | SMA10: ${s.smaFast ?? 'n/a'} | SMA30: ${s.smaSlow ?? 'n/a'} | RSI14: ${s.rsi ?? 'n/a'} | Momentum10: ${s.momentum ?? 'n/a'}%`,
      `Precio est. entrada (algorítmico): ${s.estimatedEntryPrice ?? 'n/a'} | Precio est. salida (algorítmico): ${s.estimatedExitPrice ?? 'n/a'}`,
      `Fundamentales: ${fundamentals}`,
      'Noticias recientes:',
      news,
    ].join('\n');
  }).join('\n\n');

  return [
    'Eres un analista financiero que revisa las señales de un bot de trading (cuenta PAPER de Alpaca) ' +
      'basado en condiciones de análisis técnico clásicas (cruces de medias, MACD, RSI, Bollinger, ' +
      'estocástico, Williams %R, CCI, Donchian, etc.), una condición por símbolo elegida según ' +
      'backtests propios (ver "Condición activa" en cada símbolo). SMA10/SMA30/RSI14/Momentum10 se ' +
      'muestran siempre como contexto general, independientemente de la condición activa.',
    '',
    'Tu evaluación SOLO se usa como FILTRO DE VETO sobre señales BUY y SELL ya generadas por la ' +
      'estrategia (nunca genera una operación nueva, nunca afecta señales HOLD). Cada símbolo de ' +
      'abajo ya tiene una "Señal técnica" decidida (BUY, SELL o HOLD) - tu trabajo es decir si el ' +
      'bot debería seguir adelante con ESA señal o vetarla, no proponer una señal distinta.',
    '',
    'Regla estricta de recomendaciones, IMPORTANTE - la palabra "hold" en tu respuesta NO significa ' +
      '"mantener la posición": significa "no objeto, que el bot ejecute la señal técnica tal cual ' +
      'está". El significado de cada valor depende de la "Señal técnica" de ESE símbolo:',
    '  - Señal técnica BUY: usa "buy" si estás de acuerdo con comprar ahora; usa "avoid" si creés ' +
      'que NO debería comprarse (esto bloquea la compra, acción AI_BLOCKED).',
    '  - Señal técnica SELL: usa "hold" si estás de acuerdo con cerrar la posición ahora (sí, "hold" ' +
      '- el nombre es por consistencia del campo, pero el efecto es que la venta SÍ procede); usa ' +
      '"avoid" si creés que la posición debería seguir abierta este ciclo (esto bloquea el cierre, ' +
      'acción AI_BLOCKED_SELL, y la posición sigue abierta).',
    '  - Señal técnica HOLD: usa siempre "hold" (no hay ninguna acción que vetar).',
    '  - Nunca uses "buy" para un símbolo cuya "Señal técnica" no sea BUY - no genera ninguna orden pero confunde el dashboard.',
    '',
    'Contexto macroeconómico (FRED, EE.UU.):',
    macroLines,
    '',
    'Símbolos del watchlist:',
    symbolBlocks,
    '',
    'Para cada símbolo, revisá también el "Precio est. entrada (algorítmico)" y el "Precio est. ' +
      'salida (algorítmico)" a la luz de los fundamentales, noticias y contexto macro. Si esos ' +
      'precios te parecen razonables, omití `adjustedEntryPrice`/`adjustedExitPrice`. Si creés ' +
      'que conviene ajustarlos, incluí `adjustedEntryPrice`/`adjustedExitPrice` con tu propuesta, ' +
      'pero sin alejarte más de ~10% del valor algorítmico correspondiente (el bot descarta ' +
      'ajustes mayores).',
    '',
    `Llama a la tool record_assessments con exactamente ${symbols.length} evaluaciones, una por cada símbolo listado arriba (mismo orden, mismo "symbol").`,
  ].join('\n');
}

function parseAssessments(data: any): SymbolAssessment[] {
  const toolUse = (data.content || []).find(
    (block: any) => block.type === 'tool_use' && block.name === 'record_assessments'
  );

  if (!toolUse || !Array.isArray(toolUse.input?.assessments)) {
    throw new Error('Claude no devolvió evaluaciones en el formato esperado (record_assessments)');
  }

  return toolUse.input.assessments.map((item: any): SymbolAssessment => ({
    symbol: String(item.symbol),
    score: Number(item.score),
    recommendation: item.recommendation === 'buy' || item.recommendation === 'avoid' ? item.recommendation : 'hold',
    confidence: Number(item.confidence),
    rationale: String(item.rationale ?? ''),
    simplifiedReason: String(item.simplified_reason ?? item.rationale ?? ''),
    adjustedEntryPrice: item.adjustedEntryPrice !== undefined && item.adjustedEntryPrice !== null ? Number(item.adjustedEntryPrice) : null,
    adjustedExitPrice: item.adjustedExitPrice !== undefined && item.adjustedExitPrice !== null ? Number(item.adjustedExitPrice) : null,
  }));
}

export interface AssessWatchlistResult {
  assessments: SymbolAssessment[];
  usage: ClaudeUsage;
}

/**
 * Una sola llamada a /v1/messages con tool_choice forzado a record_assessments,
 * para obtener una evaluación estructurada de todo el watchlist en un solo request.
 */
export async function assessWatchlist(
  client: AxiosInstance,
  model: string,
  symbols: SymbolAssessmentContext[],
  macro: MacroObservation[]
): Promise<AssessWatchlistResult> {
  const { data } = await client.post('/v1/messages', {
    model,
    max_tokens: 4096,
    tools: [RECORD_ASSESSMENTS_TOOL],
    tool_choice: { type: 'tool', name: 'record_assessments' },
    messages: [{ role: 'user', content: buildPrompt(symbols, macro) }],
  });

  return { assessments: parseAssessments(data), usage: extractUsage(model, data) };
}

/**
 * Variantes del experimento de sesgo de Claude (Fase eficiencia/experimento, 2026-06-21):
 * - 'B' (sin señal técnica): mismo contexto que producción (precio, fundamentales, noticias,
 *   macro) pero SIN la señal/condición técnica ni los precios estimados algorítmicos - para
 *   ver si Claude recomendaría "buy" igual sin saber que la estrategia ya disparó esa señal.
 * - 'C' (solo señal técnica): únicamente la señal/condición técnica + precio - sin
 *   fundamentales, noticias ni macro - para ver si ese contexto solo alcanza para reproducir
 *   la recomendación de A.
 * - 'D' (orden invertido): mismo contenido completo que A (producción), con las secciones del
 *   prompt en orden inverso (fundamentales/noticias/macro primero, señal técnica al final) -
 *   para detectar sesgo de orden/anclaje en la respuesta de Claude.
 * 'A' (control) NO tiene una variante acá - es exactamente la evaluación de producción ya
 * obtenida por `assessWatchlist`, reusada tal cual (cero llamadas extra a Claude).
 */
export type ClaudeExperimentVariant = 'B' | 'C' | 'D';

function buildVariantPrompt(s: SymbolAssessmentContext, macro: MacroObservation[], variant: ClaudeExperimentVariant): string {
  const macroLines = macro.length > 0
    ? macro.map((obs) => `- ${obs.seriesId} (${obs.date}): ${obs.value ?? 'n/a'}`).join('\n')
    : '- Sin datos macro disponibles';

  const fundamentals = s.fundamentals
    ? `Sector: ${s.fundamentals.sector ?? 'n/a'} | Industria: ${s.fundamentals.industry ?? 'n/a'} | Market cap: ${s.fundamentals.marketCap ?? 'n/a'} | Beta: ${s.fundamentals.beta ?? 'n/a'}`
    : 'Sin datos fundamentales';

  const news = s.news.length > 0
    ? s.news.map((item) => `  - (${item.publishedAt.slice(0, 10)}) ${item.headline}`).join('\n')
    : '  - Sin noticias recientes';

  const conditionLine = s.buyConditionId === s.sellConditionId
    ? `Condición activa: ${s.buyConditionLabel}`
    : `Condición de compra: ${s.buyConditionLabel} | Condición de venta: ${s.sellConditionLabel}`;

  const technicalBlock = [
    `### ${s.symbol} (${s.type}) - datos técnicos`,
    `Señal técnica: ${s.signal} | ${conditionLine} | Precio: ${s.price} | SMA10: ${s.smaFast ?? 'n/a'} | SMA30: ${s.smaSlow ?? 'n/a'} | RSI14: ${s.rsi ?? 'n/a'} | Momentum10: ${s.momentum ?? 'n/a'}%`,
    `Precio est. entrada (algorítmico): ${s.estimatedEntryPrice ?? 'n/a'} | Precio est. salida (algorítmico): ${s.estimatedExitPrice ?? 'n/a'}`,
  ].join('\n');

  const fundamentalsBlock = [
    `### ${s.symbol} (${s.type}) - fundamentales y noticias`,
    `Precio: ${s.price}`,
    `Fundamentales: ${fundamentals}`,
    'Noticias recientes:',
    news,
  ].join('\n');

  const header = 'Eres un analista financiero evaluando una posible operación BUY (cuenta PAPER de Alpaca). ' +
    'Tu evaluación es experimental (no afecta ninguna orden real) - parte de un estudio sobre qué tan ' +
    'sensible es tu recomendación al contexto que se te da.';

  const instructions = 'Llama a la tool record_assessments con exactamente 1 evaluación para este símbolo.';

  if (variant === 'B') {
    return [
      header,
      '',
      'IMPORTANTE: no se te informa la señal técnica ni la condición de análisis técnico activa - evaluá ' +
        'solo en base a fundamentales, noticias y contexto macro.',
      '',
      'Contexto macroeconómico (FRED, EE.UU.):',
      macroLines,
      '',
      fundamentalsBlock,
      '',
      instructions,
    ].join('\n');
  }

  if (variant === 'C') {
    return [
      header,
      '',
      'IMPORTANTE: solo se te da la señal técnica y el precio - sin fundamentales, noticias ni contexto macro.',
      '',
      technicalBlock,
      '',
      instructions,
    ].join('\n');
  }

  // 'D': mismo contenido completo que la evaluación de producción, orden de secciones invertido.
  return [
    header,
    '',
    'Contexto macroeconómico (FRED, EE.UU.):',
    macroLines,
    '',
    fundamentalsBlock,
    '',
    technicalBlock,
    '',
    instructions,
  ].join('\n');
}

export interface AssessVariantResult {
  assessment: SymbolAssessment;
  usage: ClaudeUsage;
}

/** Evalúa UN símbolo con una de las variantes B/C/D del experimento (ver `buildVariantPrompt`). */
export async function assessSymbolVariant(
  client: AxiosInstance,
  model: string,
  context: SymbolAssessmentContext,
  macro: MacroObservation[],
  variant: ClaudeExperimentVariant
): Promise<AssessVariantResult> {
  const { data } = await client.post('/v1/messages', {
    model,
    max_tokens: 1024,
    tools: [RECORD_ASSESSMENTS_TOOL],
    tool_choice: { type: 'tool', name: 'record_assessments' },
    messages: [{ role: 'user', content: buildVariantPrompt(context, macro, variant) }],
  });

  const [assessment] = parseAssessments(data);
  if (!assessment) {
    throw new Error(`Claude no devolvió una evaluación para la variante ${variant} de ${context.symbol}`);
  }

  return { assessment, usage: extractUsage(model, data) };
}

export async function verifyAnthropic(client: AxiosInstance, model: string): Promise<{ model: string; reply: string }> {
  const { data } = await client.post('/v1/messages', {
    model,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Respondé solo con la palabra "ok".' }],
  });

  const text = (data.content || []).find((block: any) => block.type === 'text')?.text ?? '';

  return { model: data.model ?? model, reply: text.trim() };
}
