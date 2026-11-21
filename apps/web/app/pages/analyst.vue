<template>
  <div>
    <PageHeader eyebrow="Financial Analyst" title="Pregunte a sus cifras" period
                description="Las respuestas se construyen solo con resultados de herramientas autorizadas. Cada cifra se verifica contra la consulta que la originó." />
    <div class="grid grid-cols-1 gap-6 xl:grid-cols-[16rem_minmax(0,1fr)]">
      <aside aria-label="Conversaciones" class="hidden xl:block">
        <button class="btn-outline w-full" @click="newChat">Nueva conversación</button>
        <ul class="mt-4 space-y-1">
          <li v-for="c in convs.data.value" :key="c.id">
            <button class="w-full truncate rounded-ui px-3 py-2 text-left text-sm hover:bg-surface-muted" :class="c.id === conversationId ? 'bg-surface-muted font-semibold' : ''"
                    @click="openChat(c.id)">{{ c.title }}</button>
          </li>
        </ul>
      </aside>

      <section class="flex min-h-[60vh] flex-col">
        <ol class="flex-1 space-y-5" aria-live="polite">
          <li v-if="!messages.length" class="panel p-5 text-sm">
            <p class="font-semibold">Ejemplos</p>
            <ul class="mt-2 flex flex-wrap gap-2">
              <li v-for="e in examples" :key="e"><button class="rounded-full border border-line px-3 py-1.5 text-left hover:border-line-strong" @click="ask(e)">{{ e }}</button></li>
            </ul>
          </li>
          <li v-for="(m, i) in messages" :key="i" :class="m.role === 'user' ? 'ml-auto max-w-[80ch]' : 'max-w-[90ch]'">
            <div v-if="m.role === 'user'" class="break-words rounded-ui bg-black px-4 py-3 text-sm text-white">{{ m.content }}</div>
            <article v-else class="panel p-4">
              <div class="prose-sm whitespace-pre-line text-sm leading-relaxed" v-html="render(m.content)" />
              <div v-if="m.structured" class="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs">
                <span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold"
                      :class="m.structured.grounding?.verified ? 'bg-success-bg text-success' : 'bg-critical-bg text-critical'">
                  <PhSealCheck v-if="m.structured.grounding?.verified" :size="13" aria-hidden="true" /><PhWarning v-else :size="13" aria-hidden="true" />
                  {{ m.structured.grounding?.verified ? `${m.structured.grounding.checked} cifras verificadas` : 'Cifras sin verificar' }}
                </span>
                <span v-if="m.structured.injection_suspected" class="rounded-full bg-warning-bg px-2 py-0.5 font-semibold text-warning">Instrucciones sospechosas ignoradas</span>
                <span v-if="m.structured.tools?.length" class="text-muted">Fuentes: {{ [...new Set(m.structured.tools.filter((t: { status: string }) => t.status === 'ok').map((t: { name: string }) => TOOL_LABEL[t.name] ?? t.name))].join(', ') || '—' }}</span>
              </div>
              <ul v-if="m.structured?.evidence?.length" class="mt-2 flex flex-wrap gap-2">
                <li v-for="(e, j) in m.structured.evidence" :key="j">
                  <NuxtLink :to="evidenceLink(e)" class="btn-outline min-h-8 max-w-full px-3 text-xs"><PhMagnifyingGlass :size="13" aria-hidden="true" /> <span class="truncate">{{ evidenceLabel(e) }}</span></NuxtLink>
                </li>
              </ul>
            </article>
          </li>
          <li v-if="busy" class="flex items-center gap-2 text-sm text-muted" role="status">
            <span class="size-4 animate-spin rounded-full border-2 border-line border-t-ink" aria-hidden="true" /> Consultando la capa semántica…
          </li>
        </ol>
        <p v-if="error" role="alert" class="mt-3 text-sm text-critical">{{ error }}</p>
        <form class="sticky bottom-0 mt-6 flex gap-2 border-t border-line bg-surface pt-4" @submit.prevent="ask()">
          <label for="q" class="sr-only">Pregunta</label>
          <input id="q" v-model="question" class="field" maxlength="2000" placeholder="p. ej. ¿Por qué cambió el EBITDA entre la versión 1 y la versión 2?" />
          <button class="btn-primary" :disabled="busy || question.length < 3">Preguntar</button>
        </form>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { PhMagnifyingGlass, PhSealCheck, PhWarning } from '@phosphor-icons/vue';

interface Msg { role: 'user' | 'assistant'; content: string; structured?: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
const api = useApi();
const route = useRoute();
const question = ref('');
const busy = ref(false);
const error = ref('');
const messages = ref<Msg[]>([]);
const conversationId = ref<string | undefined>();
const examples = ['¿Por qué cambió el ROIC entre la versión 1 y la versión 2?', '¿Qué empresa tiene la mayor desviación presupuestaria?',
  '¿Cuánto se eliminó por operaciones intercompany?', '¿Qué porcentaje de los ingresos consolidados representa ALT-DIST?',
  '¿Qué cambió entre la versión 1 y la versión 2?', '¿De dónde proviene el EBITDA?', 'Simula una reducción de gastos operativos del 8%'];
const convs = useAsync(() => api.get<Array<{ id: string; title: string }>>('/api/ai/conversations'));

/** Render seguro: se escapa todo el HTML y solo se interpreta **negrita**. */
function render(t: string) {
  const esc = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return esc.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
const { metricName } = useCatalog();
function evidenceLabel(e: { kind: string; label: string; ref: Record<string, string> }) {
  if (e.kind === 'lineage') return 'Ver origen de la cifra';
  if (e.kind === 'scenario') return 'Ver simulación';
  if (e.kind === 'variance') return e.label.replace(/^Puente (\w+):/, (_m, c: string) => `Desglose de ${metricName(c)}:`);
  return e.label.replace(/^Consulta: (.+)$/, (_m, list: string) => `Ver datos: ${list.split(', ').map(metricName).join(', ')}`);
}
function evidenceLink(e: { kind: string; ref: Record<string, string> }) {
  if (e.kind === 'lineage') return `/audit?run=${e.ref.run_id}&metric=${e.ref.metric}`;
  if (e.kind === 'scenario') return '/scenarios';
  return `/audit?tab=queries&query=${e.ref.query_id}${e.ref.run_id ? `&run=${e.ref.run_id}` : ''}`;
}
async function ask(text?: string) {
  const q = (text ?? question.value).trim();
  if (q.length < 3) return;
  messages.value.push({ role: 'user', content: q });
  question.value = '';
  busy.value = true;
  error.value = '';
  try {
    const r = await api.post<{ conversation_id: string; answer: string; evidence: unknown[]; grounding: unknown; injectionSuspected: boolean;
      tool_executions: Array<{ name: string; status: string }> }>('/api/ai/ask', { question: q, conversation_id: conversationId.value });
    conversationId.value = r.conversation_id;
    messages.value.push({ role: 'assistant', content: r.answer, structured: { evidence: r.evidence, grounding: r.grounding,
      injection_suspected: r.injectionSuspected, tools: r.tool_executions } });
    convs.run();
  } catch (e) { error.value = (e as Error).message; } finally { busy.value = false; }
}
async function openChat(id: string) {
  conversationId.value = id;
  messages.value = await api.get<Msg[]>(`/api/ai/conversations/${id}`);
}
function newChat() { conversationId.value = undefined; messages.value = []; }
onMounted(() => { if (typeof route.query.q === 'string') ask(route.query.q); });
</script>
