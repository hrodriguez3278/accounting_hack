<template>
  <div v-if="loading" class="flex items-center gap-3 py-8 text-sm text-muted" role="status" aria-live="polite">
    <span class="size-4 animate-spin rounded-full border-2 border-line border-t-ink" aria-hidden="true" /> {{ loadingText }}
  </div>
  <div v-else-if="error" class="rounded-ui border border-critical bg-critical-bg px-4 py-3 text-sm text-critical" role="alert">
    <p class="font-semibold">No fue posible cargar la información</p>
    <p class="mt-0.5">{{ error }}</p>
    <button v-if="retry" class="mt-2 font-semibold underline underline-offset-2" @click="retry">Reintentar</button>
  </div>
  <div v-else-if="empty" class="rounded-ui border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
    <slot name="empty">{{ emptyText }}</slot>
  </div>
  <slot v-else />
</template>

<script setup lang="ts">
withDefaults(defineProps<{ loading?: boolean; error?: string | null; empty?: boolean; emptyText?: string; loadingText?: string;
  retry?: () => unknown }>(), { loadingText: 'Cargando…', emptyText: 'Sin información para mostrar.' });
</script>
