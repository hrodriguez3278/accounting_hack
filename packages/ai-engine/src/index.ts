export * from './types.js';
export * from './tools.js';
export * from './grounding.js';
export * from './prompts.js';
export * from './agent.js';
export * from './local-provider.js';
export * from './openai-provider.js';
import { DashboardPlan } from '@nexora/shared';
import { DASHBOARD_SYSTEM } from './prompts.js';
import { LocalRulesProvider } from './local-provider.js';
import { OpenAICompatibleProvider } from './openai-provider.js';
import type { AgentContext, LlmProvider } from './types.js';
import { sanitizeUserText } from './grounding.js';

export interface ProviderConfig {
  AI_PROVIDER: 'openai' | 'ollama' | 'local';
  OPENAI_API_KEY?: string;
  OPENAI_MODEL: string;
  OLLAMA_BASE_URL: string;
  OLLAMA_MODEL: string;
}

/** Proveedor configurable. Sin credenciales de OpenAI se usa el proveedor local determinista. */
export function createProvider(cfg: ProviderConfig): LlmProvider {
  if (cfg.AI_PROVIDER === 'openai' && cfg.OPENAI_API_KEY) {
    return new OpenAICompatibleProvider('openai', cfg.OPENAI_MODEL, { apiKey: cfg.OPENAI_API_KEY });
  }
  if (cfg.AI_PROVIDER === 'ollama') {
    return new OpenAICompatibleProvider('ollama', cfg.OLLAMA_MODEL, { baseURL: `${cfg.OLLAMA_BASE_URL.replace(/\/$/, '')}/v1` });
  }
  return new LocalRulesProvider();
}

/** Intent Interpreter del Dashboard Studio: instrucción → plan declarativo validado. */
export async function planDashboard(provider: LlmProvider, instruction: string, context: AgentContext): Promise<DashboardPlan> {
  return DashboardPlan.parse(await provider.planDashboard(sanitizeUserText(instruction, 600), context, DASHBOARD_SYSTEM));
}
