import type { Tool } from './tool-types.js';
import {
  CHINESE_PLAN_TOOL_INVOCATION_RE,
  ENGLISH_PLAN_TOOL_INVOCATION_RE,
} from '../../prompts/plan-detection.js';

function extractUrlCandidate(text: string, toolName: string): string | null {
  const URL_RE = /https?:\/\/[^\s<>"'`，,。；;）)】\]]+/gi;
  const urls: { url: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    urls.push({ url: m[0]!, index: m.index });
  }
  if (urls.length === 0) return null;
  if (urls.length === 1) return urls[0]!.url;

  const toolRe = new RegExp(`\\b${toolName}\\b`, 'i');
  const toolMatch = toolRe.exec(text);
  const urlKeywordRe = /(?:url|链接|地址|网址|uri)[=：:\s]*/gi;
  const keywordMatches: number[] = [];
  let km: RegExpExecArray | null;
  while ((km = urlKeywordRe.exec(text)) !== null) {
    keywordMatches.push(km.index);
  }
  const anchors: number[] = [];
  if (toolMatch) anchors.push(toolMatch.index);
  anchors.push(...keywordMatches);

  if (anchors.length > 0) {
    let best = urls[0]!;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const entry of urls) {
      for (const a of anchors) {
        const d = Math.abs(entry.index - a);
        if (d < bestDist) {
          bestDist = d;
          best = entry;
        }
      }
    }
    if (bestDist <= 80) return best.url;
  }
  return urls[0]!.url;
}

function isUrlLikeProperty(name: string, schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const s = schema as Record<string, unknown>;
  if (s.type !== 'string') return false;
  const lower = name.toLowerCase();
  if (lower === 'url' || lower === 'uri' || lower === 'href' || lower === 'link') return true;
  const desc = String(s.description ?? '').toLowerCase();
  if (/\b(url|uri|http|https)\b/.test(desc)) return true;
  if (/链接|网址|地址/.test(String(s.description ?? ''))) return true;
  return false;
}

function matchNumber(text: string, name: string): number | null {
  const re = new RegExp(`${name}\\s*[=：:]\\s*(-?\\d+(?:\\.\\d+)?)`, 'i');
  const m = re.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function matchBoolean(text: string, name: string): boolean | null {
  const re = new RegExp(`${name}\\s*[=：:]\\s*(true|false|是|否|开|关|on|off)`, 'i');
  const m = re.exec(text);
  if (!m) return null;
  const v = m[1]!.toLowerCase();
  if (v === 'true' || v === '是' || v === '开' || v === 'on') return true;
  return false;
}

export interface ExtractedToolInvocation {
  name: string;
  input: Record<string, unknown>;

  satisfiedRequired: string[];

  missingRequired: string[];
}

export function extractToolInvocationFromPlanText(
  text: string,
  tools: readonly Tool[]
): ExtractedToolInvocation | null {
  const t = String(text || '');
  if (!t.trim()) return null;

  const candidates: string[] = [];
  for (const baseRe of [CHINESE_PLAN_TOOL_INVOCATION_RE, ENGLISH_PLAN_TOOL_INVOCATION_RE]) {
    const planRe = new RegExp(baseRe.source, baseRe.flags);
    let m: RegExpExecArray | null;
    while ((m = planRe.exec(t)) !== null) {
      const raw = m[1]!.toLowerCase();
      if (!candidates.includes(raw)) candidates.push(raw);
    }
    if (candidates.length > 0) break;
  }
  if (candidates.length === 0) return null;

  const toolByName = new Map(tools.map((tool) => [tool.name.toLowerCase(), tool]));

  for (const candidate of candidates) {
    const tool = toolByName.get(candidate);
    if (!tool) continue;
    const schema = tool.inputSchema;
    const required = Array.isArray(schema?.required) ? schema.required : [];
    const props = (schema?.properties ?? {}) as Record<string, unknown>;

    const input: Record<string, unknown> = {};
    const satisfied: string[] = [];
    const missing: string[] = [];

    for (const name of required) {
      const propSchema = props[name];
      if (!propSchema || typeof propSchema !== 'object') {
        missing.push(name);
        continue;
      }
      const type = (propSchema as Record<string, unknown>).type;

      if (isUrlLikeProperty(name, propSchema)) {
        const url = extractUrlCandidate(t, tool.name);
        if (url) {
          input[name] = url;
          satisfied.push(name);
        } else {
          missing.push(name);
        }
        continue;
      }
      if (type === 'number' || type === 'integer') {
        const n = matchNumber(t, name);
        if (n !== null) {
          input[name] = n;
          satisfied.push(name);
        } else {
          missing.push(name);
        }
        continue;
      }
      if (type === 'boolean') {
        const b = matchBoolean(t, name);
        if (b !== null) {
          input[name] = b;
          satisfied.push(name);
        } else {
          missing.push(name);
        }
        continue;
      }

      if (type === 'string') {
        const stringPatterns = [
          new RegExp(`${name}\\s*[=：:]\\s*"([^"\\n]{1,2048})"`, 'i'),
          new RegExp(`${name}\\s*[=：:]\\s*'([^'\\n]{1,2048})'`, 'i'),
          new RegExp(`${name}\\s*[=：:]\\s*\`([^\`\\n]{1,2048})\``, 'i'),
          new RegExp(`${name}\\s*[=：:]\\s*(\\S+[^\\n，,。；;]*)`, 'i'),
        ];
        let hit: string | null = null;
        for (const re of stringPatterns) {
          const sm = re.exec(t);
          if (sm && sm[1]) {
            hit = sm[1]!.trim();
            break;
          }
        }
        if (hit) {
          input[name] = hit;
          satisfied.push(name);
          continue;
        }
      }
      missing.push(name);
    }

    if (missing.length === 0) {
      return { name: tool.name, input, satisfiedRequired: satisfied, missingRequired: [] };
    }
  }
  return null;
}
