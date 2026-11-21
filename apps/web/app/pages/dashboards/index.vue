<template>
  <div>
    <PageHeader eyebrow="AI Dashboard Studio" title="Dashboards" period
                description="Cree y modifique tableros con instrucciones en lenguaje natural. Cada widget consulta en vivo la capa semántica certificada." />

    <form class="panel mb-8 grid gap-4 p-4 sm:grid-cols-[1fr_auto_auto] sm:items-end" @submit.prevent="create">
      <div>
        <label for="dname" class="field-label">Nuevo dashboard</label>
        <input id="dname" v-model.trim="name" class="field" placeholder="p. ej. Vista ejecutiva del comité" maxlength="120" required />
      </div>
      <fieldset class="flex gap-4 text-sm">
        <legend class="sr-only">Plantilla</legend>
        <label class="flex min-h-11 items-center gap-2"><input v-model="template" type="radio" value="executive" /> Plantilla ejecutiva</label>
        <label class="flex min-h-11 items-center gap-2"><input v-model="template" type="radio" value="blank" /> En blanco</label>
      </fieldset>
      <button class="btn-primary" :disabled="creating || !name">{{ creating ? 'Creando…' : 'Crear' }}</button>
      <p v-if="createError" role="alert" class="text-sm text-critical sm:col-span-3">{{ createError }}</p>
    </form>

    <StateBlock :loading="list.loading.value" :error="list.error.value" :empty="!list.data.value?.length" :retry="list.run"
                empty-text="Todavía no tiene dashboards. Cree el primero con la plantilla ejecutiva.">
      <ul class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <li v-for="d in list.data.value" :key="d.id">
          <NuxtLink :to="`/dashboards/${d.id}`" class="panel group block p-5 transition hover:border-line-strong">
            <p class="text-xs font-semibold text-muted">{{ d.shared ? `Compartido por ${d.owner_name}` : 'Propio' }}</p>
            <h2 class="mt-2 text-lg font-bold tracking-tight group-hover:underline">{{ d.name }}</h2>
            <p class="mt-1 text-sm text-muted">{{ d.widgets }} widgets · actualizado {{ fmtDate(d.updated_at) }}</p>
          </NuxtLink>
        </li>
      </ul>
    </StateBlock>
  </div>
</template>

<script setup lang="ts">
const api = useApi();
const name = ref('');
const template = ref<'executive' | 'blank'>('executive');
const creating = ref(false);
const createError = ref('');
const list = useAsync(() => api.get<Array<{ id: string; name: string; version: number; widgets: number; updated_at: string; shared: boolean; owner_name: string }>>('/api/dashboards'));

async function create() {
  creating.value = true;
  createError.value = '';
  try {
    const d = await api.post<{ id: string }>('/api/dashboards', { name: name.value, template: template.value });
    await navigateTo(`/dashboards/${d.id}`);
  } catch (e) { createError.value = (e as Error).message; } finally { creating.value = false; }
}
</script>
