import type { DashboardPlan, WidgetSpec } from '@nexora/shared';
import type { Catalog } from '@nexora/semantic-engine';

export interface ToolCall { id: string; name: string; arguments: unknown }

export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface AgentContext {
  period: string;
  defaultVersion: string;
  versions: Array<{ code: string; name: string; kind: string; published: boolean }>;
  companies: Array<{ code: string; name: string; country: string }>;
  catalog: Catalog;
  dashboard?: { id: string; name: string; widgets: Array<{ id: string; title: string; spec: WidgetSpec }> };
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  context: AgentContext;
  mode: 'analyst' | 'dashboard';
}

export interface CompletionResult { content: string | null; toolCalls: ToolCall[] }

export interface LlmProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  planDashboard(instruction: string, context: AgentContext, system: string): Promise<DashboardPlan>;
}

export interface ToolExecution {
  name: string;
  arguments: unknown;
  status: 'ok' | 'denied' | 'invalid' | 'error';
  result: unknown;
  durationMs: number;
}

/** Ejecutor de herramientas provisto por la API: aplica autorización con independencia de la IA. */
export type ToolExecutor = (name: string, args: unknown) => Promise<{ status: ToolExecution['status']; result: unknown }>;
