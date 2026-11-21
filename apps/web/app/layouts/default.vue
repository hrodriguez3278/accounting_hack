<template>
  <div class="min-h-dvh bg-surface text-ink lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)]">
    <a href="#contenido" class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-surface focus:p-2">Saltar al contenido</a>

    <!-- Navegación lateral (escritorio) -->
    <aside class="hidden bg-black text-white lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col" aria-label="Navegación principal">
      <AppNav />
    </aside>

    <!-- Barra superior (móvil) -->
    <header class="flex h-16 items-center justify-between bg-black px-4 text-white lg:hidden">
      <NuxtLink to="/" class="text-lg font-bold tracking-tight">NEXORA<span class="text-[#e0524f]">.</span></NuxtLink>
      <button class="inline-flex size-11 items-center justify-center" aria-label="Abrir menú" :aria-expanded="menuOpen" @click="menuOpen = true">
        <PhList :size="24" />
      </button>
    </header>
    <div v-if="menuOpen" class="fixed inset-0 z-50 flex lg:hidden" role="dialog" aria-modal="true" aria-label="Menú">
      <div class="w-72 bg-black text-white"><AppNav @navigate="menuOpen = false" /></div>
      <button class="flex-1 bg-black/60" aria-label="Cerrar menú" @click="menuOpen = false" />
    </div>

    <div class="min-w-0">
      <div class="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2 sm:px-8">
        <p class="text-sm text-muted">
          <span class="font-semibold text-ink">{{ orgName }}</span>
          <span v-if="s.me" aria-hidden="true"> · </span>
          <span v-if="s.me">{{ roleLabel }}{{ s.me.all_companies ? ' · todas las empresas' : ' · acceso por empresa' }}</span>
        </p>
        <div class="flex items-center gap-2">
          <select v-if="(s.me?.memberships.length ?? 0) > 1" class="field min-h-9 w-auto" aria-label="Organización"
                  :value="s.organizationId" @change="switchOrg(($event.target as HTMLSelectElement).value)">
            <option v-for="m in s.me?.memberships" :key="m.organizationId" :value="m.organizationId">{{ m.name }}</option>
          </select>
          <button class="btn-ghost" :aria-label="s.theme === 'dark' ? 'Usar modo claro' : 'Usar modo oscuro'" @click="s.setTheme(s.theme === 'dark' ? 'light' : 'dark')">
            <PhSun v-if="s.theme === 'dark'" :size="18" /><PhMoon v-else :size="18" />
          </button>
        </div>
      </div>
      <main id="contenido" class="px-4 py-6 sm:px-8 sm:py-8">
        <slot />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { PhList, PhMoon, PhSun } from '@phosphor-icons/vue';

const s = useSessionStore();
const menuOpen = ref(false);
const route = useRoute();
watch(() => route.fullPath, () => { menuOpen.value = false; });

const ROLE: Record<string, string> = { super_admin: 'Super Admin', org_admin: 'Administración', financial_admin: 'Administración financiera',
  director: 'Dirección', financial_analyst: 'Análisis financiero', auditor: 'Auditoría', viewer: 'Consulta' };
const roleLabel = computed(() => ROLE[s.me?.role ?? ''] ?? s.me?.role);
const orgName = computed(() => s.me?.memberships.find((m) => m.organizationId === s.organizationId)?.name ?? '');

async function switchOrg(id: string) {
  await s.switchOrg(id);
  await navigateTo('/');
  reloadNuxtApp({ force: true });
}
</script>
