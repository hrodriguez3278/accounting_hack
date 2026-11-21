<template>
  <VChart class="w-full min-w-0" :style="{ height }" :option="themed" autoresize :aria-label="label" role="img" />
</template>

<script setup lang="ts">
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { BarChart, HeatmapChart, LineChart, PieChart } from 'echarts/charts';
import { AriaComponent, DatasetComponent, GridComponent, LegendComponent, TooltipComponent, VisualMapComponent, MarkLineComponent } from 'echarts/components';
import VChart from 'vue-echarts';
import type { EChartsOption } from 'echarts';

use([CanvasRenderer, BarChart, LineChart, PieChart, HeatmapChart, GridComponent, TooltipComponent, LegendComponent, DatasetComponent,
  AriaComponent, VisualMapComponent, MarkLineComponent]);

const props = withDefaults(defineProps<{ option: EChartsOption; height?: string; label: string }>(), { height: '300px' });
const s = useSessionStore();

/** Aplica tokens de marca (texto, rejilla, tipografía) según el modo claro/oscuro seleccionado. */
const themed = computed<EChartsOption>(() => {
  void s.theme;
  const css = (n: string) => (import.meta.client ? getComputedStyle(document.documentElement).getPropertyValue(n).trim() : '#000');
  const axis = css('--chart-axis');
  const grid = css('--chart-grid');
  const text = css('--text');
  const base: EChartsOption = {
    aria: { enabled: true },
    textStyle: { fontFamily: 'Montserrat, Helvetica, Arial, sans-serif', color: axis },
    color: [css('--chart-1'), css('--chart-2'), css('--chart-3'), css('--chart-4')],
    tooltip: { backgroundColor: css('--surface'), borderColor: css('--border'), textStyle: { color: text, fontSize: 12 } },
    legend: { textStyle: { color: text, fontSize: 12 }, icon: 'roundRect', itemWidth: 12, itemHeight: 4, top: 0, left: 0 },
    animationDuration: 300,
  };
  const o = { ...base, ...props.option } as EChartsOption & Record<string, unknown>;
  const fixAxis = (ax: unknown) => (Array.isArray(ax) ? ax : ax ? [ax] : []).map((a: Record<string, unknown>) => ({
    axisLine: { lineStyle: { color: grid } }, axisTick: { show: false }, axisLabel: { color: axis, fontSize: 11 },
    splitLine: { lineStyle: { color: grid } }, ...a,
  }));
  if (o.xAxis) o.xAxis = fixAxis(o.xAxis) as EChartsOption['xAxis'];
  if (o.yAxis) o.yAxis = fixAxis(o.yAxis) as EChartsOption['yAxis'];
  o.legend = { ...(base.legend as object), ...((props.option.legend as object) ?? {}) };
  o.tooltip = { ...(base.tooltip as object), ...((props.option.tooltip as object) ?? {}) };
  return o;
});
</script>
