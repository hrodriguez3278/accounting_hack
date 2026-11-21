export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

/** Cliente REST de la API de NEXORA. Adjunta el JWT del usuario y la organización activa. */
export function useApi() {
  const { $supabase } = useNuxtApp();
  const cfg = useRuntimeConfig().public;
  const session = useSessionStore();

  async function request<T>(method: string, path: string, body?: unknown, opts: { form?: FormData } = {}): Promise<T> {
    const open = cfg.authMode === 'none';
    const headers: Record<string, string> = {};
    if (!open) {
      const { data } = await $supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        await navigateTo('/auth/login');
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sesión requerida');
      }
      headers.authorization = `Bearer ${token}`;
    }
    if (session.organizationId) headers['x-organization-id'] = session.organizationId;
    if (body !== undefined && !opts.form) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(`${cfg.apiUrl}${path}`, { method, headers, body: opts.form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    } catch {
      throw new ApiError(0, 'OFFLINE', 'No se pudo contactar la API. Verifique que el servicio esté en ejecución.');
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const e = json?.error ?? {};
      if (res.status === 401 && !open) await navigateTo('/auth/login');
      throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? `Error ${res.status}`, e.details);
    }
    return json as T;
  }

  return {
    get: <T>(p: string) => request<T>('GET', p),
    post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
    del: <T>(p: string) => request<T>('DELETE', p),
    upload: <T>(p: string, form: FormData) => request<T>('POST', p, undefined, { form }),
  };
}

/** Carga asíncrona con estados de carga, error y vacío. */
export function useAsync<T>(fn: () => Promise<T>, opts: { immediate?: boolean } = { immediate: true }) {
  const data = ref<T | null>(null) as Ref<T | null>;
  const error = ref<string | null>(null);
  const loading = ref(false);
  async function run() {
    loading.value = true;
    error.value = null;
    try { data.value = await fn(); } catch (e) { error.value = (e as Error).message; } finally { loading.value = false; }
    return data.value;
  }
  if (opts.immediate !== false) run();
  return { data, error, loading, run };
}
