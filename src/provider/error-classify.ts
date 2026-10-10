import { sanitizeSecrets } from '../safety/secret-sanitizer.js';
import { redactGatewayText } from '../safety/tool-output-redact.js';
import { preferredLocale } from '../utils/locale-preference.js';
import type { ProviderErrorResponse } from './errors.js';
import {
  isAbortFailure,
  isAuthFailure,
  isAuthStatus,
  isConnectionError,
  isPrematureStreamClose,
  isQuotaExceededError,
  isRateLimitFailure,
  isServerErrorFailure,
  isThinkingHistoryCorruption,
  isTimeoutFailure,
} from './errors.js';
import { isOverflowMessage } from './overflow-patterns.js';

/** Stable category assigned to a provider/runtime failure. @public */
export type ProviderErrorCategory =
  | 'auth'
  | 'context_corruption'
  | 'timeout'
  | 'rate_limit'
  | 'quota_exceeded'
  | 'aborted_by_user'
  | 'aborted_by_server'
  | 'network'
  | 'model_not_found'
  | 'region'
  | 'service_unavailable'
  | 'context_length_exceeded'
  | 'tools_not_supported'
  | 'streaming_not_supported'
  | 'empty_response'
  | 'runtime_lifecycle'
  | 'unknown'
  | 'ambiguous';

/** Recovery action a host can present. @public */
export interface ProviderErrorAction {
  id:
    | 'retry'
    | 'openSettings'
    | 'switchModel'
    | 'newSession'
    | 'resetSession'
    | 'useFallbackProvider'
    | 'openBoardAgent';
  label: string;
  variant: 'primary' | 'secondary' | 'ghost';
}

/** Host-facing sanitized provider/runtime failure. @public */
export interface ProviderErrorSurface {
  category: ProviderErrorCategory;
  userMessage: string;
  actions: ProviderErrorAction[];
  silent: boolean;
  retryable: boolean;
}

export interface ProviderErrorInput {
  errorMessage?: string;
  status?: number;
  code?: string;
  abortReason?: 'user' | 'server' | 'timeout';
  provider?: string;
  baseUrl?: string;
  /** Overrides the process locale for this classification. */
  locale?: string;
  /** Setup is already on screen, so a 401 must not say "run moss setup". */
  audience?: 'setup' | 'chat';
  lane?: 'quick' | 'thinking';
  /** Unified error response. status/code/provider are read from here when set. */
  providerErrorResponse?: ProviderErrorResponse;
}

const SILENT_USER_ABORT: ProviderErrorSurface = {
  category: 'aborted_by_user',
  userMessage: '',
  actions: [],
  silent: true,
  retryable: false,
};

/** Chosen once per call. Action labels are fixed at module load. */
let activeLocale: string | undefined;

function isZhEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^zh/i.test(activeLocale ?? preferredLocale(env) ?? '');
}

function msg(zh: string, en: string): string {
  return isZhEnv() ? zh : en;
}

function action(
  id: ProviderErrorAction['id'],
  zh: string,
  en: string,
  variant: ProviderErrorAction['variant']
): ProviderErrorAction {
  return { id, label: msg(zh, en), variant };
}

const RETRY = action('retry', '重试', 'Retry', 'primary');
const SETTINGS = action('openSettings', '打开设置', 'Open settings', 'secondary');
const BOARD = action('openBoardAgent', '检查板端智能体', 'Check board agent', 'primary');
const SWITCH = action('switchModel', '换个模型', 'Switch model', 'ghost');
const NEW_SESSION = action('newSession', '开新对话', 'New session', 'ghost');
const RETRY_SWITCH = [RETRY, SWITCH];
const SETTINGS_SWITCH = [SETTINGS, SWITCH];
const RETRY_SETTINGS = [RETRY, SETTINGS];
const SETTINGS_RETRY = [SETTINGS, RETRY];

function matchContextCorruption(text: string): {
  hit: boolean;
  flavor: 'thinking' | 'tool' | null;
} {
  if (isThinkingHistoryCorruption(text)) return { hit: true, flavor: 'thinking' };
  const lower = text.toLowerCase();
  if (lower.includes('tool result') && lower.includes('not found'))
    return { hit: true, flavor: 'tool' };
  // DeepSeek SDK 2013: a tool_result id that is not in the current context.
  if (/\(2013\)/.test(lower)) return { hit: true, flavor: 'tool' };
  return { hit: false, flavor: null };
}

function inferLocalInferenceStack(input: ProviderErrorInput): boolean {
  const provider = String(input.provider || '').toLowerCase();
  const raw = `${input.baseUrl || ''}|${input.errorMessage || ''}`.toLowerCase();
  return (
    provider === 'ollama' ||
    raw.includes('localhost:11434') ||
    raw.includes('127.0.0.1:11434') ||
    raw.includes('[::1]:11434') ||
    /\boolama\b/.test(raw)
  );
}

function matchModelNotFound(text: string, code?: string): boolean {
  const normalizedCode = (code ?? '').toLowerCase();
  if (
    normalizedCode === 'model_not_found' ||
    normalizedCode === 'model_not_exist' ||
    normalizedCode === 'invalid_model'
  ) {
    return true;
  }
  if (
    /\b无效模型\b|无效\s*的?\s*模型|模型\s*无效|未知模型|没有该模型|无此模型|模型不存在/.test(
      text.trim()
    ) ||
    /\binvalid\s+model\b|invalid\s+model\s+name/.test(text.toLowerCase())
  ) {
    return true;
  }
  // A bare HTTP 404 is a wrong path. Model-missing needs these words or a code above.
  return /\bmodel[_ ]not[_ ]found\b|\bmodel not exist\b|model_not_exist|no such model|model.*does not exist|the model (?:is )?(?:has been )?deprecated|model.*not (?:available|supported|enabled|active)|the requested model is|tried to access|no access to (?:the )?model/i.test(
    text.toLowerCase()
  );
}

function isRegionRestriction(message: string, status?: number): boolean {
  if (
    /not available in your (?:country|region|territory)|unsupported (?:country|region)|region unavailable|country, region, or territory|地理位置|所在地区|地区不可用/i.test(
      message
    )
  ) {
    return true;
  }
  return status === 403 && /\b(?:region|country|territory)\b|地理位置|所在地区/i.test(message);
}

function isTlsProtocolMismatch(message: string, code?: string): boolean {
  return /wrong version number|packet length too long|\bEPROTO\b|tls_get_more_records|before secure TLS connection/i.test(
    `${code ?? ''} ${message}`
  );
}

function isTlsCertificate(message: string, code?: string): boolean {
  if (isTlsProtocolMismatch(message, code)) return false;
  return /UNABLE_TO_VERIFY|SELF_SIGNED|CERT_HAS_EXPIRED|DEPTH_ZERO|ERR_CERT_|certificate/i.test(
    `${code ?? ''} ${message}`
  );
}

/** Moss-authored tails, in match order. The gateway's own sentence stays. */
const AUTHORED_GATEWAY_TAILS: readonly RegExp[] = [
  ...[
    'check your API key\\b',
    'model name not supported by this gateway',
    'model or endpoint not found',
    'rate limited;',
    'gateway error;',
    'this model name is not available on the gateway\\.',
    'the server is not running or the port is wrong\\.',
    'check your network connection and DNS settings\\.',
    'network is unreachable\\.',
    'check network speed, firewall rules',
    "the server's certificate is invalid",
    'check HTTP_PROXY',
    'check network, proxy, DNS',
  ].map((tail) => new RegExp(`\\s+—\\s+${tail}[\\s\\S]*$`, 'i')),
  /\s*Run `\/model` to pick one[\s\S]*$/i,
  /\n\s*Supported models:[\s\S]*$/i,
  /\s*stream terminated without \[DONE\][\s\S]*$/i,
];

function isMossConnectionLead(line: string): boolean {
  const flat = line.replace(/\s+/g, ' ').trim();
  if (!flat || /^\(empty response body\)$/i.test(flat)) return true;
  if (/^Connection refused by \S+$/i.test(flat)) return true;
  if (/^DNS lookup failed for \S+$/i.test(flat)) return true;
  if (/^No route to \S+$/i.test(flat)) return true;
  if (/^Connection to \S+ (?:timed out or was reset|failed)/i.test(flat)) return true;
  if (/^TLS\/SSL certificate error for \S+$/i.test(flat)) return true;
  if (/^Proxy refused the connection to \S+/i.test(flat)) return true;
  if (/^Proxy\/protocol error connecting to \S+$/i.test(flat)) return true;
  if (/^Check that \S+ is reachable/i.test(flat)) return true;
  return (
    /^(?:TypeError: )?fetch failed for \S+/i.test(flat) &&
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(flat)
  );
}

/** A syscall or client abort, not a body the gateway wrote. */
function isTransportOnlyLine(line: string): boolean {
  if (isMossConnectionLead(line)) return true;
  const flat = line.replace(/\s+/g, ' ').trim();
  if (!flat || isHtmlDocument(flat)) return !flat;
  if (
    /^(?:[A-Za-z]+ )?(?:ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ECONNABORTED|EPIPE|EAI_NONAME|EAI_FAIL|EAI_NODATA)\b/i.test(
      flat
    )
  ) {
    return true;
  }
  if (/^(?:TypeError: )?fetch failed\b/i.test(flat)) return true;
  if (/^getaddrinfo\b/i.test(flat)) return true;
  if (/^(?:AbortError|TimeoutError|HeadersTimeoutError|BodyTimeoutError)\b/i.test(flat))
    return true;
  return /^The operation was aborted\b/i.test(flat);
}

function stripLoginPagePrefix(text: string): string {
  return text.replace(/captive portal or proxy login page:\s*/gi, '');
}

function stripAuthoredTails(text: string): string {
  let out = text;
  for (const pattern of AUTHORED_GATEWAY_TAILS) out = out.replace(pattern, '');
  return out;
}

/** Syscall or client-abort text shown under 详细信息, never as gateway body. */
function lowLevelCause(raw: string): string {
  const cleaned = stripLoginPagePrefix(raw);
  const paren = cleaned.match(
    /\(((?:ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ECONNABORTED|EPIPE)\b[^)]{0,180})\)/i
  );
  if (paren?.[1]) return paren[1].trim();
  for (const line of cleaned.split('\n')) {
    let text = line.trim();
    if (!text || isMossConnectionLead(text)) continue;
    text = stripAuthoredTails(text).trim();
    if (!text || isMossConnectionLead(text)) continue;
    if (isTransportOnlyLine(text)) return text.slice(0, 300);
  }
  return '';
}

/** The gateway's own body. Moss HTTP wrappers and connection hints are dropped. */
function gatewayDetail(raw: string): string {
  let text = stripLoginPagePrefix(
    redactGatewayText(sanitizeRawErrorForDetail(raw.replace(/\bpi-ai\b/gi, 'gateway'))).trim()
  );
  const wrapped = text.match(/^[^\n]*?\bprovider returned HTTP \d+:\s*([\s\S]*)$/i);
  if (wrapped) text = stripLoginPagePrefix((wrapped[1] ?? '').trim());
  return stripAuthoredTails(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !isTransportOnlyLine(line))
    .join('\n')
    .trim();
}

function withGatewayText(hint: string, raw: string, audience?: 'setup' | 'chat'): string {
  const detail = gatewayDetail(raw);
  if (detail)
    return hint.includes(detail)
      ? hint
      : `${hint}\n${msg('网关原文：', 'Gateway text: ')}${detail}`;
  if (audience !== 'setup') return hint;
  const cause = lowLevelCause(raw);
  if (!cause || hint.includes(cause)) return hint;
  return `${hint}\n${msg('详细信息：', 'Details: ')}${cause}`;
}

function isLoginPage(message: string): boolean {
  return /captive portal|proxy login|web authentication|please (?:log|sign) in|登录页|认证页面/i.test(
    message
  );
}

function isHtmlDocument(message: string): boolean {
  return /<!doctype\s+html|<html[\s>]|<head[\s>]/i.test(message);
}

/** A 403 HTML page from a proxy or WAF is not a rejected key. */
function isWafBlock(message: string, status?: number): boolean {
  if (status !== 403 || isLoginPage(message)) return false;
  return (
    isHtmlDocument(message) ||
    /cloudflare|web application firewall|\bwaf\b|attention required|request blocked/i.test(message)
  );
}

function matchToolUnsupported(text: string): boolean {
  return /does not support tools|tools? (?:are )?not supported|tool use (?:is )?not supported|unsupported.*tools?|function[ _]call(?:ing)? not supported|no tools? (?:are )?available/i.test(
    text.toLowerCase()
  );
}

function matchContextLengthExceeded(text: string, code?: string): boolean {
  const normalized = (code ?? '').toLowerCase();
  if (normalized === 'context_length_exceeded') return true;
  if (
    (normalized === 'invalid_request_error' || normalized === 'bad_request') &&
    /context (?:length|window|size|limit)|exceeds? .*context|上下文|窗口|超限|过长/i.test(text)
  ) {
    return true;
  }
  return isOverflowMessage(text);
}

function matchStreamingUnsupported(text: string): boolean {
  return /stream(?:ing)? (?:is )?not supported|does not support stream|stream (?:is )?disabled|cannot stream/i.test(
    text.toLowerCase()
  );
}

function matchEmptyResponse(text: string): boolean {
  return /empty (?:response|content|completion)|received (?:an )?empty|model returned empty|response had no content/i.test(
    text.toLowerCase()
  );
}

function matchRuntimeLifecycle(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /lifecyle_error|lifecycle_error|requested agent harness|agent harness .*not registered|protocol mismatch|agent session failed|occode/i.test(
      text
    ) ||
    /anthropic messages transport requires a positive maxtokens value|requires a positive maxTokens value/i.test(
      text
    ) ||
    (lower.includes('board agent') &&
      /gateway|protocol|lifecycle|harness|not registered|maxtokens/.test(lower))
  );
}

export function classifyProviderError(input: ProviderErrorInput): ProviderErrorSurface {
  const previousLocale = activeLocale;
  activeLocale = input.locale;
  try {
    return classifyProviderErrorNow(input);
  } finally {
    activeLocale = previousLocale;
  }
}

function face(
  category: ProviderErrorCategory,
  userMessage: string,
  actions: ProviderErrorAction[],
  retryable: boolean
): ProviderErrorSurface {
  return { category, userMessage, actions, silent: false, retryable };
}

type GateAttach = 'none' | 'body' | 'setup';

/** User-facing classifier copy. English is the fallback; zh is the zh voice. */
const COPY = {
  timeout: ['模型响应超时，请稍后重试。', 'The model timed out; try again shortly.'],
  aborted: ['请求被中断，请稍后重试。', 'The request was interrupted; try again shortly.'],
  timeoutSlow: [
    '模型响应超时，请稍后重试或在设置里换一个更快的模型。',
    'The model timed out; try again shortly or switch to a faster model in settings.',
  ],
  region: [
    '当前地区不可用。换服务商或地址，换一把 key 解决不了。',
    'Blocked in this region. Change the provider or base URL; a new key will not fix it.',
  ],
  login: [
    '网关返回了登录页（网络认证或代理登录），不是模型回复。请在浏览器里完成登录，或检查代理后再试。',
    'The gateway returned a login page (captive portal or proxy sign-in), not a model reply. Finish that login in a browser, or check the proxy, then retry.',
  ],
  waf: [
    '代理或防火墙拦下了请求（403 页面），不是密钥错误。请检查代理、防火墙或网络后再试。',
    'A proxy or firewall returned a 403 page, not a key rejection. Check the proxy, firewall, or network, then retry.',
  ],
  auth403: [
    '请求被拒绝（403）。这不是密钥错误（401）。请核对这把 key 是否允许调用该模型。',
    'The gateway refused the request (403). This is not a rejected key (401). Check that this key may call the model.',
  ],
  authSetup: [
    '密钥被拒绝（401）。请重新粘贴 API key。',
    'The API key was rejected (401). Paste the key again.',
  ],
  authChat: [
    '密钥被拒绝（401）。请核对 API key，或运行 moss setup 重新填写。',
    'The API key was rejected (401). Check the key, or run moss setup to replace it.',
  ],
  thinking: [
    '思考模式历史上下文缺少 reasoning 信息，建议开新对话或重试。',
    'The thinking-mode history is missing reasoning payloads; start a new session or retry.',
  ],
  toolCtx: ['工具调用上下文丢失，建议重新提问。', 'Tool-call context was lost; ask again.'],
  quota: [
    '当前模型的调用额度已用尽，建议换个模型或在设置中调整。',
    "This model's quota is exhausted; switch models or adjust in settings.",
  ],
  rate: ['访问太频繁，请稍后再试。', 'Rate limited; try again shortly.'],
  refused: [
    '连接被拒绝。这个地址的主机或端口没有服务在听。请改 base URL，然后重试。',
    'Connection refused. Nothing is listening at that base URL (wrong host or port). Fix the base URL, then retry.',
  ],
  connect: [
    '网络连接失败。请检查 base URL 和网络，然后重试。',
    'Could not connect. Check the base URL and your network, then retry.',
  ],
  httpNotTls: [
    '这个地址在讲 HTTP，不是 HTTPS。把 base URL 改成 http，或指到一个 TLS 端口。',
    'This address is speaking HTTP, not HTTPS. Use an http base URL, or point at a TLS port.',
  ],
  tls: [
    'TLS 证书校验失败。请检查 https 地址和代理，然后重试。',
    'TLS certificate check failed. Check the https base URL and your proxy, then retry.',
  ],
  localQuick: [
    '本机快速模型不可用：请确认 Ollama 已启动且已拉取该模型；可打开「本地模型」完成安装与下发。',
    "The local quick model is unavailable: make sure Ollama is running and the model is pulled; open 'Local models' to install it.",
  ],
  localModel: [
    '本机找不到该模型或未启动推理服务。请在「本地模型」检查运行状态与模型列表，或核对设置中的模型 ID。',
    "The local model was not found or the inference service is not running; check 'Local models' or fix the model ID in settings.",
  ],
  cloudModel: [
    '云端或网关找不到该模型 ID。请到服务商控制台核对名称，或用 /model 另选一个。',
    'The gateway does not have this model. Pick another with /model, or run moss setup.',
  ],
  path404: [
    '这个地址的路径不存在（404）。请检查 base URL。这不是模型名错误。',
    'That URL path was not found (404). Check the base URL. This is not a missing model.',
  ],
  overflow: [
    '对话上下文已超出模型限制。建议开启新对话（Moss 会保留上一个会话的摘要），或换用更大上下文窗口的模型。',
    "The conversation exceeds the model's context limit; start a new session (Moss keeps a summary of the previous one) or switch to a larger-window model.",
  ],
  upstream: [
    '厂商服务暂时不可用，请稍后再试或切换深度/快速车道。',
    'The provider is temporarily unavailable; retry shortly or switch between the deep/quick lanes.',
  ],
  unknown: [
    '模型暂时不可用。若当前对话反复失败，请开启新对话并让 Moss 查看上一个会话内容后继续。',
    'The model is temporarily unavailable. If this conversation keeps failing, start a new session and let Moss pick up from the previous one.',
  ],
} as const;

type CopyId = keyof typeof COPY;

function say(id: CopyId): string {
  const [zh, en] = COPY[id];
  return msg(zh, en);
}

function classifyProviderErrorNow(input: ProviderErrorInput): ProviderErrorSurface {
  const resp = input.providerErrorResponse;
  const raw = String(resp?.message ?? input.errorMessage ?? '').trim();
  const status = resp?.status ?? input.status;
  const code = resp?.code ?? input.code;
  const provider = resp?.provider ?? input.provider;
  const gate = (
    category: ProviderErrorCategory,
    text: string,
    actions: ProviderErrorAction[],
    retryable: boolean,
    attach: GateAttach = 'none'
  ): ProviderErrorSurface =>
    face(
      category,
      attach === 'none'
        ? text
        : withGatewayText(text, raw, attach === 'setup' ? input.audience : undefined),
      actions,
      retryable
    );
  const hit = (
    category: ProviderErrorCategory,
    id: CopyId,
    actions: ProviderErrorAction[],
    retryable: boolean,
    attach: GateAttach = 'none'
  ): ProviderErrorSurface => gate(category, say(id), actions, retryable, attach);

  if (isAbortFailure(raw)) {
    if (input.abortReason === 'user') return SILENT_USER_ABORT;
    if (input.abortReason === 'timeout')
      return hit('timeout', 'timeout', RETRY_SWITCH, true, 'setup');
    return hit('aborted_by_server', 'aborted', [RETRY], true);
  }
  // A stall can mention "check API Key". Timeout wins unless the status is 401/403.
  if (!isAuthStatus(status) && isTimeoutFailure(raw, status)) {
    return hit('timeout', 'timeoutSlow', RETRY_SWITCH, true, 'setup');
  }
  if (isRegionRestriction(raw, status))
    return hit('region', 'region', SETTINGS_SWITCH, false, 'body');
  if (isLoginPage(raw) || (isHtmlDocument(raw) && status !== 403)) {
    return hit('network', 'login', RETRY_SETTINGS, true, 'body');
  }
  if (isWafBlock(raw, status)) return hit('network', 'waf', RETRY_SETTINGS, true, 'body');
  if (isAuthFailure(raw, status)) {
    const id = status === 403 ? 'auth403' : input.audience === 'setup' ? 'authSetup' : 'authChat';
    return hit('auth', id, SETTINGS_SWITCH, false, 'body');
  }
  const ctx = matchContextCorruption(raw);
  if (ctx.hit) {
    return ctx.flavor === 'thinking'
      ? hit('context_corruption', 'thinking', [NEW_SESSION, RETRY], false)
      : hit('context_corruption', 'toolCtx', [RETRY, NEW_SESSION], false);
  }
  if (status === 402 || isQuotaExceededError(raw) || isQuotaExceededError(code)) {
    return hit('quota_exceeded', 'quota', [SWITCH, SETTINGS], false);
  }
  if (isRateLimitFailure(raw, status)) return hit('rate_limit', 'rate', [RETRY], true);
  if (isConnectionError(raw)) {
    return hit(
      'network',
      /econnrefused/i.test(raw) ? 'refused' : 'connect',
      RETRY_SETTINGS,
      true,
      'setup'
    );
  }
  if (isTlsProtocolMismatch(raw, code))
    return hit('network', 'httpNotTls', SETTINGS_RETRY, false, 'body');
  if (isTlsCertificate(raw, code)) return hit('network', 'tls', SETTINGS_RETRY, false, 'body');
  if (matchModelNotFound(raw, code)) {
    const localish = inferLocalInferenceStack({
      provider: provider ?? input.provider,
      baseUrl: input.baseUrl,
      errorMessage: raw,
    });
    const id =
      input.lane === 'quick' && localish ? 'localQuick' : localish ? 'localModel' : 'cloudModel';
    return hit('model_not_found', id, SETTINGS_SWITCH, false, 'body');
  }
  if (status === 404) return hit('network', 'path404', SETTINGS_RETRY, false, 'body');
  // Retrying the same overflowing prompt overflows again. No retry action.
  if (matchContextLengthExceeded(raw, code)) {
    return hit('context_length_exceeded', 'overflow', [NEW_SESSION, SWITCH], false);
  }
  if (isServerErrorFailure(raw, status) || isPrematureStreamClose(raw)) {
    return hit('service_unavailable', 'upstream', RETRY_SWITCH, true);
  }
  if (matchStreamingUnsupported(raw)) {
    return gate(
      'streaming_not_supported',
      '当前模型/网关不支持流式输出，请到设置中换一个支持 stream 的模型。',
      SETTINGS_SWITCH,
      false
    );
  }
  if (matchToolUnsupported(raw)) {
    return gate(
      'tools_not_supported',
      '当前模型不支持工具调用，工具任务可能失败；请到设置换用支持 tools 的模型（推荐 qwen3 / qwen3-coder / llama3.1 / gpt-4.x 或同类工具模型）。',
      SETTINGS_SWITCH,
      false
    );
  }
  if (matchEmptyResponse(raw)) {
    return gate(
      'empty_response',
      '模型返回空内容（常见于思考类模型把所有输出放进 reasoning）。请到设置把「推理可见度」改为「stream」让思考过程可见，或换一个非纯思考模型。',
      SETTINGS_SWITCH,
      true
    );
  }
  if (matchRuntimeLifecycle(raw)) {
    return gate(
      'runtime_lifecycle',
      '板端协作运行时没有准备好，Moss 需要先恢复板端智能体或 Gateway 后才能继续。',
      [BOARD, RETRY, SETTINGS],
      true
    );
  }
  return hit('unknown', 'unknown', [RETRY, NEW_SESSION, SWITCH], false, 'body');
}

export function renderProviderErrorSurface(surface: ProviderErrorSurface): string {
  return surface.silent ? '' : surface.userMessage;
}

export function sanitizeRawErrorForDetail(raw: string): string {
  return raw ? sanitizeSecrets(raw) : '';
}
