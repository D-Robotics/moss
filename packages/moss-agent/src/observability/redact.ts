





































export interface RedactOptions {
  
  allowFields?: string[];
  
  extraPatterns?: RegExp[];
  






  skipFileContentHeuristic?: boolean;
}



const REDACTED = '[REDACTED]';
const CIRCULAR = '[CIRCULAR]';


const SENSITIVE_FIELD_PATTERN =
  /(?:^|[_-])(token|api[_-]?key|secret|password|credential|auth|private[_-]?key|access[_-]?key|connection[_-]?string|dsn|jwt|ssh[_-]?key|signing[_-]?key|encryption[_-]?key|client[_-]?secret)(?:$|[_-])/i;


const PROMPT_FIELD_PATTERN = /prompt/i;





const IPV4_PATTERN =
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/;
const IPV4_PATTERN_GLOBAL = new RegExp(IPV4_PATTERN.source, 'g');





const IPV6_PATTERN =
  /(?<![0-9a-fA-F:])(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}|:(?::[0-9a-fA-F]{1,4}){1,7}|::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}|::)(?![0-9a-fA-F:])/;
const IPV6_PATTERN_GLOBAL = new RegExp(IPV6_PATTERN.source, 'g');


const URL_WITH_CREDENTIALS_PATTERN = /[a-zA-Z][a-zA-Z\d+.-]*:\/\/[^:]+:[^@]+@/;


const FILE_CONTENT_LENGTH_THRESHOLD = 200;


const FILE_CONTENT_HEURISTICS: RegExp[] = [
  /^(import |export |from |const |let |var |function |class |def |fn |pub )/m,
  /^(\{|\[|<\w)/m,
  /\n.*\n.*\n.*\n.*\n/m, 
];



function isSensitiveField(field: string, allowSet: Set<string>): boolean {
  if (allowSet.has(field)) return false;
  if (PROMPT_FIELD_PATTERN.test(field)) return true;
  if (SENSITIVE_FIELD_PATTERN.test(field)) return true;
  return false;
}

function isSensitiveValue(
  value: string,
  extraPatterns?: RegExp[],
  skipFileContent = false
): boolean {
  
  if (extraPatterns) {
    for (const pattern of extraPatterns) {
      if (pattern.test(value)) return true;
    }
  }

  
  if (URL_WITH_CREDENTIALS_PATTERN.test(value)) return true;

  
  if (!skipFileContent && value.length > FILE_CONTENT_LENGTH_THRESHOLD) {
    for (const heuristic of FILE_CONTENT_HEURISTICS) {
      if (heuristic.test(value)) return true;
    }
  }

  return false;
}



function redactIPs(value: string): string {
  return value
    .replace(IPV4_PATTERN_GLOBAL, '[IP_REDACTED]')
    .replace(IPV6_PATTERN_GLOBAL, '[IP_REDACTED]');
}



function walk(
  value: unknown,
  allowSet: Set<string>,
  extraPatterns: RegExp[] | undefined,
  seen: WeakSet<object>,
  skipFileContent: boolean
): unknown {
  
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (isSensitiveValue(value, extraPatterns, skipFileContent)) return REDACTED;
    return redactIPs(value);
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint'
  ) {
    return value;
  }
  if (typeof value === 'function') {
    return value;
  }

  
  if (typeof value !== 'object') return value;

  
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, allowSet, extraPatterns, seen, skipFileContent));
  }

  
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      const key = String(k);
      if (isSensitiveField(key, allowSet)) {
        obj[key] = REDACTED;
      } else {
        obj[key] = walk(v, allowSet, extraPatterns, seen, skipFileContent);
      }
    }
    return obj;
  }
  if (value instanceof Set) {
    return [...value].map((item) => walk(item, allowSet, extraPatterns, seen, skipFileContent));
  }
  if (value instanceof Date) return value.toISOString();

  
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveField(key, allowSet)) {
      result[key] = REDACTED;
    } else if (typeof val === 'string' && isSensitiveValue(val, extraPatterns, skipFileContent)) {
      result[key] = REDACTED;
    } else {
      result[key] = walk(val, allowSet, extraPatterns, seen, skipFileContent);
    }
  }
  return result;
}










export function redactSensitiveData(obj: unknown, options?: RedactOptions): unknown {
  const allowSet = new Set<string>(options?.allowFields ?? []);
  
  for (const field of parseTelemetryAllow()) {
    allowSet.add(field);
  }
  const seen = new WeakSet<object>();
  return walk(
    obj,
    allowSet,
    options?.extraPatterns,
    seen,
    options?.skipFileContentHeuristic ?? false
  );
}









export function parseTelemetryAllow(): Set<string> {
  const raw = process.env.MOSS_TELEMETRY_ALLOW;
  if (!raw || typeof raw !== 'string') return new Set();
  const fields = raw
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  const allowed = new Set<string>();
  for (const field of fields) {
    if (SENSITIVE_FIELD_PATTERN.test(field) || PROMPT_FIELD_PATTERN.test(field)) {
      console.warn(`[redact] MOSS_TELEMETRY_ALLOW: rejected sensitive field "${field}"`);
      continue;
    }
    allowed.add(field);
  }
  return allowed;
}
