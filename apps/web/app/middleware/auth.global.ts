export default defineNuxtRouteMiddleware(async (to) => {
  const { $supabase } = useNuxtApp();
  const { data } = await $supabase.auth.getSession();
  const isAuthRoute = to.path.startsWith('/auth');
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
