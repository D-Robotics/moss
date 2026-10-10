import { quoteOpensValue, REDACTED, SECRET_FIELD_SOURCE } from './redact-patterns.js';

type SecretRule = {
  source: string;
  flags: string;
  label: string;
  groupIdx?: number;
  /** The value's opening quote must actually open a string, not close one. */
  openingQuote?: boolean;
};

const SECRET_RULES: SecretRule[] = [
  { source: '\\b(sk-ant-[a-zA-Z0-9_-]{20,})\\b', flags: 'g', label: 'Anthropic key' },
  { source: '\\b(sk-[a-zA-Z0-9_-]{20,})\\b', flags: 'g', label: 'OpenAI key' },
  { source: '\\b(gsk_[a-zA-Z0-9]{20,})\\b', flags: 'g', label: 'Groq key' },
  { source: '\\b(xai-[a-zA-Z0-9]{20,})\\b', flags: 'g', label: 'xAI key' },
  { source: '\\b(AIza[a-zA-Z0-9_-]{30,})\\b', flags: 'g', label: 'Google key' },
  { source: '\\b(ghp_[a-zA-Z0-9]{36,})\\b', flags: 'g', label: 'GitHub token' },
  {
    source: '\\b(github_pat_[a-zA-Z0-9_]{20,})\\b',
    flags: 'g',
    label: 'GitHub fine-grained token',
  },
  { source: '\\b(glpat-[a-zA-Z0-9_-]{20,})\\b', flags: 'g', label: 'GitLab token' },
  { source: '\\b(AKIA[A-Z0-9]{16})\\b', flags: 'g', label: 'AWS access key' },
  { source: '\\b(sk_live_[a-zA-Z0-9]{20,})\\b', flags: 'g', label: 'Stripe live key' },
  { source: '\\b(sk_test_[a-zA-Z0-9]{20,})\\b', flags: 'g', label: 'Stripe test key' },
  { source: '\\b(xoxb-[a-zA-Z0-9-]{20,})\\b', flags: 'g', label: 'Slack bot token' },
  {
    source: '(eyJ[a-zA-Z0-9_-]{10,}\\.eyJ[a-zA-Z0-9_-]{10,}\\.[a-zA-Z0-9_=+-]{10,})',
    flags: 'g',
    label: 'JWT',
  },
  {
    source:
      '(?:password|passwd|pwd|secret|token|apikey|api_key|api-key|access_key)\\s*[:=]\\s*[\'"]([^\'"\\r\\n]{6,})(?:[\'"]|$)',
    flags: 'gim',
    label: 'credential value',
    groupIdx: 1,
    openingQuote: true,
  },
  // HTTP Authorization Bearer token — `Authorization: Bearer <token>`. The
  // credential-value pattern above only matches when a secret keyword precedes
  // `[:=]`; here the keyword (Bearer) follows the colon, so without this rule
  // an API key in `curl -H "Authorization: Bearer sk-ant-…"` would not be
  // masked in approval prompts / logs.
  {
    source: '(?:authorization|auth)\\s*[:=]\\s*[\'"]?bearer\\s+([a-zA-Z0-9_\\-.=]+)',
    flags: 'gi',
    label: 'Bearer token',
    groupIdx: 1,
  },
  // HTTP Authorization Basic — `Authorization: Basic <base64>`. The base64
  // encodes `user:password` and is trivially decodable, so it must be masked
  // in approval prompts / logs just like a Bearer token. Without this rule,
  // `curl -H "Authorization: Basic $(echo -n user:pass | base64)"` would
  // expose the credential.
  {
    source: '(?:authorization|auth)\\s*[:=]\\s*[\'"]?basic\\s+([A-Za-z0-9+/=]{8,})',
    flags: 'gi',
    label: 'Basic auth credential',
    groupIdx: 1,
  },
  { source: 'sig=([A-Za-z0-9\\-_=%]{10,})', flags: 'gi', label: 'Azure SAS token', groupIdx: 1 },
  {
    source: '(?:AccountKey|SharedAccessKey|Password)=\\S{8,}',
    flags: 'gi',
    label: 'Azure connection string',
  },
  {
    source: '"private_key"\\s*:\\s*"-----BEGIN (?:RSA )?PRIVATE KEY-----[^"]{20,}',
    flags: 'gi',
    label: 'GCP service account',
  },
  { source: '\\bnpm_[A-Za-z0-9]{36,}\\b', flags: 'g', label: 'npm token' },
  { source: 'pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}', flags: 'g', label: 'PyPI token' },
  { source: 'dckr_pat_[A-Za-z0-9_-]{27,}', flags: 'g', label: 'Docker registry token' },
  {
    source: 'CLOUDFLARE_(?:API_TOKEN|API_KEY)[\\s=:]+[A-Za-z0-9_-]{20,}',
    flags: 'gi',
    label: 'Cloudflare API token',
  },
  { source: 'vercel_(?:token|secret)_[A-Za-z0-9]{24,}', flags: 'gi', label: 'Vercel token' },
];

function buildPattern(rule: SecretRule): RegExp {
  return new RegExp(rule.source, rule.flags);
}

function leadingIndent(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i += 1;
  return i;
}

function closesOnLine(line: string, quoteAt: number): boolean {
  const quote = line[quoteAt];
  for (let i = quoteAt + 1; i < line.length; i += 1) {
    if (line[i] === '\\') {
      i += 1;
      continue;
    }
    if (line[i] === quote) return true;
  }
  return false;
}

function hasUnescapedQuote(line: string, quote: string): boolean {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\') {
      i += 1;
      continue;
    }
    if (line[i] === quote) return true;
  }
  return false;
}

const OPEN_QUOTED_SECRET = new RegExp(`(?:${SECRET_FIELD_SOURCE})\\s*[:=]\\s*(['"])`, 'gi');

/**
 * A quoted secret that is still open at the end of its line, with a closer
 * on a more-indented line within the next three lines. Each of those lines
 * becomes `[REDACTED]` so the line count stays put. A quote that merely
 * closes a string around the key is not an opening quote.
 */
export function maskIndentedQuoteContinuations(text: string): string {
  if (!text.includes('\n')) return text;
  const lines = text.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const masked = new Set<number>();
  for (let i = 0; i < lines.length; i += 1) {
    if (masked.has(i)) continue;
    const line = lines[i] ?? '';
    const lineStart = starts[i] ?? 0;
    OPEN_QUOTED_SECRET.lastIndex = 0;
    let openQuote: string | undefined;
    let quoteAt = -1;
    for (const match of line.matchAll(OPEN_QUOTED_SECRET)) {
      const local = (match.index ?? 0) + match[0].length - 1;
      const abs = lineStart + local;
      if (!quoteOpensValue(text, abs) || closesOnLine(line, local)) continue;
      const rest = line.slice(local + 1).trim();
      if (!rest || rest.startsWith('${') || rest.startsWith('$') || rest.startsWith('<')) continue;
      openQuote = line[local];
      quoteAt = local;
      break;
    }
    if (!openQuote || quoteAt < 0) continue;
    const keyIndent = leadingIndent(line);
    const follow: number[] = [];
    let closed = false;
    for (let j = 1; j <= 3 && i + j < lines.length; j += 1) {
      const next = lines[i + j] ?? '';
      if (next.trim() === '') continue;
      if (leadingIndent(next) <= keyIndent) break;
      follow.push(i + j);
      if (hasUnescapedQuote(next, openQuote)) {
        closed = true;
        break;
      }
    }
    if (!closed) continue;
    for (const idx of follow) {
      const indent = (lines[idx] ?? '').match(/^[ \t]*/)?.[0] ?? '';
      lines[idx] = `${indent}${REDACTED}`;
      masked.add(idx);
    }
  }
  return lines.join('\n');
}

function maskValue(value: string): string {
  if (value.length <= 4) return '***';
  const visible = Math.min(4, Math.floor(value.length * 0.15));
  return value.slice(0, visible) + '***' + value.slice(-2);
}

export function sanitizeSecrets(text: string): string {
  if (!text || typeof text !== 'string') return text ?? '';
  let result = maskIndentedQuoteContinuations(text);
  for (const rule of SECRET_RULES) {
    const pattern = buildPattern(rule);
    if (rule.groupIdx !== undefined) {
      const gi = rule.groupIdx;
      result = result.replace(pattern, (...args) => {
        const full: string = args[0];
        const captured: string = args[gi];
        if (typeof captured !== 'string' || !captured) return full;
        if (rule.openingQuote) {
          const rel = full.lastIndexOf(captured);
          const offset = args[args.length - 2];
          const whole = args[args.length - 1];
          if (typeof offset !== 'number' || typeof whole !== 'string' || rel <= 0) return full;
          if (!quoteOpensValue(whole, offset + rel - 1)) return full;
        }
        return full.replace(captured, maskValue(captured));
      });
    } else {
      result = result.replace(pattern, (match) => maskValue(match));
    }
  }
  return result;
}

export function containsSecrets(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  for (const rule of SECRET_RULES) {
    const pattern = new RegExp(rule.source, rule.flags.replace('g', ''));
    if (pattern.test(text)) return true;
  }
  return false;
}
