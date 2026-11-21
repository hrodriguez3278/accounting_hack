<template>
  <article ref="root" class="panel flex h-full w-full min-w-0 flex-col p-4" :aria-label="spec.title">
    <header class="mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
      <div class="min-w-0 flex-1 basis-40">
        <h3 class="line-clamp-2 text-sm font-bold leading-snug">{{ spec.title }}</h3>
        <p v-if="data" class="mt-0.5 text-xs text-muted">
          {{ data.budget_version_code }}<template v-if="spec.type !== 'kpi'"> · FY{{ data.period }}<template v-if="data.compare_version_code"> · vs {{ data.compare_version_code }}</template></template>
          · <span :class="data.certification_status === 'certified' ? 'text-success' : 'text-warning'">{{ data.certification_status === 'certified' ? 'certificado' : 'no certificado' }}</span>
          <template v-if="data.data_nature !== 'official'"> · {{ data.data_nature === 'projection' ? 'proyección' : data.data_nature }}</template>
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-1">
        <button v-if="data && hasChart" class="btn-ghost min-h-8 px-2 text-xs" :aria-pressed="showTable" @click="showTable = !showTable">
          {{ showTable ? 'Gráfico' : 'Tabla' }}
        </button>
        <NuxtLink v-if="data" :to="lineageLink" class="btn-ghost min-h-8 px-2 text-xs" title="Ver de dónde proviene la cifra">Origen</NuxtLink>
        <slot name="actions" />
      </div>
    </header>

    <StateBlock :loading="loading" :error="error" :empty="!!data && !data.rows.length" :retry="load" empty-text="La consulta no devolvió filas.">
      <template v-if="data">
        <!-- KPI -->
        <div v-if="spec.type === 'kpi'" class="flex flex-1 flex-col justify-end">
          <template v-for="m in data.metrics" :key="m.metric_id">
            <template v-if="kpi(m.metric_id).status === 'calculated'">
              <p class="tabular mt-3 break-words text-[clamp(1.35rem,1.9vw,2.1rem)] font-bold leading-none tracking-[-0.03em]">{{ fmtValue(kpi(m.metric_id).value, m.unit, data.currency, true) }}</p>
              <p v-if="kpi(m.metric_id).variance_abs != null" class="mt-2 text-xs font-semibold tabular"
                 :class="Number(kpi(m.metric_id).variance_abs) < 0 ? 'text-critical' : 'text-success'">
                {{ Number(kpi(m.metric_id).variance_abs) < 0 ? '▼' : '▲' }}
                {{ m.unit === 'ratio' ? `${(Number(kpi(m.metric_id).variance_abs) * 100).toFixed(2)} pp` : fmtMoney(kpi(m.metric_id).variance_abs, data.currency, true) }}
                <span v-if="kpi(m.metric_id).variance_pct && m.unit !== 'ratio'">({{ fmtPct(kpi(m.metric_id).variance_pct, 1) }})</span>
                <span class="font-normal text-muted"> vs {{ data.compare_version_code }}</span>
              </p>
            </template>
            <div v-else class="text-sm">
              <p class="font-semibold">No calculable</p>
              <p class="mt-1 text-xs text-muted">Falta: {{ kpi(m.metric_id).missing.join('; ') }}</p>
            </div>
          </template>
        </div>

        <!-- Texto -->
        <p v-else-if="spec.type === 'insight'" class="text-sm text-muted">{{ spec.options?.note ?? 'Sin texto.' }}</p>

        <!-- Tabla -->
        <div v-else-if="!hasChart || showTable" class="max-h-96 overflow-auto">
          <table class="table-base">
            <caption class="sr-only">{{ spec.title }}</caption>
            <thead>
              <tr>
                <th scope="col">{{ dimHeader }}</th>
                <template v-for="m in data.metrics" :key="m.metric_id">
                  <th scope="col" class="num">{{ m.name }}</th>
                  <th v-if="data.compare_version_code" scope="col" class="num">{{ data.compare_version_code }}</th>
                  <th v-if="data.compare_version_code" scope="col" class="num">Var.</th>
                </template>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in data.rows" :key="r.key">
                <th scope="row" class="border-b border-line px-3 py-2.5 text-left font-semibold">{{ Object.values(r.labels).join(' · ') || 'Grupo consolidado' }}</th>
                <template v-for="m in data.metrics" :key="m.metric_id">
                  <td class="num" :title="r.values[m.metric_id]?.missing.join('; ')">
                    {{ r.values[m.metric_id]?.status === 'calculated' ? fmtValue(r.values[m.metric_id]?.value, m.unit, data.currency) : 'No calculable' }}
                  </td>
                  <td v-if="data.compare_version_code" class="num text-muted">{{ fmtValue(r.values[m.metric_id]?.compare_value, m.unit, data.currency) }}</td>
                  <td v-if="data.compare_version_code" class="num" :class="Number(r.values[m.metric_id]?.variance_abs) < 0 ? 'text-critical' : ''">
                    {{ m.unit === 'ratio' ? fmtPct(r.values[m.metric_id]?.variance_abs) : fmtMoney(r.values[m.metric_id]?.variance_abs, data.currency) }}
                  </td>
                </template>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Gráfico -->
        <EChart v-else :option="option" :label="`${spec.title}: ${data.metrics.map((m) => m.name).join(', ')}`" :height="height" />

        <ul v-if="data.warnings.length" class="mt-3 space-y-0.5 text-xs text-muted">
          <li v-for="w in data.warnings" :key="w">· {{ w }}</li>
        </ul>
      </template>
    </StateBlock>
  </article>
</template>

<script setup lang="ts">
import { buildChartOption, WIDGET_TYPES, type SemanticResponse, type WidgetSpec } from '~/utils/widgets';

const props = defineProps<{ spec: WidgetSpec; fetcher: () => Promise<SemanticResponse>; refreshKey?: unknown }>();
const data = ref<SemanticResponse | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const showTable = ref(false);

async function load() {
  loading.value = true;
  error.value = null;
  try { data.value = await props.fetcher(); } catch (e) { error.value = (e as Error).message; } finally { loading.value = false; }
}
const root = ref<HTMLElement | null>(null);
const narrow = ref(false);
let ro: ResizeObserver | null = null;
onMounted(() => {
  load();
  if (root.value && 'ResizeObserver' in window) {
    ro = new ResizeObserver(([e]) => { narrow.value = (e?.contentRect.width ?? 999) < 520; });
    ro.observe(root.value);
  }
});
onBeforeUnmount(() => ro?.disconnect());
watch(() => [props.refreshKey, JSON.stringify(props.spec)], load);

const hasChart = computed(() => WIDGET_TYPES[props.spec.type]?.kind === 'chart');
const option = computed(() => (data.value ? buildChartOption(props.spec, data.value, narrow.value) : {}));
const height = computed(() => (props.spec.size === 'xl' ? '320px' : props.spec.size === 'sm' ? '200px' : '280px'));
const kpi = (m: string) => data.value?.rows[0]?.values[m] ?? { value: null, status: 'not_calculable', missing: ['Sin datos'] };
const dimHeader = computed(() => ({ company: 'Empresa', country: 'País', period: 'Mes', account: 'Cuenta' } as Record<string, string>)[data.value?.dimensions[0] ?? ''] ?? 'Ámbito');
const lineageLink = computed(() => data.value ? `/audit?run=${data.value.run_id}&metric=${props.spec.metric_ids[0]}` : '/audit');
</script>
