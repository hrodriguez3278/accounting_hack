import { defineStore } from 'pinia';

export interface Me {
  user_id: string; email: string; full_name: string; organization_id: string; role: string; presentation_currency: string;
  all_companies: boolean; permissions: string[]; memberships: Array<{ organizationId: string; name: string; role: string }>; ai_provider: string;
}
export interface Version {
  id: string; code: string; name: string; kind: string; fiscal_year: number; rate_scenario: string; includes_balance_sheet: boolean;
  latest_run: { id: string; status: string; created_at: string; published_at: string | null } | null; published_run_id: string | null;
}
export interface Company { id: string; code: string; name: string; country_code: string; functional_currency: string }
export interface Reference {
  companies: Company[]; versions: Version[];
  accounts: Array<{ id: string; code: string; name: string; category: string; statement: string; consolidation_only: boolean }>;
  currencies: Array<{ code: string; name: string }>;
}

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export const useSessionStore = defineStore('session', {
  state: () => ({
    me: null as Me | null,
    reference: null as Reference | null,
    organizationId: (import.meta.client ? readStorage('nexora-org') : null) as string | null,
    period: '2027',
    theme: 'light' as 'light' | 'dark',
  }),
  getters: {
    can: (s) => (perm: string) => !!s.me?.permissions.includes(perm),
    currency: (s) => s.me?.presentation_currency ?? 'USD',
    publishedBudget: (s) => s.reference?.versions.filter((v) => v.kind === 'budget' && v.published_run_id)
      .sort((a, b) => String(b.latest_run?.published_at ?? '').localeCompare(String(a.latest_run?.published_at ?? '')))[0] ?? null,
    versionByCode: (s) => (code: string) => s.reference?.versions.find((v) => v.code === code) ?? null,
  },
  actions: {
    async load() {
      const api = useApi();
      this.me = await api.get<Me>('/api/me');
      this.organizationId = this.me.organization_id;
      try { localStorage.setItem('nexora-org', this.organizationId); } catch { /* almacenamiento no disponible */ }
      await this.refreshReference();
    },
    async refreshReference() {
      this.reference = await useApi().get<Reference>('/api/reference');
      const years = this.reference.versions.map((v) => v.fiscal_year);
      if (years.length) this.period = String(Math.max(...years));
    },
    async switchOrg(id: string) {
      this.organizationId = id;
      await this.load();
    },
    setTheme(t: 'light' | 'dark') {
      this.theme = t;
      document.documentElement.classList.toggle('dark', t === 'dark');
      try { localStorage.setItem('nexora-theme', t); } catch { /* sin almacenamiento */ }
    },
    initTheme() {
      const t = readStorage('nexora-theme');
      this.setTheme(t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light');
    },
  },
});
