<template>
  <div>
    <PageHeader eyebrow="Financial Consolidation Engine" title="Consolidación" period
                description="Corridas reproducibles: cada una registra el hash de entradas, reglas, tasas y ajustes. Las corridas publicadas son inmutables." />

    <section aria-labelledby="ver" class="panel overflow-x-auto">
      <h2 id="ver" class="sr-only">Versiones</h2>
      <table class="table-base">
        <thead><tr><th>Versión</th><th>Tipo</th><th>Última consolidación</th><th>Publicada</th><th class="text-right">Acciones</th></tr></thead>
        <tbody>
          <tr v-for="v in s.reference?.versions" :key="v.id">
            <td><p class="font-semibold">{{ v.code }}</p><p class="text-xs text-muted">{{ v.name }}</p></td>
            <td>{{ KIND_LABEL[v.kind] }}{{ v.includes_balance_sheet ? '' : ' · sin balance' }}</td>
            <td><StatusBadge v-if="v.latest_run" :status="v.latest_run.status" /><span v-else class="text-muted">—</span></td>
            <td>{{ v.published_run_id ? 'Sí' : 'No' }}</td>
            <td class="text-right">
              <button v-if="s.can('consolidation.run') && s.me?.all_companies" class="btn-secondary min-h-9" :disabled="running === v.id" @click="run(v.id)">
                {{ running === v.id ? 'Ejecutando…' : 'Ejecutar consolidación' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="runMsg" role="status" class="border-t border-line px-3 py-2 text-sm">{{ runMsg }}</p>
    </section>

    <section class="mt-8" aria-labelledby="runs">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <h2 id="runs" class="text-lg font-bold">Historial de consolidaciones</h2>
        <p class="text-sm text-muted">Seleccione dos consolidaciones para comparar resultados.</p>
      </div>
      <StateBlock :loading="runs.loading.value" :error="runs.error.value" :empty="!runs.data.value?.length" :retry="runs.run">
        <div class="panel mt-3 overflow-x-auto">
          <table class="table-base">
            <thead><tr><th><span class="sr-only">Comparar</span></th><th>Versión</th><th>Estado</th><th>Resumen</th><th>Ejecutada</th><th class="text-right">Acciones</th></tr></thead>
            <tbody>
              <tr v-for="r in runs.data.value" :key="r.id">
                <td><input v-model="selected" type="checkbox" :value="r.id" :aria-label="`Comparar corrida ${r.id.slice(0, 8)}`" :disabled="selected.length >= 2 && !selected.includes(r.id)" /></td>
                <td class="whitespace-nowrap font-semibold">{{ r.version_code }}</td>
                <td><StatusBadge :status="r.status" /><p v-if="r.blocking_issues" class="mt-1 text-xs text-critical">{{ r.blocking_issues }} bloqueos</p></td>
                <td class="text-xs text-muted">
                  <template v-if="r.summary?.lines">{{ fmtNum(r.summary.lines, 0) }} registros · {{ r.summary.ic_matches }} operaciones intercompañía conciliadas<template v-if="r.summary.ic_accepted_differences"> · {{ r.summary.ic_accepted_differences }} diferencia aceptada</template></template>
                  <template v-else-if="r.summary?.reason">{{ r.summary.reason }}</template>
                  <template v-else-if="r.summary?.blocking">{{ (r.summary.blocking as string[])[0] }}</template>
                </td>
                <td class="text-xs">{{ fmtDate(r.created_at) }}<br><span class="text-muted">{{ r.created_by }}</span></td>
                <td class="text-right">
                  <button v-if="r.status === 'ready_for_review' && s.can('consolidation.approve')" class="btn-outline min-h-9" @click="transition(r.id, 'approve')">Aprobar</button>
                  <button v-if="r.status === 'approved' && s.can('consolidation.publish')" class="btn-primary min-h-9" @click="transition(r.id, 'publish')">Publicar</button>
                  <NuxtLink v-if="['published', 'approved', 'ready_for_review', 'superseded'].includes(r.status)" :to="`/audit?run=${r.id}&metric=revenue`" class="btn-ghost min-h-9 text-xs">Trazabilidad</NuxtLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </StateBlock>
      <p v-if="govMsg" role="status" class="mt-2 text-sm" :class="govErr ? 'text-critical' : 'text-success'">{{ govMsg }}</p>
      <div v-if="selected.length === 2" class="mt-3">
        <button class="btn-outline" @click="compare">Comparar corridas seleccionadas</button>
        <div v-if="cmp" class="panel mt-3 p-4 text-sm" role="status">
          <p class="font-semibold">{{ cmp.same_inputs ? 'Ambas usan exactamente los mismos datos de entrada.' : 'Los datos de entrada son distintos.' }} {{ cmp.differences.length ? `${cmp.differences.length} indicadores cambiaron.` : 'Los resultados son idénticos.' }}</p>
          <table v-if="cmp.differences.length" class="table-base mt-3">
            <thead><tr><th>Indicador</th><th>Ámbito</th><th class="num">Primera</th><th class="num">Segunda</th></tr></thead>
            <tbody><tr v-for="d in cmp.differences.slice(0, 30)" :key="d.metric_code + d.company_code"><td>{{ metricName(d.metric_code) }}</td><td>{{ d.company_code ?? 'Grupo' }}</td><td class="num">{{ fmtNum(d.a) }}</td><td class="num">{{ fmtNum(d.b) }}</td></tr></tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="mt-10" aria-labelledby="bridge">
      <h2 id="bridge" class="text-lg font-bold">Puente de variación</h2>
      <p class="mt-1 text-sm text-muted">Desglose determinista: volumen en moneda local, tipo de cambio, eliminaciones intercompañía, ajustes y residual.</p>
      <form class="mt-3 grid grid-cols-1 items-end gap-3 sm:flex sm:flex-wrap" @submit.prevent="loadBridge">
        <label class="text-sm"><span class="field-label">Métrica</span>
          <select v-model="bm" class="field sm:w-44"><option v-for="m in BRIDGE" :key="m.code" :value="m.code">{{ m.label }}</option></select></label>
        <label class="text-sm"><span class="field-label">Base</span>
          <select v-model="bBase" class="field sm:w-44"><option v-for="v in published" :key="v.code" :value="v.code">{{ v.code }}</option></select></label>
        <label class="text-sm"><span class="field-label">Comparada</span>
          <select v-model="bCur" class="field sm:w-44"><option v-for="v in published" :key="v.code" :value="v.code">{{ v.code }}</option></select></label>
        <button class="btn-secondary" :disabled="!bBase || !bCur || bBase === bCur">Calcular</button>
      </form>
      <StateBlock :loading="bridgeLoading" :error="bridgeError">
        <div v-if="bridge" class="mt-4 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div class="panel p-4">
            <h3 class="text-sm font-bold">{{ bridge.metric_name }}: {{ bridge.compare_to.code }} → {{ bridge.version.code }}</h3>
            <p class="text-xs text-muted">{{ fmtMoney(bridge.baseTotal, bridge.currency) }} → {{ fmtMoney(bridge.currentTotal, bridge.currency) }} ·
              {{ bridge.certified ? 'ambas versiones publicadas' : 'incluye versiones no publicadas' }} · {{ bridge.reconciles ? 'el puente cuadra' : 'residual material' }}</p>
            <EChart :option="bridgeOption" :label="`Puente de ${bridge.metric_name}`" height="300px" />
          </div>
          <div class="panel overflow-x-auto p-0">
            <table class="table-base">
              <caption class="px-3 pt-3 text-left text-sm font-bold">Contribución por empresa</caption>
              <thead><tr><th>Empresa</th><th class="num">Volumen</th><th class="num">Tipo de cambio</th></tr></thead>
              <tbody><tr v-for="c in bridge.companies" :key="c.companyId"><td class="font-semibold">{{ c.code }}</td>
                <td class="num">{{ fmtMoney(c.volumeEffect, bridge.currency) }}</td><td class="num">{{ fmtMoney(c.fxEffect, bridge.currency) }}</td></tr></tbody>
            </table>
          </div>
        </div>
      </StateBlock>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { EChartsOption } from 'echarts';

interface Run { id: string; status: string; inputs_hash: string | null; blocking_issues: number; summary: Record<string, any>; created_at: string; // eslint-disable-line @typescript-eslint/no-explicit-any
  created_by: string; version_code: string }
interface Bridge { metric_name: string; currency: string; baseTotal: string; currentTotal: string; totalVariance: string; volumeEffect: string; fxEffect: string;
  eliminationEffect: string; adjustmentEffect: string; residual: string; reconciles: boolean; certified: boolean;
  version: { code: string }; compare_to: { code: string }; companies: Array<{ companyId: string; code: string; volumeEffect: string; fxEffect: string }> }
const s = useSessionStore();
const api = useApi();
const { metricName } = useCatalog();
const running = ref<string | null>(null);
const runMsg = ref('');
const govMsg = ref('');
const govErr = ref(false);
const selected = ref<string[]>([]);
const cmp = ref<{ same_inputs: boolean; compared: number; differences: Array<{ metric_code: string; company_code: string | null; a: string; b: string }> } | null>(null);
const runs = useAsync(() => api.get<Run[]>('/api/consolidation/runs'));
const BRIDGE = [{ code: 'revenue', label: 'Ingresos' }, { code: 'ebitda', label: 'EBITDA' }, { code: 'ebit', label: 'EBIT' }, { code: 'net_income', label: 'Utilidad neta' }];
const published = computed(() => s.reference?.versions.filter((v) => v.published_run_id || v.latest_run?.status === 'ready_for_review') ?? []);
const bm = ref('ebitda');
const bBase = ref(published.value[0]?.code ?? '');
const bCur = ref(published.value[1]?.code ?? '');
const bridge = ref<Bridge | null>(null);
const bridgeLoading = ref(false);
const bridgeError = ref<string | null>(null);

async function run(versionId: string) {
  running.value = versionId;
  runMsg.value = '';
  try {
    const r = await api.post<Run>('/api/consolidation/runs', { version_id: versionId });
    runMsg.value = r.status === 'blocked' ? `Consolidación bloqueada: ${r.blocking_issues} incidencias críticas. Revise Calidad de datos.`
      : 'Consolidación lista para revisión y aprobación.';
    await Promise.all([runs.run(), s.refreshReference()]);
  } catch (e) { runMsg.value = (e as Error).message; } finally { running.value = null; }
}
async function transition(id: string, action: 'approve' | 'publish') {
  const reason = window.prompt(action === 'approve' ? 'Motivo de la aprobación' : 'Motivo de la publicación', action === 'approve' ? 'Revisión completada' : 'Publicación oficial');
  if (!reason) return;
  try {
    await api.post(`/api/consolidation/runs/${id}/${action}`, { reason });
    govErr.value = false;
    govMsg.value = action === 'approve' ? 'Consolidación aprobada.' : 'Consolidación publicada. La versión anterior quedó reemplazada.';
    await Promise.all([runs.run(), s.refreshReference()]);
  } catch (e) { govErr.value = true; govMsg.value = (e as Error).message; }
}
async function compare() {
  cmp.value = await api.get(`/api/consolidation/compare?a=${selected.value[0]}&b=${selected.value[1]}`);
}
async function loadBridge() {
  bridgeLoading.value = true;
  bridgeError.value = null;
  try {
    bridge.value = await api.get<Bridge>(`/api/variance?metric=${bm.value}&version=${bCur.value}&compare_to=${bBase.value}&period=${s.period}`);
  } catch (e) { bridgeError.value = (e as Error).message; } finally { bridgeLoading.value = false; }
}
const bridgeOption = computed<EChartsOption>(() => {
  const b = bridge.value!;
  // Cascada de los componentes de la variación (de 0 a la variación total): los efectos quedan a escala legible
  const steps: Array<[string, number]> = [['Volumen', Number(b.volumeEffect)], ['Tipo de cambio', Number(b.fxEffect)],
    ['Eliminaciones IC', Number(b.eliminationEffect)], ['Ajustes', Number(b.adjustmentEffect)], ['Residual', Number(b.residual)]];
  const total = Number(b.totalVariance);
  let acc = 0;
  const base: number[] = [];
  const vals: Array<{ value: number; signed: number; itemStyle?: { color: string; borderRadius: number } }> = [];
  for (const [, n] of steps) {
    base.push(Math.min(acc, acc + n));
    vals.push({ value: Math.abs(n), signed: n, ...(n < 0 ? { itemStyle: { color: '#c3302d', borderRadius: 3 } } : {}) });
    acc += n;
  }
  base.push(Math.min(0, total));
  vals.push({ value: Math.abs(total), signed: total, itemStyle: { color: '#89888a', borderRadius: 3 } });
  const labels = [...steps.map((x) => x[0]), 'Variación total'];
  const k = (v: number) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)} M` : `${(v / 1e3).toFixed(0)} K`);
  return {
    grid: { left: 8, right: 8, top: 24, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (p: unknown) => {
      const it = (p as Array<{ seriesIndex: number; dataIndex: number; name: string }>).find((x) => x.seriesIndex === 1)!;
      return `${it.name}<br>${b.currency} ${vals[it.dataIndex]!.signed.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    } },
    xAxis: { type: 'category', data: labels, axisLabel: { interval: 0, fontSize: 10 } },
    yAxis: { type: 'value', axisLabel: { formatter: (v: number) => k(v) } },
    series: [
      { type: 'bar', stack: 'b', itemStyle: { color: 'transparent' }, data: base, emphasis: { disabled: true }, tooltip: { show: false } },
      { type: 'bar', stack: 'b', barMaxWidth: 44, data: vals, itemStyle: { borderRadius: 3 },
        label: { show: true, position: 'top', fontSize: 10, formatter: (p: { dataIndex: number }) => {
          const v = vals[p.dataIndex]!.signed;
          return `${v >= 0 ? '+' : '−'}${k(Math.abs(v))}`;
        } } },
    ],
  } as EChartsOption;
});
</script>
