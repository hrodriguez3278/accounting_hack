import { createClient } from '@supabase/supabase-js';

/** Cliente de Supabase en el navegador: solo autenticación y solo con la clave publicable. */
export default defineNuxtPlugin(() => {
  const cfg = useRuntimeConfig().public;
  const supabase = createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'nexora-auth' },
  });
  return { provide: { supabase } };
});
