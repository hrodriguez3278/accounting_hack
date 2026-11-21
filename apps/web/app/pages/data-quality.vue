<template>
  <div>
    <PageHeader eyebrow="Data Quality Engine" title="Calidad de datos" period
                description="Las incidencias críticas bloquean la publicación. Ninguna corrección modifica el archivo original: queda registrada con usuario, motivo y fecha.">
      <label class="text-sm"><span class="sr-only">Versión</span>
        <select v-model="versionId" class="field min-h-10 w-auto"><option v-for="v in s.reference?.versions" :key="v.id" :value="v.id">{{ v.code }}</option></select></label>
      <button v-if="s.me?.all_companies" class="btn-outline" :disabled="revalidating" @click="revalidate">{{ revalidating ? 'Validando…' : 'Revalidar' }}</button>
    </PageHeader>

    <section class="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Resumen">
      <div v-for="k in counters" :key="k.label" class="panel p-4">
        <p class="text-xs font-semibold text-muted">{{ k.label }}</p>
        <p class="mt-1 text-3xl font-bold tabular" :class="k.tone">{{ k.value }}</p>
      </div>
    </section>

    <div class="mt-6 flex flex-wrap items-center gap-2" role="group" aria-label="Filtro de estado">
      <button v-for="f in FILTERS" :key="f.value" class="rounded-full border px-3 py-1.5 text-sm" :aria-pressed="statusFilter === f.value"
              :class="statusFilter === f.value ? 'border-line-strong bg-inverse text-ink-inverse' : 'border-line'" @click="statusFilter = f.value">{{ f.label }}</button>
    </div>

    <StateBlock :loading="issues.loading.value" :error="issues.error.value" :empty="!filtered.length" :retry="issues.run" empty-text="Sin incidencias con este filtro.">
      <div class="panel mt-3 overflow-x-auto">
        <table class="table-base">
          <thead><tr><th>Severidad</th><th>Tipo de incidencia</th><th>Empresa · fila</th><th>Descripción</th><th>Encontrado / esperado</th><th>Estado</th><th class="text-right">Acción</th></tr></thead>
          <tbody>
            <tr v-for="i in filtered" :key="i.id">
              <td><StatusBadge :status="i.severity" /></td>
              <td class="font-semibold">{{ i.rule_name }}</td>
              <td class="whitespace-nowrap">{{ i.company_code ?? '—' }}<span v-if="i.row_number" class="text-muted"> · fila {{ i.row_number }}</span>
                <p v-if="i.file_name" class="max-w-40 truncate text-xs text-muted" :title="i.file_name">{{ i.file_name }}</p></td>
              <td class="max-w-md text-sm">{{ i.description }}<p v-if="i.resolution" class="mt-1 text-xs text-muted">Resolución: {{ i.resolution }} <span v-if="i.resolved_by">({{ i.resolved_by }})</span></p></td>
              <td class="text-xs"><p>{{ i.found_value ?? '—' }}</p><p class="text-muted">{{ i.expected_value ?? '' }}</p></td>
              <td><StatusBadge :status="i.status" /></td>
              <td class="whitespace-nowrap text-right">
                <button v-if="i.normalized_line_id" class="btn-ghost min-h-9 text-xs" @click="lineId = i.normalized_line_id">Ver origen</button>
                <NuxtLink v-if="i.status === 'open' && ['UNMAPPED_ACCOUNT', 'UNKNOWN_ACCOUNT'].includes(i.rule_code) && s.can('mapping.manage')"
                          :to="`/admin?tab=mappings&company=${i.company_code}&account=${encodeURIComponent(i.found_value ?? '')}`" class="btn-outline min-h-9 text-xs">Homologar</NuxtLink>
                <NuxtLink v-else-if="i.status === 'open' && i.rule_code === 'MISSING_FX_RATE' && s.can('rates.manage')" to="/admin?tab=rates" class="btn-outline min-h-9 text-xs">Registrar tasa</NuxtLink>
                <button v-else-if="i.status === 'open' && s.can('quality.resolve')" class="btn-outline min-h-9 text-xs" @click="openResolve(i)">Resolver</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </StateBlock>

    <section class="mt-10" aria-labelledby="ic">
      <h2 id="ic" class="text-lg font-bold">Conciliación intercompañía</h2>
      <StateBlock :loading="ic.loading.value" :error="ic.error.value" :empty="!ic.data.value?.length">
        <div class="panel mt-3 max-h-96 overflow-auto">
          <table class="table-base">
            <thead><tr><th>Referencia</th><th>Periodo</th><th>Vendedor → comprador</th><th class="num">Vendedor (USD)</th><th class="num">Comprador (USD)</th><th class="num">Diferencia</th><th>Estado</th></tr></thead>
            <tbody><tr v-for="m in ic.data.value" :key="m.ic_reference"><td class="font-mono text-xs">{{ m.ic_reference }}</td><td>{{ m.period_code }}</td>
              <td>{{ m.seller ?? '—' }} → {{ m.buyer ?? '—' }}</td><td class="num">{{ fmtNum(m.seller_amount) }}</td><td class="num">{{ fmtNum(m.buyer_amount) }}</td>
              <td class="num">{{ fmtNum(m.difference) }}</td><td><StatusBadge :status="m.status ?? ''" /></td></tr></tbody>
          </table>
        </div>
      </StateBlock>
    </section>

    <!-- Diálogo de resolución -->
    <div v-if="target" class="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="rtitle" @keydown.esc="target = null">
      <form class="panel max-h-[90dvh] w-full max-w-lg overflow-y-auto bg-surface p-6" @submit.prevent="resolve">
        <h2 id="rtitle" class="text-lg font-bold">Resolver incidencia</h2>
        <p class="mt-1 text-sm text-muted">{{ target.description }}</p>
        <fieldset class="mt-4 space-y-2 text-sm">
          <legend class="field-label">Acción</legend>
          <label v-for="a in actionsFor(target)" :key="a.value" class="flex items-start gap-2"><input v-model="action" type="radio" :value="a.value" class="mt-1" />
            <span><strong>{{ a.label }}</strong><br><span class="text-muted">{{ a.help }}</span></span></label>
        </fieldset>
        <template v-if="action === 'correct_field'">
          <label for="cf" class="field-label mt-4">Campo</label>
          <select id="cf" v-model="field" class="field"><option value="currency">Moneda</option><option value="period_code">Periodo (AAAA-MM)</option>
            <option value="counterparty_code">Contraparte IC</option><option value="account_code">Código de cuenta</option>
            <option v-if="s.can('quality.approve')" value="amount">Importe (requiere aprobación)</option></select>
          <label for="cv" class="field-label mt-3">Nuevo valor</label>
          <input id="cv" v-model.trim="value" class="field" :placeholder="field === 'amount' && target.expected_value ? `Sugerido: ${target.expected_value}` : ''" />
        </template>
        <label for="rr" class="field-label mt-4">Motivo (queda en auditoría)</label>
        <textarea id="rr" v-model.trim="reason" class="field min-h-20 py-2" minlength="5" required />
        <p v-if="resolveError" role="alert" class="mt-2 text-sm text-critical">{{ resolveError }}</p>
        <div class="mt-5 flex justify-end gap-2"><button type="button" class="btn-outline" @click="target = null">Cancelar</button>
          <button class="btn-primary" :disabled="!action || reason.length < 5 || saving">{{ saving ? 'Guardando…' : 'Confirmar' }}</button></div>
      </form>
    </div>

    <!-- Origen -->
    <div v-if="lineId" class="fixed inset-0 z-40 flex justify-end bg-black/40" role="dialog" aria-modal="true" aria-label="Origen del registro" @click.self="lineId = null">
      <div class="h-full w-full max-w-xl overflow-y-auto bg-surface p-6">
        <div class="mb-4 flex items-center justify-between"><h2 class="text-lg font-bold">Origen del registro</h2><button class="btn-ghost" @click="lineId = null">Cerrar</button></div>
        <LineChain :line-id="lineId" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Issue { id: string; rule_code: string; rule_name: string; rule_version: number; severity: string; description: string; found_value: string | null;
  expected_value: string | null; status: string; resolution: string | null; resolved_by: string | null; normalized_line_id: string | null; company_code: string | null;
  row_number: number | null; file_name: string | null }
const s = useSessionStore();
const api = useApi();
const route = useRoute();
const versionId = ref<string>((route.query.version as string | undefined) ?? s.reference?.versions.find((v) => !v.published_run_id)?.id ?? s.reference?.versions[0]?.id ?? '');
const statusFilter = ref('open');
const FILTERS = [{ value: 'open', label: 'Abiertas' }, { value: 'all', label: 'Todas' }, { value: 'resolved', label: 'Resueltas' },
  { value: 'accepted', label: 'Aceptadas' }, { value: 'excluded', label: 'Excluidas' }];
const issues = useAsync(() => api.get<Issue[]>(`/api/quality/issues?version_id=${versionId.value}`));
const ic = useAsync(() => api.get<Array<Record<string, string>>>(`/api/quality/ic-matches?version_id=${versionId.value}`));
watch(versionId, () => { issues.run(); ic.run(); });
const filtered = computed(() => (issues.data.value ?? []).filter((i) => statusFilter.value === 'all' || i.status === statusFilter.value));
const open = computed(() => (issues.data.value ?? []).filter((i) => i.status === 'open'));
const counters = computed(() => [
  { label: 'Críticas abiertas', value: open.value.filter((i) => i.severity === 'critical').length, tone: open.value.some((i) => i.severity === 'critical') ? 'text-critical' : '' },
  { label: 'Advertencias abiertas', value: open.value.filter((i) => i.severity === 'warning').length, tone: '' },
  { label: 'Resueltas o aceptadas', value: (issues.data.value ?? []).filter((i) => i.status !== 'open').length, tone: '' },
  { label: 'Conciliaciones IC', value: ic.data.value?.length ?? 0, tone: '' },
]);
const revalidating = ref(false);
async function revalidate() {
  revalidating.value = true;
  try { await api.post('/api/quality/validate', { version_id: versionId.value }); await Promise.all([issues.run(), ic.run()]); } finally { revalidating.value = false; }
}

const target = ref<Issue | null>(null);
const action = ref('');
const field = ref('currency');
const value = ref('');
const reason = ref('');
const saving = ref(false);
const resolveError = ref('');
const lineId = ref<string | null>(null);
function actionsFor(i: Issue) {
  const out = [];
  if (i.normalized_line_id) out.push({ value: 'exclude_line', label: 'Excluir el registro', help: 'Se conserva el original; el registro no participa en la consolidación.' });
  if (i.normalized_line_id && i.rule_code !== 'IC_MISMATCH') out.push({ value: 'correct_field', label: 'Corregir un campo', help: 'Corrección autorizada sobre la capa Silver. Los importes requieren permiso de aprobación.' });
  if (i.severity !== 'critical' && s.can('quality.approve')) out.push({ value: 'accept', label: 'Aceptar advertencia', help: 'Registra una aprobación explícita.' });
  if (i.rule_code === 'IC_MISMATCH' && s.can('quality.approve')) out.push({ value: 'accept_ic_difference', label: 'Aceptar diferencia IC', help: 'Se eliminan ambos lados y la diferencia se registra en la cuenta 8100.' });
  return out;
}
function openResolve(i: Issue) {
  target.value = i; action.value = ''; value.value = ''; reason.value = ''; resolveError.value = '';
  field.value = i.rule_code === 'UNKNOWN_CURRENCY' ? 'currency' : i.rule_code === 'INVALID_PERIOD' ? 'period_code' : i.rule_code === 'INCONSISTENT_SIGN' ? 'amount' : 'currency';
}
async function resolve() {
  saving.value = true;
  resolveError.value = '';
  try {
    const body = action.value === 'correct_field' ? { action: 'correct_field', field: field.value, value: value.value || (field.value === 'amount' ? 'abs' : ''), reason: reason.value }
      : { action: action.value, reason: reason.value };
    await api.post(`/api/quality/issues/${target.value!.id}/resolve`, body);
    target.value = null;
    await Promise.all([issues.run(), ic.run()]);
  } catch (e) { resolveError.value = (e as Error).message; } finally { saving.value = false; }
}
</script>
