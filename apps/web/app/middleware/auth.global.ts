export default defineNuxtRouteMiddleware(async (to) => {
  const isAuthRoute = to.path.startsWith('/auth');
  // Acceso abierto: no hay inicio de sesión; las pantallas de autenticación no aplican
  if (useRuntimeConfig().public.authMode === 'none') {
    if (isAuthRoute) return navigateTo('/');
    const s = useSessionStore();
    if (!s.me) await s.load();
    return;
  }
  const { $supabase } = useNuxtApp();
  const { data } = await $supabase.auth.getSession();
  if (!data.session && !isAuthRoute) return navigateTo('/auth/login');
  if (data.session && to.path === '/auth/login') return navigateTo('/');
  if (data.session && !isAuthRoute) {
    const s = useSessionStore();
    if (!s.me) {
      try {
        await s.load();
      } catch {
        await $supabase.auth.signOut();
        return navigateTo('/auth/login?error=sin-acceso');
      }
    }
  }
});
