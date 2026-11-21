<template>
  <div>
    <PageHeader eyebrow="Audit & Lineage" title="Trazabilidad" period
                description="De cada cifra hasta su origen: indicador → consolidación → movimientos → registro → fila original → archivo cargado." />
    <div class="mb-6 flex flex-wrap gap-2" role="tablist" aria-label="Secciones">
      <button v-for="t in tabs" :key="t.id" role="tab" :aria-selected="tab === t.id" class="rounded-full border px-3 py-1.5 text-sm"
              :class="tab === t.id ? 'border-line-strong bg-inverse text-ink-inverse' : 'border-line'" @click="tab = t.id">{{ t.label }}</button>
    </div>

    <!-- Trazabilidad de una cifra -->
    <section v-if="tab === 'lineage'" role="tabpanel">
      <form class="grid grid-cols-1 items-end gap-3 sm:flex sm:flex-wrap" @submit.prevent="loadLineage">
        <label><span class="field-label">Consolidación</span>
          <select v-model="runId" class="field sm:w-72"><option v-for="r in runs.data.value?.filter((x) => x.inputs_hash)" :key="r.id" :value="r.id">{{ r.version_code }} · {{ STATUS_LABEL[r.status] }} · {{ fmtDate(r.created_at) }}</option></select></label>
        <label><span class="field-label">Métrica</span>
          <select v-model="metric" class="field sm:w-52"><option v-for="m in catalog.data.value?.metrics.filter((x) => x.code !== 'fx_effect')" :key="m.code" :value="m.code">{{ m.name }}</option></select></label>
        <label><span class="field-label">Ámbito</span>
          <select v-model="company" class="field sm:w-48"><option value="">Grupo consolidado</option><option v-for="c in s.reference?.companies" :key="c.code" :value="c.code">{{ c.code }}</option></select></label>
        <button class="btn-secondary" :disabled="!runId">Rastrear</button>
      </form>

      <StateBlock :loading="lin.loading.value" :error="lin.error.value">
        <div v-if="l" class="mt-6 space-y-6">
          <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div class="panel p-4">
              <p class="eyebrow">Métrica certificada</p>
              <p class="mt-1 text-lg font-bold">{{ l.metric.name }}</p>
              <p class="mt-3 text-2xl font-bold tabular">{{ l.result?.status === 'calculated' ? fmtValue(l.result.value, l.metric.unit, s.currency) : 'No calculable' }}</p>
              <p v-if="l.result?.missing?.length" class="mt-1 text-xs text-critical">Falta: {{ l.result.missing.join('; ') }}</p>
              <dl v-if="l.result && Object.keys(l.result.components).length" class="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                <template v-for="(v, k) in l.result.components" :key="k">
                  <dt class="text-muted">{{ COMPONENT_LABEL[k] ?? k }}</dt>
                  <dd class="tabular text-right">{{ v === null ? '—' : isRatioComponent(String(k)) ? fmtPct(v) : fmtMoney(v, s.currency) }}</dd>
                </template>
              </dl>
            </div>
            <div class="panel p-4">
              <p class="eyebrow">Consolidación</p>
              <p class="mt-1 font-semibold">{{ l.run.version_name }}</p>
              <p class="mt-1"><StatusBadge :status="l.run.status" /></p>
              <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt class="text-muted">Calculada</dt><dd>{{ fmtDate(l.run.finished_at) }}</dd>
                <dt class="text-muted">Publicada</dt><dd>{{ l.run.published_at ? fmtDate(l.run.published_at) : 'Pendiente' }}</dd>
                <dt class="text-muted">Responsable</dt><dd>{{ l.run.created_by_name ?? '—' }}</dd>
              </dl>
            </div>
            <div class="panel p-4">
              <p class="eyebrow">Archivos fuente ({{ l.files.length }})</p>
              <ul class="mt-2 space-y-2 text-sm">
                <li v-for="f in l.files" :key="f.file_id"><p class="font-semibold">{{ f.company_code }}</p><p class="break-all text-muted">{{ f.original_name }} · {{ f.row_count }} filas · {{ fmtDate(f.uploaded_at) }}</p></li>
              </ul>
              <p v-if="!l.lineage_complete" class="mt-3 text-xs text-critical">{{ l.lineage_note }}</p>
            </div>
          </div>

          <div class="panel overflow-x-auto">
            <table class="table-base">
              <caption class="px-3 pt-3 text-left text-sm font-bold">Saldos por cuenta y empresa (moneda del grupo)</caption>
              <thead><tr><th>Cuenta</th><th>Empresa</th><th class="num">Convertido</th><th class="num">Eliminaciones IC</th><th class="num">Ajuste por conversión</th><th class="num">Ajustes</th><th class="num">Total</th><th /></tr></thead>
              <tbody>
                <tr v-for="a in relevantAccounts" :key="a.code + a.company_code">
                  <td><span class="font-semibold">{{ a.code }}</span> {{ a.name }}</td><td>{{ a.company_code }}</td>
                  <td class="num">{{ fmtNum(a.translated, 0) }}</td><td class="num">{{ fmtNum(a.elimination, 0) }}</td><td class="num">{{ fmtNum(a.cta, 0) }}</td>
                  <td class="num">{{ fmtNum(a.adjustment, 0) }}</td><td class="num font-semibold">{{ fmtNum(a.total, 0) }}</td>
                  <td><button class="btn-ghost min-h-8 text-xs" @click="openEntries(a.code, a.company_code)">Asientos</button></td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-if="entries.data.value" class="panel overflow-x-auto">
            <table class="table-base text-xs">
              <caption class="px-3 pt-3 text-left text-sm font-bold">Asientos · {{ entryFilter.account }} · {{ entryFilter.company }}</caption>
              <thead><tr><th>Movimiento</th><th>Periodo</th><th class="num">Moneda local</th><th>Tipo de cambio</th><th class="num">{{ s.currency }}</th><th /></tr></thead>
              <tbody><tr v-for="e in entries.data.value" :key="e.id">
                <td>{{ ENTRY_LABEL[e.entry_type] ?? e.entry_type }}</td><td>{{ e.period_code }}</td><td class="num">{{ e.local_amount ? `${fmtNum(e.local_amount)} ${e.local_currency}` : '—' }}</td>
                <td class="whitespace-nowrap">{{ e.rate ? `${fmtNum(e.rate, 4)} (${RATE_LABEL[e.rate_type] ?? e.rate_type})` : '—' }}</td><td class="num">{{ fmtNum(e.group_amount) }}</td>
                <td><button v-if="e.source_line_id" class="btn-ghost min-h-8 text-xs" @click="lineId = e.source_line_id">Origen</button></td>
              </tr></tbody>
            </table>
          </div>
        </div>
      </StateBlock>
    </section>

    <section v-if="tab === 'queries'" role="tabpanel">
      <StateBlock :loading="query.loading.value" :error="query.error.value" :empty="!query.data.value" empty-text="Abra una evidencia desde el analista para ver la consulta.">
        <div v-if="query.data.value" class="panel p-4 text-sm">
          <p class="eyebrow">Consulta de datos que respalda la respuesta</p>
          <dl class="mt-2 grid grid-cols-1 gap-y-1 sm:grid-cols-[10rem_1fr]">
            <dt class="text-muted">Indicadores</dt><dd class="font-semibold">{{ (query.data.value.request.metrics ?? []).map(metricName).join(', ') || '—' }}</dd>
            <dt class="text-muted">Versión</dt><dd>{{ query.data.value.request.filters?.version === 'approved' ? 'Presupuesto publicado vigente' : query.data.value.request.filters?.version ?? '—' }}<template v-if="query.data.value.request.filters?.compare_to"> · comparada con {{ query.data.value.request.filters.compare_to }}</template></dd>
            <dt class="text-muted">Ejercicio</dt><dd>{{ query.data.value.request.filters?.period ?? '—' }}</dd>
            <dt class="text-muted">Desglose</dt><dd>{{ (query.data.value.request.dimensions ?? []).map((d: string) => DIM[d] ?? d).join(', ') || 'Total del grupo' }}</dd>
            <dt class="text-muted">Solicitada por</dt><dd>{{ query.data.value.user_name }} · {{ SOURCE[query.data.value.source] ?? query.data.value.source }}</dd>
            <dt class="text-muted">Fecha</dt><dd>{{ fmtDate(query.data.value.created_at) }}</dd>
          </dl>
          <button v-if="query.data.value.run_ids[0]" class="btn-outline mt-3" @click="runId = query.data.value.run_ids[0]; metric = query.data.value.request.metrics?.[0] ?? 'revenue'; tab = 'lineage'; loadLineage()">Rastrear cifra</button>
        </div>
      </StateBlock>
    </section>

    <section v-if="tab === 'events' || tab === 'approvals'" role="tabpanel">
      <StateBlock :loading="log.loading.value" :error="log.error.value" :empty="!log.data.value?.length">
        <div class="panel max-h-[36rem] overflow-auto">
          <table class="table-base text-xs">
            <thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Entidad</th><th>Detalle</th></tr></thead>
            <tbody><tr v-for="e in log.data.value" :key="e.id">
              <td class="whitespace-nowrap">{{ fmtDate(e.created_at) }}</td><td>{{ e.user_name ?? '—' }}</td><td class="font-semibold">{{ ACTION[e.action] ?? e.action }}</td>
              <td>{{ ENTITY[e.entity_type] ?? e.entity_type }}</td>
              <td class="max-w-md">{{ e.reason ?? detailText(e.details) }}{{ e.from_status ? ` (${STATUS_LABEL[e.from_status] ?? e.from_status} → ${STATUS_LABEL[e.to_status] ?? e.to_status})` : '' }}</td>
            </tr></tbody>
          </table>
        </div>
      </StateBlock>
    </section>

    <div v-if="lineId" class="fixed inset-0 z-40 flex justify-end bg-black/40" role="dialog" aria-modal="true" aria-label="Origen del registro" @click.self="lineId = null">
      <div class="h-full w-full max-w-xl overflow-y-auto bg-surface p-6">
        <div class="mb-4 flex items-center justify-between"><h2 class="text-lg font-bold">Origen del registro</h2><button class="btn-ghost" @click="lineId = null">Cerrar</button></div>
        <LineChain :line-id="lineId" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const s = useSessionStore();
const api = useApi();
const route = useRoute();
const { metricName } = useCatalog();
const DIM: Record<string, string> = { company: 'por empresa', country: 'por país', period: 'por mes', account: 'por cuenta' };
const SOURCE: Record<string, string> = { ui: 'pantalla', ai: 'asistente de IA', dashboard: 'dashboard', api: 'integración', test: 'prueba' };
const ENTITY: Record<string, string> = { source_file: 'Archivo', ingestion_batch: 'Carga', validation_issue: 'Incidencia', consolidation_run: 'Consolidación',
  account_mapping: 'Homologación', exchange_rate: 'Tasa de cambio', dashboard: 'Dashboard', scenario: 'Escenario', intercompany: 'Intercompañía',
  normalized_line: 'Registro' };
const ACTION: Record<string, string> = { 'file.upload': 'Archivo cargado', 'file.duplicate_upload': 'Archivo repetido', 'batch.create': 'Carga creada',
  'batch.reuse': 'Carga reutilizada', 'issue.exclude_line': 'Registro excluido', 'issue.correct_field': 'Registro corregido',
  'consolidation.start': 'Consolidación iniciada', 'consolidation.ready': 'Consolidación lista', approve: 'Aprobación', publish: 'Publicación',
  approve_mapping: 'Homologación aprobada', approve_rate: 'Tasa aprobada', accept_warning: 'Advertencia aceptada',
  accept_ic_difference: 'Diferencia IC aceptada', approve_amount_correction: 'Corrección de importe aprobada', 'scenario.create': 'Escenario creado',
  'dashboard.user_change': 'Dashboard modificado', 'dashboard.ai_change': 'Dashboard modificado por IA', 'dashboard.restore_change': 'Dashboard restaurado',
  'dashboard.system_change': 'Dashboard creado', 'dashboard.share': 'Dashboard compartido', 'dashboard.archive': 'Dashboard eliminado' };
function detailText(d: Record<string, unknown> | null) {
  if (!d) return '';
  if (typeof d.summary === 'string') return d.summary;
  if (typeof d.reason === 'string') return d.reason;
  if (typeof d.version === 'string') return `Versión ${d.version}`;
  if (typeof d.field === 'string') return `${d.field}: ${d.from ?? '∅'} → ${d.to ?? '∅'}`;
  return '';
}
const tabs = computed(() => [{ id: 'lineage', label: 'Trazabilidad de cifras' }, { id: 'queries', label: 'Consultas' },
  ...(s.can('audit.read') ? [{ id: 'events', label: 'Eventos' }, { id: 'approvals', label: 'Aprobaciones' }] : [])]);
const tab = ref((route.query.tab as string) ?? 'lineage');
const runId = ref((route.query.run as string) ?? '');
const metric = ref((route.query.metric as string) ?? 'revenue');
const company = ref('');
const lineId = ref<string | null>(null);
const runs = useAsync(() => api.get<Array<{ id: string; version_code: string; status: string; inputs_hash: string | null; created_at: string }>>('/api/consolidation/runs'));
const catalog = useAsync(() => api.get<{ metrics: Array<{ code: string; name: string }> }>('/api/semantic/catalog'));
const lin = useAsync(() => api.get<any>(`/api/lineage/metric?run_id=${runId.value}&metric=${metric.value}${company.value ? `&company=${company.value}` : ''}`), { immediate: false }); // eslint-disable-line @typescript-eslint/no-explicit-any
const l = computed(() => lin.data.value);
const entryFilter = reactive({ account: '', company: '' });
const entries = useAsync(() => api.get<any[]>(`/api/lineage/entries?run_id=${runId.value}&account=${entryFilter.account}&company=${entryFilter.company}&limit=200`), { immediate: false }); // eslint-disable-line @typescript-eslint/no-explicit-any
const query = useAsync(async () => (route.query.query ? api.get<any>(`/api/audit/queries/${route.query.query}`) : null)); // eslint-disable-line @typescript-eslint/no-explicit-any
const log = useAsync(async () => (tab.value === 'events' ? api.get<any[]>('/api/audit/events?limit=300') : tab.value === 'approvals' ? api.get<any[]>('/api/audit/approvals') : [])); // eslint-disable-line @typescript-eslint/no-explicit-any
watch(tab, () => log.run());

const CATS: Record<string, string[]> = { revenue: ['revenue'], costs: ['cogs'], opex: ['opex'], ebitda: ['revenue', 'cogs', 'opex'], ebit: ['revenue', 'cogs', 'opex', 'da'],
  net_income: ['revenue', 'cogs', 'opex', 'da', 'interest', 'other', 'tax'], ic_elimination_impact: ['revenue'], revenue_share: ['revenue'] };
const relevantAccounts = computed(() => {
  const cats = CATS[metric.value];
  return (l.value?.accounts ?? []).filter((a: { category: string }) => !cats || cats.includes(a.category));
});
function loadLineage() { entries.data.value = null; lin.run(); }
function openEntries(account: string, comp: string) { entryFilter.account = account; entryFilter.company = comp; entries.run(); }
onMounted(() => { if (runId.value) loadLineage(); });
watch(() => runs.data.value, (r) => { if (!runId.value && r?.length) runId.value = r.find((x) => x.status === 'published')?.id ?? r[0]!.id; });
</script>
