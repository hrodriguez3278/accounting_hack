import OpenAI from 'openai';
import { DashboardPlan } from '@nexora/shared';
import type { AgentContext, ChatMessage, CompletionRequest, CompletionResult, LlmProvider } from './types.js';
import { contextBlock } from './prompts.js';
import { jsonSchemaFor } from './tools.js';

/**
 * Proveedor compatible con la API de OpenAI (Chat Completions + tool calling).
 * Sirve también para Ollama mediante su endpoint compatible (`${OLLAMA_BASE_URL}/v1`).
 * El modelo nunca recibe credenciales de base de datos ni puede ejecutar SQL: solo herramientas tipadas.
 */
export class OpenAICompatibleProvider implements LlmProvider {
  private readonly client: OpenAI;

  constructor(readonly name: 'openai' | 'ollama', private readonly model: string, opts: { apiKey?: string; baseURL?: string }) {
    this.client = new OpenAI({ apiKey: opts.apiKey ?? 'ollama', baseURL: opts.baseURL, timeout: 60_000, maxRetries: 1 });
  }

  /** Traduce errores del proveedor a mensajes accionables, sin exponer la llave ni el cuerpo de la solicitud. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const status = (e as { status?: number }).status;
      const msg = status === 401 ? 'la llave de API fue rechazada (401)'
        : status === 403 ? 'la llave no tiene acceso al modelo configurado (403)'
          : status === 404 ? `el modelo '${this.model}' no existe o no está disponible (404)`
            : status === 429 ? 'límite de uso o saldo agotado (429)'
              : status && status >= 500 ? `error del servicio (${status})`
                : 'no fue posible conectar con el servicio';
      throw new AiProviderError(`Proveedor de IA ${this.name}: ${msg}`);
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const res = await this.call(() => this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      messages: [
        { role: 'system', content: `${req.system}\n\n${contextBlock(req.context)}` },
        ...req.messages.map(toOpenAI),
      ],
      tools: req.tools,
      tool_choice: 'auto',
    }));
    const msg = res.choices[0]?.message;
    return {
      content: msg?.content ?? null,
      toolCalls: (msg?.tool_calls ?? []).filter((t) => t.type === 'function').map((t) => ({
        id: t.id, name: t.function.name, arguments: parseArgs(t.function.arguments),
      })),
    };
  }

  async planDashboard(instruction: string, context: AgentContext, system: string): Promise<DashboardPlan> {
    const res = await this.call(() => this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      messages: [
        { role: 'system', content: `${system}\n\n${contextBlock(context)}` },
        { role: 'user', content: instruction },
      ],
      tools: [{ type: 'function', function: { name: 'apply_dashboard_plan', description: 'Plan declarativo de cambios al dashboard',
        parameters: jsonSchemaFor(DashboardPlan) } }],
      tool_choice: { type: 'function', function: { name: 'apply_dashboard_plan' } },
    }));
    const call = res.choices[0]?.message.tool_calls?.find((t) => t.type === 'function');
    if (!call || call.type !== 'function') throw new Error('El modelo no devolvió un plan');
    return DashboardPlan.parse(parseArgs(call.function.arguments)); // validación estricta: sin código ni campos libres
  }
}

export class AiProviderError extends Error {}

function parseArgs(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}

function toOpenAI(m: ChatMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (m.role === 'user') return { role: 'user', content: m.content };
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  return {
    role: 'assistant', content: m.content,
    ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function' as const,
      function: { name: t.name, arguments: JSON.stringify(t.arguments) } })) } : {}),
  };
}
