<template>
  <div>
    <PageHeader eyebrow="Overview · Dashboard ejecutivo" :title="`Grupo consolidado FY${s.period}`" period
                :description="base ? `Presupuesto publicado vigente: ${base.name}. Cifras certificadas en ${s.currency}.` : undefined">
      <NuxtLink to="/dashboards" class="btn-outline">Mis dashboards</NuxtLink>
      <NuxtLink to="/analyst" class="btn-primary"><PhSparkle :size="16" aria-hidden="true" /> Preguntar a la IA</NuxtLink>
    </PageHeader>

    <StateBlock :empty="!base" :loading="!s.reference">
      <template #empty>
        <p class="font-semibold text-ink">Aún no hay un presupuesto publicado.</p>
        <p class="mt-1">Cargue los presupuestos en el Data Hub, resuelva las incidencias y publique una consolidación.</p>
        <NuxtLink to="/data-hub" class="btn-outline mt-4">Ir al Data Hub</NuxtLink>
      </template>

      <template v-if="!s.me?.all_companies">
        <div class="mb-6 rounded-ui border border-line bg-surface-muted p-4 text-sm">
          Su acceso está limitado a empresas específicas: las cifras de grupo no están disponibles. Consulte la vista por empresa.
        </div>
        <WidgetRenderer :spec="companyTable" :fetcher="() => q(companyTable)" />
      </template>

      <template v-else-if="base">
        <!-- KPI primarios -->
        <section aria-labelledby="kpis" class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          <h2 id="kpis" class="sr-only">Indicadores principales</h2>
          <WidgetRenderer v-for="k in kpis" :key="k.title" :spec="k" :fetcher="() => q(k)" />
        </section>

        <!-- Visualización dominante + estado -->
        <section class="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <WidgetRenderer :spec="trend" :fetcher="() => q(trend)" />
          <div class="panel p-4">
            <h2 class="text-sm font-bold">Estado de consolidación</h2>
            <ul class="mt-3 divide-y divide-line">
              <li v-for="v in s.reference?.versions" :key="v.id" class="flex items-center justify-between gap-3 py-2.5">
                <div class="min-w-0">
                  <p class="truncate text-sm font-semibold">{{ v.code }}</p>
                  <p class="truncate text-xs text-muted">{{ KIND_LABEL[v.kind] }} · {{ v.name }}</p>
                </div>
                <StatusBadge :status="v.published_run_id ? 'published' : v.latest_run?.status ?? 'draft'" />
              </li>
            </ul>
            <h2 class="mt-6 text-sm font-bold">Alertas</h2>
            <StateBlock :loading="alerts.loading.value" :error="alerts.error.value" :empty="!alerts.data.value?.length" empty-text="Sin incidencias abiertas.">
              <ul class="mt-2 space-y-2">
                <li v-for="a in alerts.data.value" :key="a.version" class="flex items-start gap-2 text-sm">
                  <PhWarningDiamond :size="18" class="mt-0.5 shrink-0" :class="a.critical ? 'text-critical' : 'text-warning'" aria-hidden="true" />
                  <span><strong>{{ a.version }}</strong>: {{ a.critical }} críticas y {{ a.warning }} advertencias abiertas.
                    <NuxtLink :to="`/data-quality?version=${a.versionId}`" class="font-semibold underline underline-offset-2">Revisar</NuxtLink></span>
                </li>
              </ul>
            </StateBlock>
          </div>
        </section>

        <!-- Desgloses -->
        <section class="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
          <WidgetRenderer :spec="byCompany" :fetcher="() => q(byCompany)" />
          <WidgetRenderer :spec="variance" :fetcher="() => q(variance)" />
        </section>
        <section class="mt-6">
          <WidgetRenderer :spec="companyTable" :fetcher="() => q(companyTable)" />
        </section>
      </template>
    </StateBlock>
  </div>
</template>

<script setup lang="ts">
import { PhSparkle, PhWarningDiamond } from '@phosphor-icons/vue';
import type { SemanticResponse, WidgetSpec } from '~/utils/widgets';

const s = useSessionStore();
const api = useApi();
const base = computed(() => s.publishedBudget);
const compare = computed(() => s.reference?.versions.find((v) => v.kind === 'budget' && v.published_run_id && v.code !== base.value?.code)?.code);
const forecast = computed(() => s.reference?.versions.find((v) => v.kind === 'forecast' && v.published_run_id)?.code);

const w = (x: Partial<WidgetSpec>): WidgetSpec => ({ dimensions: [], size: 'md', filters: {}, options: {}, type: 'bar', metric_ids: [], title: '', ...x });
const kpis = computed(() => [
  w({ title: 'Ingresos consolidados', type: 'kpi', metric_ids: ['revenue'], filters: { compare_to: compare.value } }),
  w({ title: 'EBITDA', type: 'kpi', metric_ids: ['ebitda'], filters: { compare_to: compare.value } }),
  w({ title: 'ROIC', type: 'kpi', metric_ids: ['roic'], filters: { compare_to: compare.value } }),
  w({ title: 'ROCE', type: 'kpi', metric_ids: ['roce'], filters: { compare_to: compare.value } }),
  w({ title: 'EVA', type: 'kpi', metric_ids: ['eva'], filters: { compare_to: compare.value } }),
]);
const trend = w({ title: 'Ingresos y EBITDA mensual del grupo', type: 'line', metric_ids: ['revenue', 'ebitda'], dimensions: ['period'], size: 'xl' });
const byCompany = w({ title: 'EBITDA por empresa', type: 'bar', metric_ids: ['ebitda'], dimensions: ['company'], sort: { field: 'ebitda', direction: 'desc' } });
const variance = computed(() => w({ title: 'Ingresos: proyección de ejecución vs. presupuesto', type: 'variance', metric_ids: ['revenue'],
  dimensions: ['company'], filters: { version: forecast.value ?? base.value?.code, compare_to: base.value?.code } }));
const companyTable = w({ title: 'Rentabilidad por empresa (base individual)', type: 'table', metric_ids: ['revenue', 'ebitda_margin', 'roic', 'eva'],
  dimensions: ['company'], size: 'xl' });

function q(spec: WidgetSpec) {
  return api.post<SemanticResponse>('/api/semantic/query', {
    metrics: spec.metric_ids, dimensions: spec.dimensions,
    filters: { period: s.period, version: (spec.filters.version as string) ?? 'approved',
      ...(spec.filters.compare_to ? { compare_to: spec.filters.compare_to } : {}) },
    ...(spec.sort ? { sort: spec.sort } : {}),
  });
}

const alerts = useAsync(async () => {
  if (!s.can('quality.review')) return [];
  const out = [];
  for (const v of s.reference?.versions ?? []) {
    const issues = await api.get<Array<{ severity: string }>>(`/api/quality/issues?version_id=${v.id}&status=open`);
    const critical = issues.filter((i) => i.severity === 'critical').length;
    const warning = issues.filter((i) => i.severity === 'warning').length;
    if (critical + warning) out.push({ version: v.code, versionId: v.id, critical, warning });
  }
  return out;
});
</script>
