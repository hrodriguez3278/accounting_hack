<template>
  <div>
    <h2 class="text-2xl font-bold tracking-tight">Nueva contraseña</h2>
    <form class="mt-6 space-y-4" @submit.prevent="submit">
      <div>
        <label for="pw" class="field-label">Contraseña (mínimo 10 caracteres)</label>
        <input id="pw" v-model="pw" type="password" minlength="10" required autocomplete="new-password" class="field" />
      </div>
      <p v-if="msg" role="status" class="text-sm" :class="ok ? 'text-success' : 'text-critical'">{{ msg }}</p>
      <button class="btn-primary w-full" :disabled="pw.length < 10">Guardar contraseña</button>
    </form>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'auth' });
const { $supabase } = useNuxtApp();
const pw = ref('');
const msg = ref('');
const ok = ref(false);
async function submit() {
  const { error } = await $supabase.auth.updateUser({ password: pw.value });
  ok.value = !error;
  msg.value = error ? 'El enlace expiró o no es válido. Solicite uno nuevo.' : 'Contraseña actualizada.';
  if (!error) setTimeout(() => navigateTo('/'), 800);
}
</script>
