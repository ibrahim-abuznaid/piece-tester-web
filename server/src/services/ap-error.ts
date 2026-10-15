/**
 * Parse a piece's failure into a human message + optional AP error code/HTTP status.
 * Pure — no I/O. Both the Health board and the Linear report path use this so a red is
 * read the same way everywhere.
 *
 * The stored step error is the wrapper built in ai-config-generator.ts:
 *   { status: 'FAILED', errorMessage: <string, often JSON>, output: <step output> }
 * and AP's real error is usually a JSON string two levels deep:
 *   { __apErrorVersion, message, code, status }
 */
export interface ParsedApError {
  message: string;
  code?: string;
  status?: number;
  responseBody?: unknown;
  raw: string; // full detail, pretty-printed when JSON, for a code block
}

const firstLine = (s: string): string => s.split('\n')[0].trim();
const pretty = (o: unknown): string => {
  try { return JSON.stringify(o, null, 2); } catch { return String(o); }
};

export function parseApError(raw: string): ParsedApError {
  let outer: any;
  try { outer = JSON.parse(raw); } catch { return { message: firstLine(raw), raw }; }

  // 1. AP wrapper: dig into errorMessage (parse it as JSON when possible).
  if (outer && outer.errorMessage != null) {
    let nested: any = outer.errorMessage;
    if (typeof nested === 'string') {
      try { nested = JSON.parse(nested); } catch { /* plain string, keep as-is */ }
    }
    if (nested && typeof nested === 'object') {
      const status = typeof nested.status === 'number' ? nested.status
        : typeof nested.statusCode === 'number' ? nested.statusCode : undefined;
      return {
        message: typeof nested.message === 'string' ? nested.message : firstLine(String(outer.errorMessage)),
        code: typeof nested.code === 'string' ? nested.code : undefined,
        status,
        responseBody: nested.responseBody,
        raw: pretty(nested),
      };
    }
    return { message: firstLine(String(outer.errorMessage)), raw: pretty(outer) };
  }

  // 2. Trigger onEnable/onDisable failure: the real error is in params.standardError.
  if (outer?.params?.standardError) {
    return { message: firstLine(String(outer.params.standardError)), raw: pretty(outer) };
  }

  // 3. Fastify validation and similar: top-level message.
  if (typeof outer?.message === 'string') {
    return { message: firstLine(outer.message), raw: pretty(outer) };
  }

  return { message: firstLine(raw), raw: pretty(outer) };
}
