import tailwindcss from '@tailwindcss/vite';

// SPA autenticada: los datos financieros solo se obtienen en el cliente con el JWT del usuario.
export default defineNuxtConfig({
  compatibilityDate: '2026-11-01',
  ssr: false,
  devtools: { enabled: false },
  modules: ['@pinia/nuxt'],
  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] },
  runtimeConfig: {
    public: {
      supabaseUrl: process.env.NUXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
      supabasePublishableKey: process.env.NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
      apiUrl: process.env.NUXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000',
    },
  },
  app: {
    head: {
      htmlAttrs: { lang: 'es' },
      title: 'NEXORA AI',
      meta: [
        { name: 'description', content: 'Consolidación automática, información verificable y dashboards creados mediante inteligencia artificial.' },
        { name: 'robots', content: 'noindex' },
      ],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },
  typescript: { strict: true },
});
