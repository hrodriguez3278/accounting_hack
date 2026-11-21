import { TOOL_SCHEMAS, toolJsonSchemas, type ToolName } from './tools.js';
import { looksLikeInjection, sanitizeUserText, verifyNumbers, type GroundingReport } from './grounding.js';
import { ANALYST_SYSTEM } from './prompts.js';
import type { AgentContext, ChatMessage, LlmProvider, ToolExecution, ToolExecutor } from './types.js';

export interface AgentAnswer {
  answer: string;
  provider: string;
  toolExecutions: ToolExecution[];
  grounding: GroundingReport;
  injectionSuspected: boolean;
  evidence: Array<{ kind: string; label: string; ref: Record<string, string> }>;
}

const MAX_STEPS = 6;

/**
 * Bucle del agente: el modelo decide qué herramientas usar; las herramientas se validan con Zod y se ejecutan
 * con los permisos del usuario. La respuesta final se verifica contra los resultados (ninguna cifra sin respaldo).
 */
export async function runAnalyst(opts: {
  provider: LlmProvider;
  question: string;
  history: ChatMessage[];
  context: AgentContext;
  allowedTools: ToolName[];
  execute: ToolExecutor;
}): Promise<AgentAnswer> {
  const question = sanitizeUserText(opts.question);
  const injectionSuspected = looksLikeInjection(question);
  const messages: ChatMessage[] = [...opts.history.slice(-8), { role: 'user', content: question }];
  const tools = toolJsonSchemas(opts.allowedTools);
  const executions: ToolExecution[] = [];
  let answer: string | null = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await opts.provider.complete({ system: ANALYST_SYSTEM, messages, tools, context: opts.context, mode: 'analyst' });
    if (!res.toolCalls.length) {
      answer = res.content ?? '';
      break;
    }
    messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls });
    for (const call of res.toolCalls) {
      const started = Date.now();
      let exec: ToolExecution;
      if (!opts.allowedTools.includes(call.name as ToolName)) {
        exec = { name: call.name, arguments: call.arguments, status: 'denied', result: { error: `Herramienta no autorizada: ${call.name}` }, durationMs: 0 };
      } else {
        const parsed = TOOL_SCHEMAS[call.name as ToolName].schema.safeParse(call.arguments);
        if (!parsed.success) {
          exec = { name: call.name, arguments: call.arguments, status: 'invalid',
            result: { error: `Argumentos inválidos: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` }, durationMs: 0 };
        } else {
          try {
            const r = await opts.execute(call.name, parsed.data);
            exec = { name: call.name, arguments: parsed.data, status: r.status, result: r.result, durationMs: Date.now() - started };
          } catch (e) {
            exec = { name: call.name, arguments: parsed.data, status: 'error', result: { error: (e as Error).message }, durationMs: Date.now() - started };
          }
        }
      }
      executions.push(exec);
      // Los resultados se envían como datos; el prompt del sistema prohíbe seguir instrucciones contenidas en ellos
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(exec.result).slice(0, 60_000) });
    }
  }
  if (answer === null) answer = 'No fue posible completar el análisis dentro del límite de pasos. Dato no disponible.';

  const grounding = verifyNumbers(answer, executions.filter((e) => e.status === 'ok').map((e) => e.result));
  if (!grounding.verified) {
    answer += `\n\n⚠ Verificación: ${grounding.unverified.length} cifra(s) no coinciden con resultados de herramientas (${grounding.unverified.slice(0, 5).join(', ')}). No deben considerarse oficiales.`;
  }
  return { answer, provider: opts.provider.name, toolExecutions: executions, grounding, injectionSuspected, evidence: evidenceOf(executions) };
}

function evidenceOf(execs: ToolExecution[]): AgentAnswer['evidence'] {
  const out: AgentAnswer['evidence'] = [];
  for (const e of execs) {
    if (e.status !== 'ok' || !e.result || typeof e.result !== 'object') continue;
    const r = e.result as Record<string, unknown>;
    if (typeof r.query_id === 'string') {
      out.push({ kind: e.name === 'compare_budget_versions' ? 'variance' : 'query', label: labelOf(e),
        ref: { query_id: r.query_id, ...(typeof r.run_id === 'string' ? { run_id: r.run_id } : {}) } });
    }
    if (e.name === 'get_lineage' && r.run && typeof r.run === 'object') {
      out.push({ kind: 'lineage', label: 'Procedencia de la métrica', ref: { run_id: String((r.run as Record<string, unknown>).id),
        metric: String((e.arguments as Record<string, unknown>).metric) } });
    }
    if (e.name === 'create_scenario' && typeof r.id === 'string') out.push({ kind: 'scenario', label: 'Escenario simulado', ref: { scenario_id: r.id } });
  }
  return out;
}

function labelOf(e: ToolExecution): string {
  const a = e.arguments as Record<string, unknown>;
  if (e.name === 'compare_budget_versions') return `Puente ${String(a.metric)}: ${String(a.compare_to)} → ${String(a.version)}`;
  if (e.name === 'query_financial_metrics') return `Consulta: ${(a.metrics as string[]).join(', ')}`;
  return e.name;
}
