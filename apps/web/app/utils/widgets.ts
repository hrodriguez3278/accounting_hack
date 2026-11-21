import type { EChartsOption } from 'echarts';

export interface MetricValue { value: string | null; status: string; missing: string[]; compare_value?: string | null; variance_abs?: string | null; variance_pct?: string | null }
export interface SemanticRow { key: string; dimensions: Record<string, string>; labels: Record<string, string>; values: Record<string, MetricValue> }
export interface SemanticResponse {
  query_id: string; period: string; budget_version_code: string; budget_version_kind: string; compare_version_code: string | null; run_id: string;
  run_status: string; currency: string; data_nature: string; certification_status: string; lineage_reference: string; warnings: string[];
  metrics: Array<{ metric_id: string; metric_version: number; name: string; formula: string; unit: 'currency' | 'ratio' }>;
  dimensions: string[]; rows: SemanticRow[];
}
export interface WidgetSpec {
  title: string; type: string; metric_ids: string[]; dimensions: string[]; size: 'sm' | 'md' | 'lg' | 'xl';
  filters: Record<string, unknown>; sort?: { field: string; direction: 'asc' | 'desc' }; limit?: number; options: Record<string, unknown>;
}

/** Registro de tipos de widget aprobados. Solo estos tipos se renderizan; nada proviene como código de la IA. */
export const WIDGET_TYPES: Record<string, { label: string; kind: 'chart' | 'vue' }> = {
  kpi: { label: 'KPI', kind: 'vue' }, bar: { label: 'Barras', kind: 'chart' }, line: { label: 'Líneas', kind: 'chart' },
  area: { label: 'Área', kind: 'chart' }, donut: { label: 'Dona', kind: 'chart' }, stacked_bar: { label: 'Barras apiladas', kind: 'chart' },
  waterfall: { label: 'Cascada', kind: 'chart' }, table: { label: 'Tabla financiera', kind: 'vue' }, comparison_table: { label: 'Tabla comparativa', kind: 'vue' },
  variance: { label: 'Variación', kind: 'chart' }, heatmap: { label: 'Mapa de calor', kind: 'chart' }, insight: { label: 'Texto', kind: 'vue' },
};

const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
const rowLabel = (r: SemanticRow) => Object.values(r.labels).join(' · ') || 'Grupo';
const shortLabel = (r: SemanticRow) => r.dimensions.company ?? r.labels.period ?? r.labels.country ?? r.dimensions.account ?? rowLabel(r);

function axisFormatter(unit: string) {
  return (v: number) => unit === 'ratio' ? `${(v * 100).toFixed(0)} %`
    : Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)} M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)} K` : String(v);
}

function tooltipFor(res: SemanticResponse) {
  return {
    trigger: 'axis' as const,
    valueFormatter: (v: unknown) => (typeof v === 'number' ? (res.metrics[0]?.unit === 'ratio' ? `${(v * 100).toFixed(2)} %`
      : `${res.currency} ${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`) : '—'),
  };
}

export function buildChartOption(spec: WidgetSpec, res: SemanticResponse, narrow = false): EChartsOption {
  const rows = res.rows;
  const metrics = res.metrics;
  const unit = metrics[0]?.unit ?? 'currency';
  const categories = rows.map(shortLabel);
  const many = rows.length > 8 || (narrow && rows.length > 4);
  // En pantallas angostas las categorías se rotan y se acortan para que no se encimen
  const catLabel = { interval: 0, rotate: narrow && rows.length > 3 ? 45 : rows.length > 6 ? 30 : 0, fontSize: narrow ? 10 : 11,
    width: narrow ? 64 : 110, overflow: 'truncate' as const };
  const series = (type: 'bar' | 'line') => metrics.map((m, i) => ({
    name: m.name, type,
    data: rows.map((r) => num(r.values[m.metric_id]?.value)),
    ...(type === 'bar' ? { barMaxWidth: 28, itemStyle: { borderRadius: [4, 4, 0, 0] }, barGap: '8%' } : {
      smooth: false, symbol: 'circle', symbolSize: 7, showSymbol: rows.length <= 12,
      lineStyle: { width: 2, type: i === 1 ? 'dashed' : i === 2 ? 'dotted' : 'solid' },
      ...(spec.type === 'area' ? { areaStyle: { opacity: i === 0 ? 0.12 : 0.06 } } : {}),
    }),
    label: { show: !many && metrics.length === 1 && type === 'bar', position: 'top' as const, fontSize: 10, formatter: (p: { value: number }) => axisFormatter(unit)(p.value) },
    emphasis: { focus: 'series' as const },
  }));
  const grid = { left: 8, right: 16, top: metrics.length > 1 ? 32 : 16, bottom: 8, containLabel: true };
  const legend = { show: metrics.length > 1 };

  switch (spec.type) {
    case 'line':
    case 'area':
      return { grid, legend, tooltip: tooltipFor(res), xAxis: { type: 'category', data: categories, boundaryGap: false, axisLabel: { ...catLabel, interval: 'auto' } },
        yAxis: { type: 'value', axisLabel: { formatter: axisFormatter(unit) } }, series: series('line') } as EChartsOption;
    case 'stacked_bar':
      return { grid, legend, tooltip: tooltipFor(res), xAxis: { type: 'category', data: categories, axisLabel: catLabel },
        yAxis: { type: 'value', axisLabel: { formatter: axisFormatter(unit) } },
        series: series('bar').map((s) => ({ ...s, stack: 'total', label: { show: false }, itemStyle: { borderColor: 'transparent', borderWidth: 1 } })) } as EChartsOption;
    case 'donut': {
      const m = metrics[0]!;
      return {
        tooltip: { trigger: 'item', valueFormatter: (v: unknown) => m.unit === 'ratio' ? `${((v as number) * 100).toFixed(2)} %` : String(v) },
        legend: narrow ? { show: true, bottom: 0, left: 'center' } : { show: true, orient: 'vertical', left: 'right', top: 'middle' },
        series: [{ type: 'pie', radius: narrow ? ['40%', '62%'] : ['52%', '76%'], center: narrow ? ['50%', '42%'] : ['38%', '52%'], avoidLabelOverlap: true, padAngle: 1,
          itemStyle: { borderRadius: 3 }, label: { show: true, formatter: (p: { name: string; percent: number }) => `${p.name}\n${p.percent.toFixed(1)} %`, fontSize: 10 },
          data: rows.map((r) => ({ name: shortLabel(r), value: num(r.values[m.metric_id]?.value) })) }],
        color: ['#000000', '#c3302d', '#89888a', '#5a595c', '#b8b7ba', '#2b2b2d'],
      } as EChartsOption;
    }
    case 'variance': {
      const m = metrics[0]!;
      const data = rows.map((r) => num(r.values[m.metric_id]?.variance_abs));
      return { grid, tooltip: tooltipFor(res), xAxis: { type: 'category', data: categories, axisLabel: catLabel },
        yAxis: { type: 'value', axisLabel: { formatter: axisFormatter(m.unit) } },
        series: [{ name: `Variación ${m.name}`, type: 'bar', barMaxWidth: 28,
          data: data.map((v) => ({ value: v, itemStyle: { color: (v ?? 0) < 0 ? '#c3302d' : undefined, borderRadius: (v ?? 0) < 0 ? [0, 0, 4, 4] : [4, 4, 0, 0] } })),
          label: { show: !many, position: 'top', fontSize: 10, formatter: (p: { value: number }) => `${p.value >= 0 ? '+' : '−'}${axisFormatter(m.unit)(Math.abs(p.value))}` },
          markLine: { silent: true, symbol: 'none', data: [{ yAxis: 0 }], lineStyle: { color: '#89888a' }, label: { show: false } } }],
      } as EChartsOption;
    }
    case 'waterfall': {
      const m = metrics[0]!;
      const vals = rows.map((r) => num(r.values[m.metric_id]?.value) ?? 0);
      let acc = 0;
      const base = vals.map((v) => { const b = v >= 0 ? acc : acc + v; acc += v; return b; });
      return { grid, tooltip: { trigger: 'axis' }, xAxis: { type: 'category', data: [...categories, 'Total'], axisLabel: catLabel },
        yAxis: { type: 'value', axisLabel: { formatter: axisFormatter(m.unit) } },
        series: [
          { type: 'bar', stack: 'w', itemStyle: { color: 'transparent' }, emphasis: { disabled: true }, data: [...base, 0], tooltip: { show: false } },
          { name: m.name, type: 'bar', stack: 'w', barMaxWidth: 32, itemStyle: { borderRadius: 3 },
            data: [...vals.map((v) => ({ value: Math.abs(v), itemStyle: { color: v < 0 ? '#c3302d' : undefined } })),
              { value: acc, itemStyle: { color: '#89888a' } }] },
        ] } as EChartsOption;
    }
    case 'heatmap': {
      const m = metrics[0]!;
      const [d1, d2] = res.dimensions;
      const xs = [...new Set(rows.map((r) => r.labels[d2!] ?? ''))];
      const ys = [...new Set(rows.map((r) => r.dimensions[d1!] ?? ''))];
      const values = rows.map((r) => [xs.indexOf(r.labels[d2!] ?? ''), ys.indexOf(r.dimensions[d1!] ?? ''), num(r.values[m.metric_id]?.value)]);
      const nums = values.map((v) => v[2] as number).filter((v) => v !== null);
      return { grid: { ...grid, bottom: 40 }, tooltip: { position: 'top' }, xAxis: { type: 'category', data: xs, splitArea: { show: true } },
        yAxis: { type: 'category', data: ys }, visualMap: { min: Math.min(...nums), max: Math.max(...nums), calculable: false, orient: 'horizontal',
          left: 'center', bottom: 0, inRange: { color: ['#f3f3f4', '#89888a', '#000000'] }, text: ['Mayor', 'Menor'], itemHeight: 120 },
        series: [{ name: m.name, type: 'heatmap', data: values, itemStyle: { borderColor: '#ffffff', borderWidth: 2 } }] } as EChartsOption;
    }
    default:
      return { grid, legend, tooltip: { ...tooltipFor(res), axisPointer: { type: 'shadow' } }, xAxis: { type: 'category', data: categories,
        axisLabel: catLabel }, yAxis: { type: 'value', axisLabel: { formatter: axisFormatter(unit) } },
      series: series('bar') } as EChartsOption;
  }
}
