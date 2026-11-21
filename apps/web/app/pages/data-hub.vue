<template>
  <div>
    <PageHeader eyebrow="Data Hub" title="Carga de presupuestos" period
                description="Los archivos originales se guardan sin modificaciones en almacenamiento privado (SHA-256). Volver a cargar el mismo archivo y versión no duplica registros." />

    <section v-if="s.can('data.upload')" class="grid grid-cols-1 gap-6 xl:grid-cols-[22rem_minmax(0,1fr)]" aria-labelledby="up">
      <form class="panel space-y-4 p-4" @submit.prevent="upload">
        <h2 id="up" class="text-sm font-bold">1. Archivo</h2>
        <div><label for="co" class="field-label">Empresa</label>
          <select id="co" v-model="companyId" class="field" required><option v-for="c in s.reference?.companies" :key="c.id" :value="c.id">{{ c.code }} · {{ c.name }}</option></select></div>
        <div><label for="ve" class="field-label">Versión presupuestaria</label>
          <select id="ve" v-model="versionId" class="field" required><option v-for="v in s.reference?.versions" :key="v.id" :value="v.id">{{ v.code }} · FY{{ v.fiscal_year }}</option></select></div>
        <div><label for="fi" class="field-label">Archivo CSV o XLSX (máx. 20 MB)</label>
          <input id="fi" type="file" accept=".csv,.xlsx,.txt" class="field py-2" required @change="file = ($event.target as HTMLInputElement).files?.[0] ?? null" /></div>
        <p class="text-xs text-muted">Moneda funcional de la empresa: <strong>{{ company?.functional_currency ?? '—' }}</strong></p>
        <button class="btn-secondary w-full" :disabled="!file || !companyId || !versionId || uploading">{{ uploading ? 'Leyendo…' : 'Previsualizar' }}</button>
        <p v-if="upError" role="alert" class="text-sm text-critical">{{ upError }}</p>
      </form>

      <div v-if="preview" class="panel p-4">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 class="text-sm font-bold">2. Mapeo de columnas · {{ preview.original_name }}</h2>
            <p class="text-xs text-muted">{{ preview.row_count }} filas
              <span v-if="preview.duplicate" class="font-semibold text-warning"> · Este archivo ya existe: se reutilizará sin duplicar</span></p>
          </div>
          <p v-if="preview.saved_mapping" class="text-xs text-success">Mapeo guardado aplicado: {{ preview.saved_mapping.name }}</p>
        </div>
        <fieldset class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <legend class="sr-only">Columnas</legend>
          <div v-for="f in FIELDS" :key="f.key">
            <label :for="`m-${f.key}`" class="field-label">{{ f.label }}<span v-if="f.required" class="font-normal text-muted"> (obligatorio)</span></label>
            <select :id="`m-${f.key}`" v-model="mapping.columns[f.key]" class="field">
              <option value="">— Sin mapear —</option>
              <option v-for="h in preview.headers" :key="h" :value="h">{{ h }}</option>
            </select>
          </div>
          <div><label for="pf" class="field-label">Formato de periodo</label>
            <select id="pf" v-model="mapping.period_format" class="field"><option>YYYY-MM</option><option>YYYYMM</option><option>MM/YYYY</option><option>MON-YYYY</option></select></div>
          <div><label for="ds" class="field-label">Separador decimal</label>
            <select id="ds" v-model="mapping.decimal_separator" class="field"><option value=".">Punto (1234.56)</option><option value=",">Coma (1234,56)</option></select></div>
          <div><label for="ts" class="field-label">Separador de miles</label>
            <select id="ts" v-model="mapping.thousands_separator" class="field"><option value="">Ninguno</option><option value=",">Coma</option><option value=".">Punto</option><option value=" ">Espacio</option></select></div>
          <div v-if="isCsv"><label for="dl" class="field-label">Delimitador</label>
            <select id="dl" v-model="mapping.delimiter" class="field"><option value=",">Coma</option><option value=";">Punto y coma</option><option value="	">Tabulador</option><option value="|">Barra</option></select></div>
        </fieldset>
        <div class="mt-4 flex flex-wrap items-end gap-3">
          <div class="min-w-60 flex-1"><label for="sv" class="field-label">Guardar mapeo como (reutilizable para la empresa)</label>
            <input id="sv" v-model.trim="saveAs" class="field" maxlength="80" placeholder="p. ej. Formato contable 2027" /></div>
          <button class="btn-primary" :disabled="importing || missingRequired.length > 0" @click="importBatch">{{ importing ? 'Procesando…' : '3. Importar' }}</button>
        </div>
        <p v-if="missingRequired.length" class="mt-2 text-sm text-critical">Falta mapear: {{ missingRequired.join(', ') }}</p>
        <p v-if="importMsg" role="status" class="mt-2 text-sm" :class="importErr ? 'text-critical' : 'text-success'">{{ importMsg }}</p>

        <h3 class="mt-6 text-sm font-bold">Vista previa (datos originales, sin transformar)</h3>
        <div class="mt-2 max-h-80 overflow-auto">
          <table class="table-base text-xs">
            <thead><tr><th v-for="h in preview.headers" :key="h">{{ h }}</th></tr></thead>
            <tbody><tr v-for="(r, i) in preview.preview" :key="i"><td v-for="h in preview.headers" :key="h" class="whitespace-nowrap">{{ r[h] }}</td></tr></tbody>
          </table>
        </div>
      </div>
      <div v-else class="hidden rounded-ui border border-dashed border-line p-8 text-sm text-muted xl:block">Seleccione un archivo para revisar sus columnas antes de importar.</div>
    </section>

    <section class="mt-10" aria-labelledby="hist">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <h2 id="hist" class="text-lg font-bold">Historial de cargas</h2>
        <label class="text-sm"><span class="sr-only">Filtrar por versión</span>
          <select v-model="histVersion" class="field min-h-10 w-auto"><option value="">Todas las versiones</option><option v-for="v in s.reference?.versions" :key="v.id" :value="v.id">{{ v.code }}</option></select></label>
      </div>
      <StateBlock :loading="hist.loading.value" :error="hist.error.value" :empty="!hist.data.value?.length" :retry="hist.run">
        <div class="panel mt-3 max-h-[32rem] overflow-auto">
          <table class="table-base">
            <thead><tr><th>Fecha</th><th>Empresa</th><th>Versión</th><th>Archivo</th><th class="num">Filas</th><th>Estado</th><th>Usuario</th></tr></thead>
            <tbody>
              <tr v-for="b in hist.data.value" :key="b.id">
                <td class="whitespace-nowrap text-xs">{{ fmtDate(b.created_at) }}</td>
                <td class="font-semibold">{{ b.company_code }}</td><td>{{ b.version_code }}</td>
                <td><p class="max-w-56 truncate" :title="b.original_name">{{ b.original_name }}</p></td>
                <td class="num">{{ b.processed_rows }} / {{ b.row_count ?? '—' }}</td>
                <td><StatusBadge :status="b.status" /><p v-if="b.error" class="mt-1 max-w-56 text-xs text-critical">{{ b.error }}</p></td>
                <td class="text-xs text-muted">{{ b.created_by }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </StateBlock>
    </section>
  </div>
</template>

<script setup lang="ts">
interface Preview { source_file_id: string; duplicate: boolean; original_name: string; sha256: string; headers: string[]; preview: Array<Record<string, string>>;
  row_count: number; suggested_mapping: Record<string, string>; saved_mapping: { name: string; config: Mapping } | null }
interface Mapping { columns: Record<string, string>; period_format: string; decimal_separator: string; thousands_separator: string; delimiter?: string; sheet?: string }
const s = useSessionStore();
const api = useApi();
const FIELDS = [
  { key: 'account_code', label: 'Código de cuenta', required: true }, { key: 'account_name', label: 'Nombre de cuenta' },
  { key: 'period', label: 'Periodo', required: true }, { key: 'amount', label: 'Importe', required: true }, { key: 'currency', label: 'Moneda' },
  { key: 'counterparty_code', label: 'Contraparte IC' }, { key: 'ic_reference', label: 'Referencia IC' }, { key: 'company_code', label: 'Empresa (columna)' },
];
const companyId = ref(s.reference?.companies[0]?.id ?? '');
const versionId = ref(s.reference?.versions[0]?.id ?? '');
const company = computed(() => s.reference?.companies.find((c) => c.id === companyId.value));
const file = ref<File | null>(null);
const uploading = ref(false);
const upError = ref('');
const preview = ref<Preview | null>(null);
const mapping = reactive<Mapping>({ columns: {}, period_format: 'YYYY-MM', decimal_separator: '.', thousands_separator: '', delimiter: ',' });
const saveAs = ref('');
const importing = ref(false);
const importMsg = ref('');
const importErr = ref(false);
const isCsv = computed(() => !preview.value?.original_name.toLowerCase().endsWith('.xlsx'));
const missingRequired = computed(() => FIELDS.filter((f) => f.required && !mapping.columns[f.key]).map((f) => f.label));
const histVersion = ref('');
const hist = useAsync(() => api.get<Array<{ id: string; created_at: string; company_code: string; version_code: string; original_name: string; sha256: string;
  processed_rows: number; row_count: number | null; status: string; error: string | null; created_by: string }>>(`/api/data-hub/batches${histVersion.value ? `?version_id=${histVersion.value}` : ''}`));
watch(histVersion, () => hist.run());

async function upload() {
  if (!file.value) return;
  uploading.value = true;
  upError.value = '';
  importMsg.value = '';
  try {
    const fd = new FormData();
    fd.append('company_id', companyId.value);
    fd.append('file', file.value);
    const p = await api.upload<Preview>('/api/data-hub/upload', fd);
    preview.value = p;
    const cfg = p.saved_mapping?.config;
    const valid = cfg && Object.values(cfg.columns).every((c) => !c || p.headers.includes(c));
    if (valid && cfg) Object.assign(mapping, JSON.parse(JSON.stringify(cfg)));
    else {
      mapping.columns = { ...p.suggested_mapping };
      const sample = p.preview[0]?.[p.suggested_mapping.period ?? ''] ?? '';
      mapping.period_format = /^\d{4}-\d{2}$/.test(sample) ? 'YYYY-MM' : /^\d{6}$/.test(sample) ? 'YYYYMM' : /^\d{2}\/\d{4}$/.test(sample) ? 'MM/YYYY' : /^[A-Za-z]{3}-\d{4}$/.test(sample) ? 'MON-YYYY' : 'YYYY-MM';
      const amt = p.preview[0]?.[p.suggested_mapping.amount ?? ''] ?? '';
      if (/\d,\d{2}$/.test(amt)) { mapping.decimal_separator = ','; mapping.thousands_separator = '.'; mapping.delimiter = ';'; }
    }
  } catch (e) { upError.value = (e as Error).message; } finally { uploading.value = false; }
}

async function importBatch() {
  importing.value = true;
  importMsg.value = '';
  try {
    const cols = Object.fromEntries(Object.entries(mapping.columns).filter(([, v]) => v));
    const body = { company_id: companyId.value, budget_version_id: versionId.value, source_file_id: preview.value!.source_file_id,
      mapping: { ...mapping, columns: cols, ...(isCsv.value ? {} : { delimiter: undefined }) }, ...(saveAs.value ? { save_mapping_as: saveAs.value } : {}) };
    const b = await api.post<{ id: string; status: string; reused: boolean; row_count: number }>('/api/data-hub/batches?wait=1', body);
    importErr.value = b.status === 'failed';
    importMsg.value = b.reused ? 'Este archivo ya estaba cargado para la versión: no se duplicaron registros.'
      : b.status === 'processed' ? `Carga procesada (${b.row_count} filas) y validada. Revise Calidad de datos.` : `Estado de la carga: ${STATUS_LABEL[b.status] ?? b.status}`;
    hist.run();
  } catch (e) { importErr.value = true; importMsg.value = (e as Error).message; } finally { importing.value = false; }
}
</script>
