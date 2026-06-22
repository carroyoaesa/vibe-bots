import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { ChartPoint } from '../strategy/chart';
import { mergeConditionChartConfig } from '../strategy/chartOverlays';

const WIDTH = 800;
const HEIGHT = 420;
const BACKGROUND = '#1a1d24';
const GRID_COLOR = '#2a2e35';
const TICK_COLOR = '#9aa0a6';

const chartJSNodeCanvas = new ChartJSNodeCanvas({ width: WIDTH, height: HEIGHT, backgroundColour: BACKGROUND });

/**
 * Render del gráfico de un símbolo a PNG para incrustar en el email de alerta (Fase 12) -
 * mismos overlays que la sección "Detalle" del dashboard (`public/app.js#renderSymbolCharts`),
 * vía `mergeConditionChartConfig` (puerto a TS en `strategy/chartOverlays.ts`), con los 3
 * toggles de overlay (MA/Bollinger/oscilador) siempre en `true` (no hay estado de sesión de
 * usuario en un email estático - usa el default del dashboard).
 */
export async function renderSymbolChartPng(
  points: ChartPoint[],
  buyConditionId: string,
  sellConditionId: string,
  estimatedEntryPrice: number | null,
  estimatedExitPrice: number | null
): Promise<Buffer> {
  const labels = points.map((point) => new Date(point.ts).toLocaleDateString());
  const closes = points.map((point) => point.close);
  const chartConfig = mergeConditionChartConfig(buyConditionId, sellConditionId);

  const datasets: any[] = [
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

  (chartConfig.price ?? []).forEach((overlay) => {
    datasets.push({
      label: overlay.label,
      data: points.map((point) => point[overlay.key]),
      borderColor: overlay.color,
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.1,
      yAxisID: 'y',
    });
  });

  if (estimatedEntryPrice !== null) {
    datasets.push({
      label: 'Precio est. entrada',
      data: labels.map(() => estimatedEntryPrice),
      borderColor: '#f1c40f',
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [6, 4],
      pointRadius: 0,
      tension: 0,
      yAxisID: 'y',
    });
  }
  if (estimatedExitPrice !== null) {
    datasets.push({
      label: 'Precio est. salida',
      data: labels.map(() => estimatedExitPrice),
      borderColor: '#9b59b6',
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [6, 4],
      pointRadius: 0,
      tension: 0,
      yAxisID: 'y',
    });
  }

  const oscillator = chartConfig.oscillator;
  if (oscillator) {
    oscillator.series.forEach((s) => {
      datasets.push({
        label: s.label,
        data: points.map((point) => point[s.key]),
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

  const scales: any = {
    x: { ticks: { color: TICK_COLOR, maxTicksLimit: 8 }, grid: { color: GRID_COLOR } },
    y: { ticks: { color: TICK_COLOR }, grid: { color: GRID_COLOR } },
  };
  if (oscillator) {
    scales.y1 = {
      position: 'right',
      ticks: { color: TICK_COLOR },
      grid: { drawOnChartArea: false },
      title: { display: true, text: oscillator.label, color: TICK_COLOR },
      ...(oscillator.min !== undefined ? { min: oscillator.min } : {}),
      ...(oscillator.max !== undefined ? { max: oscillator.max } : {}),
    };
  }

  return chartJSNodeCanvas.renderToBuffer({
    type: 'line',
    data: { labels, datasets },
    options: {
      scales,
      plugins: {
        legend: { labels: { color: '#c7c9cc' } },
      },
    },
  } as any);
}
