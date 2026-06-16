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

/** Modelos de Claude disponibles para la fase de IA (selector en Configuración, Fase 5). */
export const CLAUDE_MODEL_OPTIONS: { id: string; label: string }[] = [
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (rápido y económico)' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (más capaz)' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 (máxima capacidad)' },
];

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
    'Tu evaluación SOLO se usa como FILTRO de veto sobre señales BUY ya generadas por la estrategia: ' +
      'una recomendación "avoid" bloquea esa compra (acción AI_BLOCKED). No genera compras nuevas, ' +
      'no afecta señales SELL ni HOLD. Usa "avoid" solo cuando haya una razón clara para desconfiar ' +
      'de la señal BUY (noticias muy negativas recientes, fundamentales débiles o contexto macro ' +
      'claramente adverso para ese símbolo). Si no hay señales de alerta, usa "hold" o "buy".',
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

/**
 * Una sola llamada a /v1/messages con tool_choice forzado a record_assessments,
 * para obtener una evaluación estructurada de todo el watchlist en un solo request.
 */
export async function assessWatchlist(
  client: AxiosInstance,
  model: string,
  symbols: SymbolAssessmentContext[],
  macro: MacroObservation[]
): Promise<SymbolAssessment[]> {
  const { data } = await client.post('/v1/messages', {
    model,
    max_tokens: 4096,
    tools: [RECORD_ASSESSMENTS_TOOL],
    tool_choice: { type: 'tool', name: 'record_assessments' },
    messages: [{ role: 'user', content: buildPrompt(symbols, macro) }],
  });

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

export async function verifyAnthropic(client: AxiosInstance, model: string): Promise<{ model: string; reply: string }> {
  const { data } = await client.post('/v1/messages', {
    model,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Respondé solo con la palabra "ok".' }],
  });

  const text = (data.content || []).find((block: any) => block.type === 'text')?.text ?? '';

  return { model: data.model ?? model, reply: text.trim() };
}
