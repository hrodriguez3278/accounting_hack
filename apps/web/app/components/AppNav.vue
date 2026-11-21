<template>
  <nav class="flex h-full flex-col">
    <NuxtLink to="/" class="block px-6 pb-6 pt-7" @click="emit('navigate')">
      <span class="block text-2xl font-bold tracking-[-0.04em]">NEXORA<span class="text-[#e0524f]">.</span></span>
      <span class="mt-1 block text-xs font-semibold uppercase tracking-[0.14em] text-[#89888a]">Inteligencia financiera</span>
    </NuxtLink>
    <ul class="flex-1 space-y-0.5 overflow-y-auto px-3">
      <li v-for="item in visible" :key="item.to">
        <NuxtLink :to="item.to" class="group flex min-h-11 items-center gap-3 rounded-ui px-3 text-sm font-semibold text-[#c9c8cb] transition hover:bg-white/10 hover:text-white"
                  :class="isActive(item.to) ? 'bg-white/10 text-white' : ''" :aria-current="isActive(item.to) ? 'page' : undefined"
                  @click="emit('navigate')">
          <span class="h-5 w-0.5" :class="isActive(item.to) ? 'bg-[#e0524f]' : 'bg-transparent'" aria-hidden="true" />
          <component :is="item.icon" :size="18" aria-hidden="true" />
          {{ item.label }}
        </NuxtLink>
      </li>
    </ul>
    <div class="border-t border-white/10 px-6 py-5">
      <p class="truncate text-sm font-semibold">{{ s.me?.full_name }}</p>
      <p class="truncate text-xs text-[#a9a8ab]">{{ s.me?.email }}</p>
      <button v-if="useRuntimeConfig().public.authMode !== 'none'" class="mt-3 inline-flex min-h-9 items-center gap-2 text-sm font-semibold text-[#c9c8cb] hover:text-white" @click="logout">
        <PhSignOut :size="16" aria-hidden="true" /> Cerrar sesión
      </button>
    </div>
  </nav>
</template>

<script setup lang="ts">
import {
  PhChartBar, PhChatCircleText, PhDatabase, PhFlask, PhGear, PhShieldCheck, PhSignOut, PhSquaresFour, PhStack, PhTreeStructure,
} from '@phosphor-icons/vue';

const emit = defineEmits<{ navigate: [] }>();
const s = useSessionStore();
const route = useRoute();
const { $supabase } = useNuxtApp();

const items = [
  { to: '/', label: 'Overview', icon: PhSquaresFour },
  { to: '/dashboards', label: 'AI Dashboards', icon: PhChartBar, perm: 'dashboard.create' },
  { to: '/analyst', label: 'Financial Analyst', icon: PhChatCircleText, perm: 'ai.use' },
  { to: '/consolidation', label: 'Consolidación', icon: PhStack, perm: 'financial.read' },
  { to: '/data-hub', label: 'Data Hub', icon: PhDatabase, perm: 'data.read' },
  { to: '/data-quality', label: 'Calidad de datos', icon: PhShieldCheck, perm: 'quality.review' },
  { to: '/scenarios', label: 'Scenario Lab', icon: PhFlask, perm: 'scenario.create' },
  { to: '/audit', label: 'Auditoría y trazabilidad', icon: PhTreeStructure, perm: 'financial.read' },
  { to: '/admin', label: 'Administración', icon: PhGear },
];
const visible = computed(() => items.filter((i) => !i.perm || s.can(i.perm)));
const isActive = (to: string) => (to === '/' ? route.path === '/' : route.path.startsWith(to));

async function logout() {
  await $supabase.auth.signOut();
  s.$reset();
  await navigateTo('/auth/login');
}
</script>
