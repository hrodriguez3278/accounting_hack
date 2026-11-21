<template>
  <header class="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-line-strong pb-5">
    <div class="min-w-0">
      <p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
      <h1 class="h-page mt-1">{{ title }}<span v-if="period" class="brand-period" aria-hidden="true">.</span></h1>
      <p v-if="description" class="mt-2 max-w-[70ch] text-sm text-muted">{{ description }}</p>
    </div>
    <div class="flex flex-wrap items-center gap-2"><slot /></div>
  </header>
</template>

<script setup lang="ts">
defineProps<{ title: string; eyebrow?: string; description?: string; period?: boolean }>();
</script>
