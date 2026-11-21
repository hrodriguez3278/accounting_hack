<template>
  <div>
    <h2 class="text-2xl font-bold tracking-tight">Recuperar contraseña</h2>
    <p class="mt-1 text-sm text-muted">Le enviaremos un enlace para definir una nueva contraseña.</p>
    <form v-if="!sent" class="mt-6 space-y-4" @submit.prevent="submit">
      <div>
        <label for="email" class="field-label">Correo electrónico</label>
        <input id="email" v-model.trim="email" type="email" required autocomplete="username" class="field" />
      </div>
      <p v-if="error" role="alert" class="text-sm text-critical">{{ error }}</p>
      <button class="btn-primary w-full" :disabled="loading">{{ loading ? 'Enviando…' : 'Enviar enlace' }}</button>
    </form>
    <div v-else role="status" class="mt-6 rounded-ui border border-line bg-surface-muted p-4 text-sm">
      Si el correo está registrado, recibirá un enlace. En el entorno local los correos se ven en Mailpit (http://127.0.0.1:54324).
    </div>
    <NuxtLink to="/auth/login" class="mt-5 inline-block text-sm font-semibold underline underline-offset-4">Volver a iniciar sesión</NuxtLink>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'auth' });
const { $supabase } = useNuxtApp();
const email = ref('');
const sent = ref(false);
const loading = ref(false);
const error = ref('');
async function submit() {
  loading.value = true;
  error.value = '';
  const { error: e } = await $supabase.auth.resetPasswordForEmail(email.value, { redirectTo: `${window.location.origin}/auth/reset` });
  loading.value = false;
  if (e) { error.value = 'No fue posible enviar el enlace. Intente más tarde.'; return; }
  sent.value = true;
}
</script>
