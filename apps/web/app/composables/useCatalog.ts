/** Catálogo de indicadores (nombres de negocio), cargado una sola vez por sesión. */
const names = ref<Record<string, string>>({});
let loading: Promise<void> | null = null;

export function useCatalog() {
  if (!loading) {
    loading = useApi().get<{ metrics: Array<{ code: string; name: string }> }>('/api/semantic/catalog')
      .then((c) => { names.value = Object.fromEntries(c.metrics.map((m) => [m.code, m.name])); })
      .catch(() => { loading = null; });
  }
  const metricName = (code: string) => names.value[code] ?? code;
  return { names, metricName };
}
