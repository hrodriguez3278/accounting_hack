<template>
  <div>
    <PageHeader eyebrow="Administración" title="Configuración del grupo" period description="Catálogos, homologación, tasas de cambio aprobadas, parámetros financieros y accesos." />
    <div class="mb-6 flex flex-wrap gap-2" role="tablist">
      <button v-for="t in tabs" :key="t.id" role="tab" :aria-selected="tab === t.id" class="rounded-full border px-3 py-1.5 text-sm"
              :class="tab === t.id ? 'border-line-strong bg-inverse text-ink-inverse' : 'border-line'" @click="tab = t.id">{{ t.label }}</button>
    </div>

    <!-- Homologación -->
    <section v-if="tab === 'mappings'" role="tabpanel">
      <label class="text-sm"><span class="field-label">Empresa</span>
        <select v-model="mapCompany" class="field sm:w-80"><option v-for="c in s.reference?.companies" :key="c.code" :value="c.code">{{ c.code }} · {{ c.name }}</option></select></label>
      <StateBlock :loading="maps.loading.value" :error="maps.error.value" :empty="!maps.data.value?.length">
        <div class="panel mt-4 max-h-[36rem] overflow-auto">
          <table class="table-base">
            <thead><tr><th>Cuenta de la empresa</th><th>Cuenta corporativa</th><th>Estado</th><th class="text-right">Homologar</th></tr></thead>
            <tbody><tr v-for="m in maps.data.value" :key="m.company_account_code" :class="m.company_account_code === route.query.account ? 'bg-warning-bg' : ''">
              <td><span class="font-mono">{{ m.company_account_code }}</span> {{ m.company_account_name }}</td>
              <td>{{ m.account_code ? `${m.account_code} · ${m.account_name}` : 'Sin homologar' }}</td>
              <td><StatusBadge :status="m.status === 'approved' ? 'approved' : 'unmatched'" /></td>
              <td class="text-right">
                <form v-if="s.can('mapping.manage')" class="inline-flex gap-2" @submit.prevent="map(m.company_account_code, ($event.target as HTMLFormElement).acct.value)">
                  <select name="acct" class="field min-h-9 w-56 text-xs" :aria-label="`Cuenta corporativa para ${m.company_account_code}`">
                    <option v-for="a in s.reference?.accounts.filter((x) => !x.consolidation_only)" :key="a.code" :value="a.code" :selected="a.code === m.account_code">{{ a.code }} · {{ a.name }}</option>
                  </select>
                  <button class="btn-outline min-h-9 text-xs">Aprobar</button>
                </form>
              </td></tr></tbody>
          </table>
        </div>
      </StateBlock>
      <p v-if="mapMsg" role="status" class="mt-2 text-sm">{{ mapMsg }}</p>
    </section>

    <!-- Tasas -->
    <section v-if="tab === 'rates'" role="tabpanel" class="grid grid-cols-1 gap-6 xl:grid-cols-[22rem_minmax(0,1fr)]">
      <form v-if="s.can('rates.manage')" class="panel space-y-3 p-4" @submit.prevent="addRate">
        <h2 class="text-sm font-bold">Registrar tasa aprobada</h2>
        <p class="text-xs text-muted">Nunca se inventan tasas: registre la fuente. Queda como evento de aprobación.</p>
        <div class="grid grid-cols-2 gap-3">
          <label><span class="field-label">De</span><select v-model="rate.from_currency" class="field"><option v-for="c in s.reference?.currencies" :key="c.code">{{ c.code }}</option></select></label>
          <label><span class="field-label">A</span><select v-model="rate.to_currency" class="field"><option v-for="c in s.reference?.currencies" :key="c.code">{{ c.code }}</option></select></label>
        </div>
        <label class="block"><span class="field-label">Tipo</span><select v-model="rate.rate_type" class="field"><option value="average">Promedio (resultados)</option><option value="closing">Cierre (balance)</option><option value="historical">Histórica (patrimonio)</option></select></label>
        <label v-if="rate.rate_type !== 'historical'" class="block"><span class="field-label">Periodo (AAAA-MM)</span><input v-model.trim="rate.period_code" class="field" pattern="\d{4}-(0[1-9]|1[0-2])" required /></label>
        <label class="block"><span class="field-label">Escenario de tasas</span><select v-model="rate.scenario" class="field"><option v-for="sc in scenarios" :key="sc">{{ sc }}</option></select></label>
        <label class="block"><span class="field-label">Tasa ({{ rate.to_currency }} por 1 {{ rate.from_currency }})</span><input v-model.trim="rate.rate" class="field tabular" inputmode="decimal" required /></label>
        <label class="block"><span class="field-label">Fuente</span><input v-model.trim="rate.source" class="field" minlength="3" required placeholder="p. ej. Banco central, supuesto aprobado del comité" /></label>
        <p v-if="rateMsg" role="status" class="text-sm" :class="rateErr ? 'text-critical' : 'text-success'">{{ rateMsg }}</p>
        <button class="btn-primary w-full">Registrar</button>
      </form>
      <StateBlock :loading="rates.loading.value" :error="rates.error.value" :empty="!rates.data.value?.length">
        <div class="panel max-h-[40rem] overflow-auto">
          <table class="table-base text-xs">
            <thead><tr><th>Escenario</th><th>Monedas</th><th>Tipo</th><th>Periodo</th><th class="num">Tasa</th><th>Fuente</th><th>Estado</th></tr></thead>
            <tbody><tr v-for="r in rates.data.value" :key="r.id"><td>{{ r.scenario }}</td><td>{{ r.from_currency }} → {{ r.to_currency }}</td><td>{{ RATE_LABEL[r.rate_type] ?? r.rate_type }}</td>
              <td>{{ r.period_code ?? '—' }}</td><td class="num">{{ fmtNum(r.rate, 6) }}</td><td class="max-w-48 truncate">{{ r.source }}</td><td><StatusBadge :status="r.status" /></td></tr></tbody>
          </table>
        </div>
      </StateBlock>
    </section>

    <!-- Parámetros -->
    <section v-if="tab === 'parameters'" role="tabpanel">
      <StateBlock :loading="params.loading.value" :error="params.error.value" :empty="!params.data.value?.length">
        <div class="panel overflow-x-auto"><table class="table-base">
          <thead><tr><th>Ejercicio</th><th>Parámetro</th><th class="num">Valor</th><th>Estado</th></tr></thead>
          <tbody><tr v-for="p in params.data.value" :key="p.code + p.fiscal_year"><td>{{ p.fiscal_year }}</td><td>{{ PARAMETER_LABEL[p.code] ?? p.description }}</td><td class="num">{{ p.code === 'ic_tolerance_abs' ? fmtMoney(p.value, s.currency) : fmtPct(p.value, 2) }}</td><td><StatusBadge :status="p.status" /></td></tr></tbody>
        </table></div>
      </StateBlock>
    </section>

    <!-- Miembros -->
    <section v-if="tab === 'members'" role="tabpanel">
      <StateBlock :loading="members.loading.value" :error="members.error.value" :empty="!members.data.value?.length">
        <div class="panel overflow-x-auto"><table class="table-base">
          <thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Acceso</th></tr></thead>
          <tbody><tr v-for="m in members.data.value" :key="m.user_id"><td class="font-semibold">{{ m.full_name }}</td><td>{{ m.email }}</td><td>{{ ROLE[m.role_code] ?? m.role_code }}</td>
            <td>{{ m.all_companies ? 'Todas las empresas' : m.companies.join(', ') }}</td></tr></tbody>
        </table></div>
      </StateBlock>
    </section>
  </div>
</template>

<script setup lang="ts">
const s = useSessionStore();
const api = useApi();
const route = useRoute();
const ROLE: Record<string, string> = { super_admin: 'Super administrador', org_admin: 'Administrador', financial_admin: 'Administración financiera',
  director: 'Dirección', financial_analyst: 'Analista financiero', auditor: 'Auditor', viewer: 'Consulta' };
const tabs = computed(() => [{ id: 'mappings', label: 'Homologación de cuentas' }, { id: 'rates', label: 'Tasas de cambio' },
  { id: 'parameters', label: 'Parámetros financieros' }, ...(s.can('org.admin') ? [{ id: 'members', label: 'Miembros y accesos' }] : [])]);
const tab = ref((route.query.tab as string) ?? 'mappings');
const mapCompany = ref((route.query.company as string) ?? s.reference?.companies[0]?.code ?? '');
const companyId = computed(() => s.reference?.companies.find((c) => c.code === mapCompany.value)?.id);
const maps = useAsync(async () => (companyId.value ? api.get<Array<{ company_account_code: string; company_account_name: string; account_code: string | null; account_name: string | null; status: string | null }>>(`/api/admin/account-mappings?company_id=${companyId.value}`) : []));
watch(mapCompany, () => maps.run());
const mapMsg = ref('');
async function map(code: string, account: string) {
  try {
    const r = await api.post<{ revalidated: unknown[] }>('/api/admin/account-mappings', { company_id: companyId.value, company_account_code: code, account_code: account });
    mapMsg.value = `Homologación aprobada: ${code} → ${account}. ${r.revalidated.length} versión(es) revalidadas.`;
    maps.run();
  } catch (e) { mapMsg.value = (e as Error).message; }
}
const rates = useAsync(() => api.get<Array<{ id: string; scenario: string; from_currency: string; to_currency: string; rate_type: string; period_code: string | null; rate: string; version: number; source: string; status: string }>>('/api/admin/rates'));
const scenarios = computed(() => [...new Set((s.reference?.versions ?? []).map((v) => v.rate_scenario))]);
const rate = reactive({ from_currency: 'HNL', to_currency: s.currency, rate_type: 'average', period_code: '', scenario: scenarios.value[0] ?? '', rate: '', source: '' });
const rateMsg = ref('');
const rateErr = ref(false);
async function addRate() {
  try {
    const r = await api.post<{ version: number; revalidated: unknown[] }>('/api/admin/rates', { ...rate, period_code: rate.rate_type === 'historical' ? null : rate.period_code });
    rateErr.value = false;
    rateMsg.value = `Tasa registrada (versión ${r.version}). ${r.revalidated.length} versión(es) presupuestarias revalidadas.`;
    rates.run();
  } catch (e) { rateErr.value = true; rateMsg.value = (e as Error).message; }
}
const params = useAsync(() => api.get<Array<{ fiscal_year: number; code: string; value: string; description: string; status: string }>>('/api/admin/parameters'));
const members = useAsync(async () => (s.can('org.admin') ? api.get<Array<{ user_id: string; full_name: string; email: string; role_code: string; all_companies: boolean; companies: string[]; status: string }>>('/api/admin/members') : []));
</script>
