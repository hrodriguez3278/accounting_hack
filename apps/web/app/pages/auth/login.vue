<template>
  <div>
    <h2 class="text-2xl font-bold tracking-tight">Iniciar sesión</h2>
    <p class="mt-1 text-sm text-muted">Acceso restringido a usuarios autorizados.</p>
    <div v-if="route.query.error" role="alert" class="mt-5 rounded-ui border border-critical bg-critical-bg px-3 py-2 text-sm text-critical">
      Su usuario no tiene acceso a ninguna organización.
    </div>
    <form class="mt-6 space-y-4" novalidate @submit.prevent="submit">
      <div>
        <label for="email" class="field-label">Correo electrónico</label>
        <input id="email" v-model.trim="email" type="email" autocomplete="username" required class="field" :aria-invalid="!!error" />
      </div>
      <div>
        <label for="password" class="field-label">Contraseña</label>
        <input id="password" v-model="password" type="password" autocomplete="current-password" required class="field" :aria-invalid="!!error"
               aria-describedby="login-error" />
      </div>
      <p v-if="error" id="login-error" role="alert" class="text-sm text-critical">{{ error }}</p>
      <button type="submit" class="btn-primary w-full" :disabled="loading">{{ loading ? 'Verificando…' : 'Ingresar' }}</button>
    </form>
    <NuxtLink to="/auth/recover" class="mt-5 inline-block text-sm font-semibold underline underline-offset-4">¿Olvidó su contraseña?</NuxtLink>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'auth' });
const { $supabase } = useNuxtApp();
const route = useRoute();
const email = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

async function submit() {
  error.value = '';
  if (!email.value || !password.value) { error.value = 'Ingrese su correo y contraseña.'; return; }
  loading.value = true;
  const { error: e } = await $supabase.auth.signInWithPassword({ email: email.value, password: password.value });
  loading.value = false;
  if (e) { error.value = 'Credenciales incorrectas. Verifique e intente de nuevo.'; return; }
  await navigateTo('/');
}
</script>
