










export const CHINESE_PLAN_TOOL_INVOCATION_RE =
  /(?:我(?:来|要|去|将|先)|让我|然后|接下来|紧接(?:下来|着)|最后|下一步|下面|首先|随后).{0,20}?调用(?:这个|一下|该)?(?:工具)?\s*\b([a-z][a-z0-9_]{2,64})\b/gi;


export const NOISE_PLANNED_TOOL_NAMES = new Set(
  [
    'http',
    'https',
    'json',
    'url',
    'uri',
    'api',
    'the',
    'and',
    'for',
    'not',
    'you',
    'any',
    'all',
    'can',
    'tool',
    'call',
    'args',
    'null',
    'true',
    'false',
    'function',
    'object',
    'string',
    'number',
    'type',
    'this',
    'that',
    'with',
    'from',
    'into',
    'using',
  ].map((s) => s.toLowerCase())
);





export const ENGLISH_PLAN_TOOL_INVOCATION_RE =
  /(?:let me|I(?:'ll| will| would)?(?: now| just| first)?)\s+(?:call|use|invoke|run|try|execute)\s+(?:the\s+)?`?([a-z][a-z0-9_]{2,64})`?/gi;


export const ENGLISH_PLAN_NEGATION_BEFORE_RE =
  /(?:no|not|don't|won't|skip|avoid|without|no need|unnecessary)\s*$/i;


export const CHINESE_PLAN_NEGATION_BEFORE_RE = /(?:不|别|无需|不必|不用|无法|没有|未能|不要|勿)$/;





export const WEB_INTENT_TOOL_NAME_ALLOWLIST = [
  'web_fetch',
  'web_search',
  'open_url',
  'open_browser',
  'browser_capture',
  'doc_search',
  'doc_search_local',
] as const;

function looksLikeWebIntentToolName(toolName: string): boolean {
  const n = toolName.toLowerCase();
  return (
    WEB_INTENT_TOOL_NAME_ALLOWLIST.includes(n as (typeof WEB_INTENT_TOOL_NAME_ALLOWLIST)[number]) ||
    /^web_/.test(n) ||
    /(?:^|_)open_url$/.test(n) ||
    /browser/.test(n) ||
    /^doc_search(?:_|$)/.test(n)
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}




export function buildNamedWebToolMatcher(registeredToolNames: readonly string[]): RegExp {
  const allow = new Set(WEB_INTENT_TOOL_NAME_ALLOWLIST.map((x) => x.toLowerCase()));
  const matched = registeredToolNames
    .map((n) => n.trim())
    .filter((n) => n.length > 0 && (allow.has(n.toLowerCase()) || looksLikeWebIntentToolName(n)));
  if (matched.length === 0) return /(?!)/;
  const alt = [...new Set(matched.map((n) => escapeRegExp(n)))].sort().join('|');
  return new RegExp(`\\b(?:${alt})\\b`, 'i');
}
