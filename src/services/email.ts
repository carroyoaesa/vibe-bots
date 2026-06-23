import nodemailer from 'nodemailer';
import { EmailAlertConfig } from '../config';
import { SignalResult } from '../strategy/signals';
import { OhlcBar } from '../strategy/conditions';
import { buildChartSeries } from '../strategy/chart';
import { renderSymbolChartPng } from './chartImage';

export interface TradeAlertAiInfo {
  recommendation: string;
  score: number;
  confidence: number;
  rationale: string;
}

export interface TradeAlertEntry {
  type: 'BUY' | 'SELL';
  symbol: string;
  qty: number;
  price: number;
  orderId: string;
  signal: SignalResult;
  /** Velas usadas para recalcular la señal este ciclo - insumo del gráfico adjunto. */
  bars: OhlcBar[];
  /** Evaluación de Claude de este mismo ciclo, si la hubo (Fase 11/BUY desde 2026-06-21, SELL desde 2026-06-23 - `null` si Claude no estaba configurado o el símbolo no era candidato). */
  ai: TradeAlertAiInfo | null;
}

export function createEmailTransport(config: EmailAlertConfig) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(value: number | null, decimals = 2): string {
  return value === null ? 'n/a' : value.toFixed(decimals);
}

function fmtPrice(value: number | null): string {
  return value === null ? 'n/a' : `$${value.toFixed(2)}`;
}

function buildEntryText(entry: TradeAlertEntry): string {
  const { signal, type, symbol, qty, price, orderId, ai } = entry;
  const header = type === 'BUY'
    ? `🟢 BUY ${symbol}: ${qty} acciones a ~$${price.toFixed(2)} (orden ${orderId})`
    : `🔴 SELL ${symbol}: cierre de ${qty} acciones (orden ${orderId})`;

  const lines = [header, ''];
  lines.push(type === 'BUY' ? `Condición de compra: ${signal.buyConditionLabel}` : `Condición de venta: ${signal.sellConditionLabel}`);
  lines.push(`Motivo: ${signal.reason}`);
  lines.push(`Precio: $${signal.price.toFixed(2)} | SMA rápida: ${fmt(signal.smaFast)} | SMA lenta: ${fmt(signal.smaSlow)} | RSI: ${fmt(signal.rsi)} | Momentum: ${fmt(signal.momentum)}`);
  lines.push(`Precio est. entrada: ${fmtPrice(signal.estimatedEntryPrice)} | Precio est. salida: ${fmtPrice(signal.estimatedExitPrice)}`);

  if (ai) {
    lines.push('');
    lines.push(`Evaluación de IA: ${ai.recommendation} (score ${ai.score.toFixed(2)}, confianza ${(ai.confidence * 100).toFixed(0)}%)`);
    lines.push(`Motivo IA: ${ai.rationale}`);
  }

  return lines.join('\n');
}

function buildEntryHtml(entry: TradeAlertEntry, cid: string | null): string {
  const { signal, type, symbol, qty, price, orderId, ai } = entry;
  const headerEmoji = type === 'BUY' ? '🟢' : '🔴';
  const actionLine = type === 'BUY'
    ? `${qty} acciones a ~$${price.toFixed(2)} (orden ${escapeHtml(orderId)})`
    : `cierre de ${qty} acciones (orden ${escapeHtml(orderId)})`;
  const conditionLine = type === 'BUY'
    ? `Condición de compra: ${escapeHtml(signal.buyConditionLabel)}`
    : `Condición de venta: ${escapeHtml(signal.sellConditionLabel)}`;

  const aiBlock = ai
    ? `
      <p style="margin:12px 0 4px;"><strong>Evaluación de IA (Claude)</strong></p>
      <ul style="margin:0 0 8px;padding-left:20px;">
        <li>Recomendación: ${escapeHtml(ai.recommendation)} (score ${ai.score.toFixed(2)}, confianza ${(ai.confidence * 100).toFixed(0)}%)</li>
        <li>Motivo: ${escapeHtml(ai.rationale)}</li>
      </ul>`
    : '';

  const imgBlock = cid
    ? `<img src="cid:${cid}" alt="Gráfico ${escapeHtml(symbol)}" style="max-width:100%;border-radius:8px;margin-top:8px;" />`
    : '';

  return `
    <h2 style="margin:0 0 4px;">${headerEmoji} ${type} ${escapeHtml(symbol)}</h2>
    <p style="margin:0 0 8px;">${actionLine}</p>
    <p style="margin:0 0 4px;"><strong>Señal técnica</strong></p>
    <ul style="margin:0 0 8px;padding-left:20px;">
      <li>${conditionLine}</li>
      <li>Motivo: ${escapeHtml(signal.reason)}</li>
      <li>Precio: $${signal.price.toFixed(2)} | SMA rápida: ${fmt(signal.smaFast)} | SMA lenta: ${fmt(signal.smaSlow)} | RSI: ${fmt(signal.rsi)} | Momentum: ${fmt(signal.momentum)}</li>
      <li>Precio est. entrada: ${fmtPrice(signal.estimatedEntryPrice)} | Precio est. salida: ${fmtPrice(signal.estimatedExitPrice)}</li>
    </ul>
    ${aiBlock}
    ${imgBlock}
  `;
}

export async function sendTradeAlertEmail(config: EmailAlertConfig, entries: TradeAlertEntry[]): Promise<void> {
  const buyCount = entries.filter((entry) => entry.type === 'BUY').length;
  const sellCount = entries.filter((entry) => entry.type === 'SELL').length;
  const subjectParts: string[] = [];
  if (buyCount > 0) subjectParts.push(`${buyCount} BUY`);
  if (sellCount > 0) subjectParts.push(`${sellCount} SELL`);

  const attachments: { filename: string; content: Buffer; cid: string }[] = [];
  const htmlBlocks: string[] = [];
  const textBlocks: string[] = entries.map(buildEntryText);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const cid = `chart-${i}-${entry.symbol}`;

    try {
      const points = buildChartSeries(entry.bars);
      const png = await renderSymbolChartPng(
        points,
        entry.signal.buyConditionId,
        entry.signal.sellConditionId,
        entry.signal.estimatedEntryPrice,
        entry.signal.estimatedExitPrice
      );
      attachments.push({ filename: `${entry.symbol}.png`, content: png, cid });
      htmlBlocks.push(buildEntryHtml(entry, cid));
    } catch (error) {
      console.warn(`No se pudo generar el gráfico de ${entry.symbol} para el email de alerta:`, error instanceof Error ? error.message : error);
      htmlBlocks.push(buildEntryHtml(entry, null));
    }
  }

  const transport = createEmailTransport(config);
  await transport.sendMail({
    from: config.from,
    to: config.to,
    subject: `Vibe Bots: ${subjectParts.join(' / ')}`,
    text: textBlocks.join('\n\n---\n\n'),
    html: `<div style="font-family:Arial,sans-serif;color:#1a1d24;">${htmlBlocks.join('<hr style="margin:24px 0;border:none;border-top:1px solid #ccc;" />')}</div>`,
    attachments,
  });
}
