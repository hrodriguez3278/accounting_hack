<template>
  <StateBlock :loading="chain.loading.value" :error="chain.error.value" :retry="chain.run">
    <ol v-if="c" class="space-y-4 text-sm">
      <li class="border-l-2 border-line-strong pl-3">
        <p class="eyebrow">Registro procesado</p>
        <dl class="mt-1 grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[9rem_1fr]">
          <dt class="text-muted">Empresa</dt><dd>{{ c.line.company_code }} · {{ c.line.company_name }}</dd>
          <dt class="text-muted">Cuenta</dt><dd>{{ c.line.account_code }} → {{ c.line.group_account_code ?? 'sin homologar' }} {{ c.line.group_account_name ?? '' }}</dd>
          <dt class="text-muted">Periodo</dt><dd>{{ c.line.period_code ?? '—' }} <span class="text-muted">(origen: {{ c.line.period_raw }})</span></dd>
          <dt class="text-muted">Importe</dt><dd class="tabular">{{ fmtNum(c.line.amount, 2) }} {{ c.line.currency }} <span class="text-muted">(origen: {{ c.line.amount_raw }})</span></dd>
          <dt class="text-muted">Estado</dt><dd><StatusBadge :status="c.line.status" /> <span v-if="c.line.exclusion_reason" class="text-muted">{{ c.line.exclusion_reason }}</span></dd>
        </dl>
        <ul v-if="c.line.corrections?.length" class="mt-2 space-y-1 text-xs">
          <li v-for="(k, i) in c.line.corrections" :key="i" class="rounded-ui bg-warning-bg px-2 py-1 text-warning">
            {{ k.action === 'exclude' ? 'Excluido' : `Corrección de ${k.field}: ${k.from ?? '∅'} → ${k.to ?? '∅'}` }} · {{ fmtDate(k.at) }} · {{ k.reason }}
          </li>
        </ul>
      </li>
      <li class="border-l-2 border-line-strong pl-3">
        <p class="eyebrow">Fila original del archivo (sin modificaciones) · fila {{ c.raw_row?.row_number }}</p>
        <table class="table-base mt-1 text-xs"><tbody>
          <tr v-for="(v, k) in c.raw_row?.data" :key="k"><th scope="row" class="w-40 border-b border-line px-2 py-1.5 text-left font-semibold">{{ k }}</th><td class="break-all">{{ v }}</td></tr>
        </tbody></table>
      </li>
      <li class="border-l-2 border-line-strong pl-3">
        <p class="eyebrow">Archivo fuente</p>
        <p class="mt-1 break-all font-semibold">{{ c.batch?.original_name }}</p>
        <p class="text-xs text-muted">Cargado {{ fmtDate(c.batch?.uploaded_at) }} por {{ c.batch?.uploaded_by ?? '—' }} · versión {{ c.batch?.version_code }}</p>
      </li>
      <li v-if="c.issues.length" class="border-l-2 border-line pl-3">
        <p class="eyebrow">Incidencias</p>
        <ul class="mt-1 space-y-1"><li v-for="i in c.issues" :key="i.id"><StatusBadge :status="i.status" /> {{ i.description }}</li></ul>
      </li>
      <li v-if="c.entries.length" class="border-l-2 border-line pl-3">
        <p class="eyebrow">Asientos de consolidación que lo usan</p>
        <div class="overflow-x-auto"><table class="table-base mt-1 text-xs">
          <thead><tr><th>Movimiento</th><th>Tipo de cambio</th><th class="num">Moneda del grupo</th><th>Consolidación</th></tr></thead>
          <tbody><tr v-for="e in c.entries" :key="e.id"><td>{{ ENTRY_LABEL[e.entry_type] ?? e.entry_type }}</td><td>{{ e.rate ? `${fmtNum(e.rate, 4)} (${RATE_LABEL[e.rate_type] ?? e.rate_type})` : '—' }}</td>
            <td class="num">{{ fmtNum(e.group_amount, 2) }}</td><td><StatusBadge :status="e.run_status" /></td></tr></tbody>
        </table></div>
      </li>
    </ol>
  </StateBlock>
</template>

<script setup lang="ts">
const props = defineProps<{ lineId: string }>();
const api = useApi();
const chain = useAsync(() => api.get<any>(`/api/lineage/line/${props.lineId}`)); // eslint-disable-line @typescript-eslint/no-explicit-any
const c = computed(() => chain.data.value);
watch(() => props.lineId, () => chain.run());
</script>
