<template>
  <div>
    <StateBlock :loading="loading && !dash" :error="error" :retry="load">
      <template v-if="dash">
        <PageHeader eyebrow="AI Dashboard Studio" :title="dash.name" :description="`Versión ${dash.version} · ${dash.widgets.length} widgets · ${filtersLabel}`">
          <label class="text-sm"><span class="sr-only">Versión presupuestaria</span>
            <select v-model="version" class="field min-h-10 w-auto">
              <option value="approved">Presupuesto publicado</option>
              <option v-for="v in s.reference?.versions.filter((x) => x.published_run_id || x.latest_run)" :key="v.code" :value="v.code">{{ v.code }}</option>
            </select>
          </label>
          <button class="btn-outline" @click="historyOpen = !historyOpen">Historial</button>
          <button class="btn-outline" @click="duplicate">Duplicar</button>
          <button v-if="s.can('dashboard.share')" class="btn-outline" @click="shareOpen = !shareOpen">Compartir</button>
          <button class="btn-ghost text-critical" @click="remove">Eliminar</button>
        </PageHeader>

        <div class="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,1fr)_22rem]">
          <!-- Lienzo -->
          <section aria-label="Widgets" class="order-2 2xl:order-1">
            <StateBlock :empty="!dash.widgets.length" empty-text="Dashboard vacío. Pídale a la IA que agregue indicadores.">
              <ul class="grid grid-cols-1 gap-4 md:grid-cols-6">
                <li v-for="(wg, i) in dash.widgets" :key="wg.id" :class="SIZE[wg.spec.size]">
                  <WidgetRenderer :spec="wg.spec" :fetcher="() => fetchWidget(wg.id)" :refresh-key="`${version}-${dash.version}`">
                    <template #actions>
                      <button class="btn-ghost min-h-8 px-1.5" :disabled="i === 0" aria-label="Mover antes" @click="move(i, -1)"><PhArrowLeft :size="14" /></button>
                      <button class="btn-ghost min-h-8 px-1.5" :disabled="i === dash.widgets.length - 1" aria-label="Mover después" @click="move(i, 1)"><PhArrowRight :size="14" /></button>
                      <select class="field min-h-8 w-auto px-1 text-xs" :value="wg.spec.size" aria-label="Tamaño"
                              @change="act([{ action: 'update_widget', widget_id: wg.id, changes: { size: ($event.target as HTMLSelectElement).value } }])">
                        <option value="sm">S</option><option value="md">M</option><option value="lg">L</option><option value="xl">XL</option>
                      </select>
                      <button class="btn-ghost min-h-8 px-1.5" aria-label="Eliminar widget" @click="act([{ action: 'remove_widget', widget_id: wg.id }])"><PhX :size="14" /></button>
                    </template>
                  </WidgetRenderer>
                </li>
              </ul>
            </StateBlock>
          </section>

          <!-- Panel IA -->
          <aside class="order-1 2xl:order-2" aria-labelledby="ai-title">
            <div class="panel sticky top-4 p-4">
              <h2 id="ai-title" class="flex items-center gap-2 text-sm font-bold"><PhSparkle :size="16" aria-hidden="true" /> Instrucciones a la IA</h2>
              <form class="mt-3" @submit.prevent="ask()">
                <label for="instr" class="sr-only">Instrucción</label>
                <textarea id="instr" v-model="instruction" rows="3" maxlength="600" class="field min-h-24 py-2"
                          placeholder="p. ej. Agrega el ROIC por empresa" @keydown.enter.exact.prevent="ask()" />
                <button class="btn-primary mt-2 w-full" :disabled="busy || instruction.length < 3">{{ busy ? 'Interpretando…' : 'Aplicar' }}</button>
              </form>
              <ul class="mt-3 flex flex-wrap gap-1.5">
                <li v-for="sug in suggestions" :key="sug">
                  <button class="rounded-full border border-line px-2.5 py-1 text-xs hover:border-line-strong" @click="ask(sug)">{{ sug }}</button>
                </li>
              </ul>
              <div aria-live="polite">
                <div v-if="aiResult" class="mt-4 rounded-ui border border-line bg-surface-muted p-3 text-sm">
                  <p class="font-semibold">{{ aiResult.applied ? 'Cambios aplicados' : aiResult.pending_change_id ? 'Requiere confirmación' : 'Sin cambios' }}</p>
                  <p class="mt-1 text-muted">{{ aiResult.plan?.explanation }}</p>
                  <ul class="mt-1 text-xs text-muted"><li v-for="x in aiResult.summary" :key="x">· {{ x }}</li></ul>
                  <p v-if="aiResult.injection_suspected" class="mt-2 text-xs text-warning">La instrucción contenía texto que parece manipular reglas: se ignoró y solo se aplicaron acciones permitidas.</p>
                  <div v-if="aiResult.pending_change_id" class="mt-3 flex gap-2">
                    <button class="btn-primary min-h-9" @click="confirm(true)">Confirmar</button>
                    <button class="btn-outline min-h-9" @click="confirm(false)">Descartar</button>
                  </div>
                </div>
                <p v-if="aiError" role="alert" class="mt-3 text-sm text-critical">{{ aiError }}</p>
              </div>
              <details class="mt-4 text-xs text-muted">
                <summary class="cursor-pointer font-semibold text-ink">¿Cómo funciona?</summary>
                <p class="mt-1">La IA traduce su instrucción a una especificación declarativa validada (métricas, dimensiones, tipo de gráfico). No genera código ni cifras: los valores se calculan en el motor financiero.</p>
              </details>
            </div>
          </aside>
        </div>

        <!-- Historial -->
        <div v-if="historyOpen" class="fixed inset-0 z-40 flex justify-end bg-black/40" role="dialog" aria-modal="true" aria-label="Historial de versiones" @click.self="historyOpen = false" @keydown.esc="historyOpen = false">
          <div class="h-full w-full max-w-md overflow-y-auto bg-surface p-6 shadow-xl">
            <div class="flex items-center justify-between"><h2 class="text-lg font-bold">Historial</h2><button class="btn-ghost" aria-label="Cerrar" @click="historyOpen = false"><PhX :size="18" /></button></div>
            <StateBlock :loading="history.loading.value" :error="history.error.value">
              <ol class="mt-4 divide-y divide-line">
                <li v-for="h in history.data.value" :key="h.version" class="py-3 text-sm">
                  <div class="flex items-center justify-between gap-2">
                    <p class="font-semibold">Versión {{ h.version }} · {{ h.source === 'ai' ? 'Cambio por IA' : h.source === 'restore' ? 'Restauración' : h.source === 'system' ? 'Creación' : 'Cambio manual' }}</p>
                    <button v-if="h.version !== dash.version" class="btn-ghost min-h-8 text-xs" @click="restore(h.version)">Restaurar</button>
                  </div>
                  <p class="text-muted">{{ h.change_summary }}</p>
                  <p class="text-xs text-muted">{{ fmtDate(h.created_at) }} · {{ h.created_by }} · {{ h.widgets }} widgets</p>
                </li>
              </ol>
            </StateBlock>
          </div>
        </div>

        <!-- Compartir -->
        <div v-if="shareOpen" class="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Compartir">
          <form class="panel w-full max-w-md bg-surface p-6" @submit.prevent="share">
            <h2 class="text-lg font-bold">Compartir dashboard</h2>
            <label for="semail" class="field-label mt-4">Correo de un miembro de la organización</label>
            <input id="semail" v-model.trim="shareEmail" type="email" required class="field" />
            <label class="mt-3 flex items-center gap-2 text-sm"><input v-model="shareEdit" type="checkbox" /> Permitir edición</label>
            <p v-if="shareMsg" role="status" class="mt-3 text-sm">{{ shareMsg }}</p>
            <div class="mt-5 flex justify-end gap-2"><button type="button" class="btn-outline" @click="shareOpen = false">Cerrar</button><button class="btn-primary">Compartir</button></div>
          </form>
        </div>
      </template>
    </StateBlock>
  </div>
</template>

<script setup lang="ts">
import { PhArrowLeft, PhArrowRight, PhSparkle, PhX } from '@phosphor-icons/vue';
import type { SemanticResponse, WidgetSpec } from '~/utils/widgets';

interface Dash { id: string; name: string; version: number; global_filters: Record<string, unknown>; can_edit: boolean; widgets: Array<{ id: string; spec: WidgetSpec }> }
const route = useRoute();
const api = useApi();
const s = useSessionStore();
const id = route.params.id as string;
const dash = ref<Dash | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const version = ref('approved');
const instruction = ref('');
const busy = ref(false);
const aiResult = ref<{ applied: boolean; pending_change_id?: string; summary: string[]; plan?: { explanation: string }; injection_suspected?: boolean } | null>(null);
const aiError = ref('');
const historyOpen = ref(false);
const shareOpen = ref(false);
const shareEmail = ref('');
const shareEdit = ref(false);
const shareMsg = ref('');
const SIZE: Record<string, string> = { sm: 'min-w-0 md:col-span-3 xl:col-span-2', md: 'min-w-0 md:col-span-3 xl:col-span-3', lg: 'min-w-0 md:col-span-6 xl:col-span-3', xl: 'min-w-0 md:col-span-6' };
const suggestions = ['Agrega el ROIC por empresa', 'Compara los ingresos reales con el presupuesto', 'Muéstrame las cinco empresas con mayor EVA',
  'Agrega un KPI con el impacto cambiario', 'Cambia esta gráfica por una de barras', 'Ordena los resultados de mayor a menor',
  'Filtra solamente las empresas de Guatemala', 'Quita el filtro', 'Guarda este dashboard como mi vista ejecutiva', 'Elimina el indicador de EBITDA'];

const filtersLabel = computed(() => {
  const f = dash.value?.global_filters ?? {};
  const c = (f.countries as string[] | undefined)?.length ? `Filtro: ${(f.countries as string[]).join(', ')}` : 'Sin filtros globales';
  return c;
});

async function load() {
  loading.value = true;
  error.value = null;
  try { dash.value = await api.get<Dash>(`/api/dashboards/${id}`); } catch (e) { error.value = (e as Error).message; } finally { loading.value = false; }
}
onMounted(load);

const fetchWidget = (wid: string) => api.get<SemanticResponse>(`/api/dashboards/${id}/widgets/${wid}/data?period=${s.period}&version=${encodeURIComponent(version.value)}`);

async function act(actions: unknown[]) {
  try {
    const r = await api.post<{ dashboard?: Dash }>(`/api/dashboards/${id}/actions`, { actions });
    if (r.dashboard) dash.value = r.dashboard;
  } catch (e) { aiError.value = (e as Error).message; }
}
function move(i: number, d: number) {
  const ids = dash.value!.widgets.map((w) => w.id);
  [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
  act([{ action: 'reorder_widgets', order: ids }]);
}
async function ask(text?: string) {
  if (text) instruction.value = text;
  busy.value = true;
  aiError.value = '';
  aiResult.value = null;
  try {
    const r = await api.post<{ applied: boolean; dashboard?: Dash; pending_change_id?: string; summary: string[] }>(`/api/dashboards/${id}/ai`, { instruction: instruction.value });
    aiResult.value = r;
    if (r.dashboard) dash.value = r.dashboard;
    else await load();
    instruction.value = '';
  } catch (e) { aiError.value = (e as Error).message; } finally { busy.value = false; }
}
async function confirm(accept: boolean) {
  const r = await api.post<{ dashboard?: Dash }>(`/api/dashboards/${id}/pending/${aiResult.value!.pending_change_id}`, { accept });
  aiResult.value = null;
  if (r.dashboard) dash.value = r.dashboard;
}
const history = useAsync(() => api.get<Array<{ version: number; change_summary: string; source: string; created_at: string; created_by: string; widgets: number }>>(`/api/dashboards/${id}/versions`), { immediate: false });
watch(historyOpen, (o) => { if (o) history.run(); });
async function restore(v: number) {
  const r = await api.post<{ dashboard: Dash }>(`/api/dashboards/${id}/restore`, { version: v });
  dash.value = r.dashboard;
  history.run();
}
async function duplicate() {
  const r = await api.post<{ dashboard?: Dash }>(`/api/dashboards/${id}/duplicate`);
  if (r.dashboard) await navigateTo(`/dashboards/${r.dashboard.id}`);
}
async function remove() {
  if (!window.confirm('¿Eliminar este dashboard? Podrá ser recuperado por un administrador desde el historial de auditoría.')) return;
  await api.del(`/api/dashboards/${id}`);
  await navigateTo('/dashboards');
}
async function share() {
  try {
    await api.post(`/api/dashboards/${id}/share`, { email: shareEmail.value, permission: shareEdit.value ? 'edit' : 'view' });
    shareMsg.value = 'Dashboard compartido.';
  } catch (e) { shareMsg.value = (e as Error).message; }
}
</script>
