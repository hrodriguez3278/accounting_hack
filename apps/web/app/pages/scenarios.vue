<template>
  <div>
    <PageHeader eyebrow="Scenario Lab" title="Simulación financiera" period
                description="Los escenarios usan fórmulas explícitas sobre una consolidación base y nunca modifican cifras aprobadas. Todo resultado se marca como simulación." />
    <div class="grid grid-cols-1 gap-6 xl:grid-cols-[24rem_minmax(0,1fr)]">
      <form class="panel space-y-4 p-4" @submit.prevent="create">
        <div><label for="sn" class="field-label">Nombre del escenario</label><input id="sn" v-model.trim="name" class="field" required minlength="3" maxlength="120" /></div>
        <div><label for="sb" class="field-label">Consolidación base</label>
          <select id="sb" v-model="base" class="field"><option value="approved">Presupuesto publicado vigente</option>
            <option v-for="v in s.reference?.versions.filter((x) => x.published_run_id)" :key="v.code" :value="v.code">{{ v.code }}</option></select></div>
        <fieldset class="space-y-3">
          <legend class="field-label">Supuestos (en %; deje vacío lo que no aplique)</legend>
          <div v-for="a in ASSUMPTIONS" :key="a.code" class="grid grid-cols-[1fr_7rem] items-center gap-2">
            <label :for="`a-${a.code}`" class="text-sm">{{ a.label }}<span class="block text-xs text-muted">{{ a.help }}</span></label>
            <input :id="`a-${a.code}`" v-model="values[a.code]" class="field tabular" inputmode="decimal" :placeholder="'money' in a ? 'USD' : '%'" />
          </div>
        </fieldset>
        <p v-if="err" role="alert" class="text-sm text-critical">{{ err }}</p>
        <button class="btn-primary w-full" :disabled="busy">{{ busy ? 'Calculando…' : 'Ejecutar escenario' }}</button>
      </form>

      <section aria-live="polite">
        <StateBlock :empty="!result" empty-text="Defina supuestos y ejecute el escenario para comparar contra el presupuesto oficial.">
          <div v-if="result" class="panel p-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h2 class="min-w-0 break-words text-lg font-bold">{{ result.name }}</h2>
              <div class="flex items-center gap-2"><span class="rounded-full bg-warning-bg px-2.5 py-0.5 text-xs font-semibold text-warning">Simulación · no oficial</span><StatusBadge :status="result.status" /></div>
            </div>
            <p class="text-sm text-muted">Base: {{ result.base.version }} ({{ STATUS_LABEL[result.base.run_status] }}). Supuestos explícitos: {{ assumptionText(result.assumptionsUsed) }}</p>
            <p v-if="result.missingAssumptions.length" class="mt-2 text-sm text-critical">Escenario incompleto. Falta: {{ result.missingAssumptions.join('; ') }}</p>
            <EChart class="mt-4" :option="chart" label="Comparación base contra escenario" height="260px" />
            <div class="mt-4 overflow-x-auto"><table class="table-base">
              <thead><tr><th>Métrica</th><th class="num">Oficial (base)</th><th class="num">Simulado</th><th class="num">Diferencia</th></tr></thead>
              <tbody><tr v-for="m in result.metrics" :key="m.metricCode">
                <td class="font-semibold">{{ LABEL[m.metricCode] ?? m.metricCode }}</td>
                <td class="num">{{ fmtValue(m.base, m.unit, s.currency) }}</td>
                <td class="num">{{ m.status === 'calculated' ? fmtValue(m.scenario, m.unit, s.currency) : 'No calculable' }}</td>
                <td class="num" :class="Number(m.delta) < 0 ? 'text-critical' : ''">{{ m.unit === 'ratio' ? (m.delta ? `${(Number(m.delta) * 100).toFixed(2)} pp` : '—') : fmtMoney(m.delta, s.currency) }}</td></tr></tbody>
            </table></div>
          </div>
        </StateBlock>

        <h2 class="mt-10 text-lg font-bold">Escenarios anteriores</h2>
        <StateBlock :loading="list.loading.value" :error="list.error.value" :empty="!list.data.value?.length">
          <ul class="mt-3 divide-y divide-line">
            <li v-for="sc in list.data.value" :key="sc.id" class="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
              <div><p class="font-semibold">{{ sc.name }}</p><p class="text-xs text-muted">{{ sc.base_version }} · {{ fmtDate(sc.created_at) }} · {{ assumptionText(sc.assumptions) }}</p></div>
              <StatusBadge :status="sc.status" />
            </li>
          </ul>
        </StateBlock>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { EChartsOption } from 'echarts';

const s = useSessionStore();
const api = useApi();
const ASSUMPTIONS = [
  { code: 'revenue_growth', label: 'Crecimiento de ingresos', help: 'Volumen; arrastra costo de ventas' },
  { code: 'cost_increase', label: 'Incremento de costos', help: 'Sobre costo de ventas' },
  { code: 'opex_reduction', label: 'Reducción de gastos operativos', help: '' },
  { code: 'fx_change', label: 'Tipo de cambio', help: '+ = monedas locales más fuertes' },
  { code: 'additional_investment', label: 'Inversión adicional', help: 'Monto en moneda del grupo', money: true },
  { code: 'operating_yield', label: 'Rendimiento operativo de la inversión', help: 'EBIT incremental / inversión' },
  { code: 'cost_of_capital', label: 'Costo de capital (WACC)', help: 'Vacío = WACC calculado' },
  { code: 'tax_rate', label: 'Tasa impositiva', help: 'Vacío = parámetro aprobado' },
] as const;
const LABEL: Record<string, string> = { revenue: 'Ingresos', costs: 'Costos', opex: 'Gastos operativos', ebitda: 'EBITDA', ebit: 'EBIT', nopat: 'NOPAT',
  invested_capital: 'Capital invertido', capital_employed: 'Capital empleado', roic: 'ROIC', roce: 'ROCE', wacc: 'WACC', eva: 'EVA' };
const name = ref('Escenario de eficiencia');
const base = ref('approved');
const values = reactive<Record<string, string>>({ opex_reduction: '8' });
const busy = ref(false);
const err = ref('');
interface Result { name: string; status: string; base: { version: string; run_status: string }; missingAssumptions: string[]; formulas: Record<string, string>;
  metrics: Array<{ metricCode: string; unit: string; base: string | null; scenario: string | null; delta: string | null; status: string }>; assumptionsUsed?: Record<string, string> }
const result = ref<Result | null>(null);
const list = useAsync(() => api.get<Array<{ id: string; name: string; status: string; created_at: string; base_version: string; assumptions: Record<string, string> | null }>>('/api/scenarios'));

function assumptionText(a?: Record<string, string> | null) {
  if (!a || !Object.keys(a).length) return 'ninguno';
  return Object.entries(a).map(([k, v]) => `${ASSUMPTIONS.find((x) => x.code === k)?.label ?? k} ${k === 'additional_investment' ? fmtMoney(v, s.currency) : `${(Number(v) * 100).toFixed(2)} %`}`).join(' · ');
}
async function create() {
  busy.value = true;
  err.value = '';
  try {
    const assumptions: Record<string, string> = {};
    for (const a of ASSUMPTIONS) {
      const raw = (values[a.code] ?? '').toString().trim().replace(',', '.');
      if (!raw) continue;
      if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new Error(`Valor inválido en ${a.label}`);
      assumptions[a.code] = 'money' in a ? raw : String(Number(raw) / 100);
    }
    const r = await api.post<Result>('/api/scenarios', { name: name.value, base_version: base.value, fiscal_year: s.period, assumptions });
    result.value = { ...r, assumptionsUsed: assumptions };
    list.run();
  } catch (e) { err.value = (e as Error).message; } finally { busy.value = false; }
}
const chart = computed<EChartsOption>(() => {
  const ms = (result.value?.metrics ?? []).filter((m) => ['ebitda', 'ebit', 'nopat', 'eva'].includes(m.metricCode));
  return {
    grid: { left: 8, right: 8, top: 32, bottom: 8, containLabel: true }, legend: { show: true }, tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: ms.map((m) => LABEL[m.metricCode]) },
    yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${(v / 1e6).toFixed(0)} M` } },
    series: [
      { name: 'Oficial', type: 'bar', barMaxWidth: 26, itemStyle: { borderRadius: [4, 4, 0, 0] }, data: ms.map((m) => Number(m.base)) },
      { name: 'Simulación', type: 'bar', barMaxWidth: 26, itemStyle: { borderRadius: [4, 4, 0, 0], color: '#c3302d', decal: { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [2, 3], rotation: Math.PI / 4 } },
        data: ms.map((m) => (m.scenario ? Number(m.scenario) : null)) },
    ],
    aria: { enabled: true, decal: { show: true } },
  } as EChartsOption;
});
</script>
