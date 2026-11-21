/**
 * Verificación de cifras: toda cifra presente en la respuesta debe corresponder a un valor devuelto por
 * una herramienta (con la misma escala y redondeo de presentación). Lo que no se pueda verificar se señala.
 */

const NUM = /(?<![\w-])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\w-])-?\d+(?:\.\d+)?/g;

export interface GroundingReport {
  checked: number;
  unverified: string[];
  verified: boolean;
}

export function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (value === null || value === undefined) return out;
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value);
  else if (typeof value === 'string') {
    if (/^-?\d+(\.\d+)?$/.test(value.trim())) out.push(Number(value));
  } else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, out));
  else if (typeof value === 'object') Object.values(value as Record<string, unknown>).forEach((v) => collectNumbers(v, out));
  return out;
}

function decimalsOf(token: string): number {
  const i = token.indexOf('.');
  return i < 0 ? 0 : token.length - i - 1;
}

export function verifyNumbers(answer: string, toolResults: unknown[]): GroundingReport {
  const pool = collectNumbers(toolResults);
  // Derivados triviales permitidos: diferencias y sumas de pares no se generan aquí; el motor ya los entrega calculados.
  const tokens = [...answer.replace(/\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])\b/g, ' ').matchAll(NUM)].map((m) => ({ raw: m[0], idx: m.index ?? 0 }));
  const unverified: string[] = [];
  let checked = 0;
  for (const t of tokens) {
    const clean = t.raw.replace(/,/g, '');
    const n = Number(clean);
    if (!Number.isFinite(n)) continue;
    const before = answer.slice(Math.max(0, t.idx - 12), t.idx);
    const after = answer.slice(t.idx + t.raw.length, t.idx + t.raw.length + 3);
    // Se ignoran años, códigos (V2, ALT-GT1, cuenta 4000) y ordinales pequeños de enumeración
    if (/^(19|20)\d{2}$/.test(clean) && !/\.\d/.test(t.raw)) continue;
    if (/(V|versión |version |cuenta |ALT-[A-Z]{2}|fila |#)$/i.test(before)) continue;
    if (/^[A-Z]/.test(after) && !/^(M|K|USD)/.test(after)) continue;
    if (Number.isInteger(n) && Math.abs(n) <= 12 && !/[%M]/.test(after)) continue;
    checked += 1;
    const d = decimalsOf(clean);
    const tol = 0.5 * 10 ** -d + 1e-9;
    const isPct = /^\s?%/.test(after) || /^\s?pp/.test(after);
    const word = answer.slice(t.idx + t.raw.length, t.idx + t.raw.length + 10).toLowerCase();
    const isMillions = /^\s?M\b/.test(after) || /^\s?(millones|millón|millon|mm)\b/.test(word);
    const isThousands = /^\s?K\b/.test(after) || /^\s?mil\b/.test(word);
    const scales = isPct ? [100] : isMillions ? [1e-6] : isThousands ? [1e-3] : [1, 100];
    const ok = pool.some((v) => scales.some((s) => Math.abs(Math.abs(v * s) - Math.abs(n)) <= tol));
    if (!ok) unverified.push(t.raw + (isPct ? ' %' : isMillions ? ' M' : ''));
  }
  return { checked, unverified, verified: unverified.length === 0 };
}

/** Patrones típicos de inyección de instrucciones en texto de usuario o de datos. */
export function looksLikeInjection(text: string): boolean {
  return /(ignora|olvida|ignore|disregard).{0,40}(instrucciones|instructions|reglas|rules|sistema|system)|act[uú]a como|you are now|system prompt|service[_ ]role|select\s+\*\s+from|drop\s+table|;\s*--/i.test(text);
}

export function sanitizeUserText(text: string, max = 2000): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max).trim();
}
