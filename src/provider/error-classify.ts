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

/**
 * Stable category assigned to a provider/runtime failure.
 *
 * @public
 */
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

/**
 * Recovery action that a host can present for a classified provider failure.
 *
 * @public
 */
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

/**
 * Host-facing, sanitized representation of a provider/runtime failure.
 *
 * @public
 */
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

  /**
   * Optional unified error response from provider.
   * If provided, status/code/provider are extracted from this.
   */
  providerErrorResponse?: ProviderErrorResponse;
}

const SILENT_USER_ABORT: ProviderErrorSurface = {
  category: 'aborted_by_user',
  userMessage: '',
  actions: [],
  silent: true,
  retryable: false,
};

/**
 * Locale for user-facing strings. The provider layer cannot import the CLI's
 * locale helper (layering), so it reads the same env variables inline; the
 * classifier's Chinese strings are the zh voice and English is the fallback,
 * chosen once at module load (a process does not switch locale mid-run).
 */
let activeLocale: string | undefined;

function isZhEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const locale = activeLocale ?? preferredLocale(env) ?? '';
  return /^zh/i.test(locale);
}

function msg(zh: string, en: string): string {
  return isZhEnv() ? zh : en;
}

const ACTION_RETRY: ProviderErrorAction = {
  id: 'retry',
  label: msg('重试', 'Retry'),
  variant: 'primary',
};
const ACTION_OPEN_SETTINGS: ProviderErrorAction = {
  id: 'openSettings',
  label: msg('打开设置', 'Open settings'),
  variant: 'secondary',
};
const ACTION_OPEN_BOARD_AGENT: ProviderErrorAction = {
  id: 'openBoardAgent',
  label: msg('检查板端智能体', 'Check board agent'),
  variant: 'primary',
};
const ACTION_SWITCH_MODEL: ProviderErrorAction = {
  id: 'switchModel',
  label: msg('换个模型', 'Switch model'),
  variant: 'ghost',
};
const ACTION_NEW_SESSION: ProviderErrorAction = {
  id: 'newSession',
  label: msg('开新对话', 'New session'),
  variant: 'ghost',
};

// 判定谓词（abort/auth/rate-limit/timeout/network/5xx/stream-drop/quota/
// thinking-corruption）以 errors.ts 的共享谓词为单一来源（T5.1 去重）；
// 本文件只保留 provider 面特有的判定（model_not_found、context_length、
// tools/streaming/empty/runtime_lifecycle）与 ProviderErrorCategory 视图映射。

function matchContextCorruption(msg: string): { hit: boolean; flavor: 'thinking' | 'tool' | null } {
  if (isThinkingHistoryCorruption(msg)) {
    return { hit: true, flavor: 'thinking' };
  }
  const m = msg.toLowerCase();
  if (m.includes('tool result') && m.includes('not found')) {
    return { hit: true, flavor: 'tool' };
  }
  // DeepSeek SDK error code 2013: "tool id(call_function_...) not found (2013)"
  // — the model referenced a tool-call ID in a tool_result that doesn't match
  // any pending call_function in the current context. Treated as a 'tool'
  // history-format error (same recovery path as the "tool result not found" branch).
  if (/\(2013\)/.test(m)) {
    return { hit: true, flavor: 'tool' };
  }
  return { hit: false, flavor: null };
}

function inferLocalInferenceStack(input: ProviderErrorInput): boolean {
  const p = String(input.provider || '').toLowerCase();
  const raw = `${input.baseUrl || ''}|${input.errorMessage || ''}`.toLowerCase();
  return (
    p === 'ollama' ||
    raw.includes('localhost:11434') ||
    raw.includes('127.0.0.1:11434') ||
    raw.includes('[::1]:11434') ||
    /\boolama\b/.test(raw)
  );
}

function matchModelNotFound(msg: string, _status?: number, code?: string): boolean {
  const normalizedCode = (code ?? '').toLowerCase();
  if (
    normalizedCode === 'model_not_found' ||
    normalizedCode === 'model_not_exist' ||
    normalizedCode === 'invalid_model'
  ) {
    return true;
  }
  const raw = msg.trim();
  if (
    /\b无效模型\b|无效\s*的?\s*模型|模型\s*无效|未知模型|没有该模型|无此模型|模型不存在/.test(
      raw
    ) ||
    /\binvalid\s+model\b|invalid\s+model\s+name/.test(msg.toLowerCase())
  ) {
    return true;
  }
  const m = msg.toLowerCase();
  // A bare HTTP 404 is a wrong path. Model-missing needs the model words
  // (DeepSeek's 400 "Model Not Exist" included) or one of the codes above.
  return /\bmodel[_ ]not[_ ]found\b|\bmodel not exist\b|model_not_exist|no such model|model.*does not exist|the model (?:is )?(?:has been )?deprecated|model.*not (?:available|supported|enabled|active)|the requested model is|tried to access|no access to (?:the )?model/i.test(
    m
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
  const blob = `${code ?? ''} ${message}`;
  return /wrong version number|packet length too long|\bEPROTO\b|tls_get_more_records|before secure TLS connection/i.test(
    blob
  );
}

function isTlsCertificate(message: string, code?: string): boolean {
  if (isTlsProtocolMismatch(message, code)) return false;
  const blob = `${code ?? ''} ${message}`;
  return /UNABLE_TO_VERIFY|SELF_SIGNED|CERT_HAS_EXPIRED|DEPTH_ZERO|ERR_CERT_|certificate/i.test(
    blob
  );
}

/** Moss-authored tails. The gateway's own sentence stays. */
const AUTHORED_GATEWAY_TAILS: readonly RegExp[] = [
  /\s+—\s+check your API key\b[\s\S]*$/i,
  /\s+—\s+model name not supported by this gateway[\s\S]*$/i,
  /\s+—\s+model or endpoint not found[\s\S]*$/i,
  /\s+—\s+rate limited;[\s\S]*$/i,
  /\s+—\s+gateway error;[\s\S]*$/i,
  /\s+—\s+this model name is not available on the gateway\.[\s\S]*$/i,
  /\s+—\s+the server is not running or the port is wrong\.[\s\S]*$/i,
  /\s+—\s+check your network connection and DNS settings\.[\s\S]*$/i,
  /\s+—\s+network is unreachable\.[\s\S]*$/i,
  /\s+—\s+check network speed, firewall rules[\s\S]*$/i,
  /\s+—\s+the server's certificate is invalid[\s\S]*$/i,
  /\s+—\s+check HTTP_PROXY[\s\S]*$/i,
  /\s+—\s+check network, proxy, DNS[\s\S]*$/i,
  /\s*Run `\/model` to pick one[\s\S]*$/i,
  /\n\s*Supported models:[\s\S]*$/i,
  /\s*stream terminated without \[DONE\][\s\S]*$/i,
];

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
  if (/^The operation was aborted\b/i.test(flat)) return true;
  return false;
}

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
  if (
    /^(?:TypeError: )?fetch failed for \S+/i.test(flat) &&
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(flat)
  ) {
    return true;
  }
  return false;
}

function stripLoginPagePrefix(text: string): string {
  return text.replace(new RegExp('captive portal or proxy login page:\\s*', 'gi'), '');
}

/** Syscall or client-abort text to show under 详细信息, never as gateway body. */
function lowLevelCause(raw: string): string {
  const cleaned = stripLoginPagePrefix(raw);
  const paren = cleaned.match(
    /\(((?:ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ECONNABORTED|EPIPE)\b[^)]{0,180})\)/i
  );
  if (paren?.[1]) return paren[1].trim();
  for (const line of cleaned.split('\n')) {
    let text = line.trim();
    if (!text || isMossConnectionLead(text)) continue;
    for (const pattern of AUTHORED_GATEWAY_TAILS) text = text.replace(pattern, '').trim();
    if (!text || isMossConnectionLead(text)) continue;
    if (isTransportOnlyLine(text)) return text.slice(0, 300);
  }
  return '';
}

/** The gateway's own body. Moss HTTP wrappers and connection hints are dropped. */
function gatewayDetail(raw: string): string {
  let text = redactGatewayText(
    sanitizeRawErrorForDetail(raw.replace(/\bpi-ai\b/gi, 'gateway'))
  ).trim();
  text = stripLoginPagePrefix(text);
  const wrapped = text.match(/^[^\n]*?\bprovider returned HTTP \d+:\s*([\s\S]*)$/i);
  if (wrapped) text = stripLoginPagePrefix((wrapped[1] ?? '').trim());
  for (const pattern of AUTHORED_GATEWAY_TAILS) text = text.replace(pattern, '');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !isTransportOnlyLine(line))
    .join('\n')
    .trim();
}

function withGatewayText(hint: string, raw: string, audience?: 'setup' | 'chat'): string {
  const detail = gatewayDetail(raw);
  if (detail) {
    if (hint.includes(detail)) return hint;
    return `${hint}\n${msg('网关原文：', 'Gateway text: ')}${detail}`;
  }
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

function matchToolUnsupported(msg: string): boolean {
  const m = msg.toLowerCase();
  return /does not support tools|tools? (?:are )?not supported|tool use (?:is )?not supported|unsupported.*tools?|function[ _]call(?:ing)? not supported|no tools? (?:are )?available/i.test(
    m
  );
}

function matchContextLengthExceeded(msg: string, code?: string): boolean {
  if ((code ?? '').toLowerCase() === 'context_length_exceeded') return true;
  const c = (code ?? '').toLowerCase();
  if (
    (c === 'invalid_request_error' || c === 'bad_request') &&
    // Tightened: require an overflow sense of "context" — not just the bare
    // word. "context deadline exceeded" (gRPC/Go timeout) was a false positive
    // under the old /context|token|length|.../ alternation. (Found by moss
    // self-iteration — glm-5.2 reviewed this file.)
    /context (?:length|window|size|limit)|exceeds? .*context|上下文|窗口|超限|过长/i.test(msg)
  ) {
    return true;
  }
  // Delegates to overflow-patterns.ts — merged Pi v0.80.3 per-provider regex
  // patterns (25+) + moss Chinese patterns. The previous inline Chinese +
  // English regexes are subsumed by the consolidated pattern set.
  return isOverflowMessage(msg);
}

function matchStreamingUnsupported(msg: string): boolean {
  const m = msg.toLowerCase();
  return /stream(?:ing)? (?:is )?not supported|does not support stream|stream (?:is )?disabled|cannot stream/i.test(
    m
  );
}

function matchEmptyResponse(msg: string): boolean {
  const m = msg.toLowerCase();
  return /empty (?:response|content|completion)|received (?:an )?empty|model returned empty|response had no content/i.test(
    m
  );
}

function matchRuntimeLifecycle(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    /lifecyle_error|lifecycle_error|requested agent harness|agent harness .*not registered|protocol mismatch|agent session failed|occode/i.test(
      msg
    ) ||
    /anthropic messages transport requires a positive maxtokens value|requires a positive maxTokens value/i.test(
      msg
    ) ||
    (m.includes('board agent') &&
      /gateway|protocol|lifecycle|harness|not registered|maxtokens/.test(m))
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

function classifyProviderErrorNow(input: ProviderErrorInput): ProviderErrorSurface {
  // Extract metadata from unified error response if provided
  const resp = input.providerErrorResponse;
  const raw = String(resp?.message ?? input.errorMessage ?? '').trim();
  const status = resp?.status ?? input.status;
  const code = resp?.code ?? input.code;
  const provider = resp?.provider ?? input.provider;

  if (isAbortFailure(raw)) {
    if (input.abortReason === 'user') return SILENT_USER_ABORT;
    if (input.abortReason === 'timeout') {
      return face(
        'timeout',
        withGatewayText(
          msg('模型响应超时，请稍后重试。', 'The model timed out; try again shortly.'),
          raw,
          input.audience
        ),
        [ACTION_RETRY, ACTION_SWITCH_MODEL],
        true
      );
    }
    return face(
      'aborted_by_server',
      msg('请求被中断，请稍后重试。', 'The request was interrupted; try again shortly.'),
      [ACTION_RETRY],
      true
    );
  }

  // A first-chunk stall message can include generic setup guidance such as
  // "check API Key". Classify the observed timeout before matching auth text.
  // An explicit HTTP auth status (401/403) remains authoritative.
  if (!isAuthStatus(status) && isTimeoutFailure(raw, status)) {
    return face(
      'timeout',
      withGatewayText(
        msg(
          '模型响应超时，请稍后重试或在设置里换一个更快的模型。',
          'The model timed out; try again shortly or switch to a faster model in settings.'
        ),
        raw,
        input.audience
      ),
      [ACTION_RETRY, ACTION_SWITCH_MODEL],
      true
    );
  }

  if (isRegionRestriction(raw, status)) {
    return face(
      'region',
      withGatewayText(
        msg(
          '当前地区不可用。换服务商或地址，换一把 key 解决不了。',
          'Blocked in this region. Change the provider or base URL; a new key will not fix it.'
        ),
        raw
      ),
      [ACTION_OPEN_SETTINGS, ACTION_SWITCH_MODEL],
      false
    );
  }

  if (isLoginPage(raw) || (isHtmlDocument(raw) && status !== 403)) {
    return face(
      'network',
      withGatewayText(
        msg(
          '网关返回了登录页（网络认证或代理登录），不是模型回复。请在浏览器里完成登录，或检查代理后再试。',
          'The gateway returned a login page (captive portal or proxy sign-in), not a model reply. Finish that login in a browser, or check the proxy, then retry.'
        ),
        raw
      ),
      [ACTION_RETRY, ACTION_OPEN_SETTINGS],
      true
    );
  }

  if (isWafBlock(raw, status)) {
    return face(
      'network',
      withGatewayText(
        msg(
          '代理或防火墙拦下了请求（403 页面），不是密钥错误。请检查代理、防火墙或网络后再试。',
          'A proxy or firewall returned a 403 page, not a key rejection. Check the proxy, firewall, or network, then retry.'
        ),
        raw
      ),
      [ACTION_RETRY, ACTION_OPEN_SETTINGS],
      true
    );
  }

  if (isAuthFailure(raw, status)) {
    const forbidden = status === 403;
    const setup = input.audience === 'setup';
    const text = forbidden
      ? msg(
          '请求被拒绝（403）。这不是密钥错误（401）。请核对这把 key 是否允许调用该模型。',
          'The gateway refused the request (403). This is not a rejected key (401). Check that this key may call the model.'
        )
      : setup
        ? msg(
            '密钥被拒绝（401）。请重新粘贴 API key。',
            'The API key was rejected (401). Paste the key again.'
          )
        : msg(
            '密钥被拒绝（401）。请核对 API key，或运行 moss setup 重新填写。',
            'The API key was rejected (401). Check the key, or run moss setup to replace it.'
          );
    return face(
      'auth',
      withGatewayText(text, raw),
      [ACTION_OPEN_SETTINGS, ACTION_SWITCH_MODEL],
      false
    );
  }

  const ctx = matchContextCorruption(raw);
  if (ctx.hit) {
    return ctx.flavor === 'thinking'
      ? face(
          'context_corruption',
          msg(
            '思考模式历史上下文缺少 reasoning 信息，建议开新对话或重试。',
            'The thinking-mode history is missing reasoning payloads; start a new session or retry.'
          ),
          [ACTION_NEW_SESSION, ACTION_RETRY],
          false
        )
      : face(
          'context_corruption',
          msg('工具调用上下文丢失，建议重新提问。', 'Tool-call context was lost; ask again.'),
          [ACTION_RETRY, ACTION_NEW_SESSION],
          false
        );
  }

  if (status === 402 || isQuotaExceededError(raw) || isQuotaExceededError(code)) {
    return face(
      'quota_exceeded',
      msg(
        '当前模型的调用额度已用尽，建议换个模型或在设置中调整。',
        "This model's quota is exhausted; switch models or adjust in settings."
      ),
      [ACTION_SWITCH_MODEL, ACTION_OPEN_SETTINGS],
      false
    );
  }

  if (isRateLimitFailure(raw, status)) {
    return face(
      'rate_limit',
      msg('访问太频繁，请稍后再试。', 'Rate limited; try again shortly.'),
      [ACTION_RETRY],
      true
    );
  }

  if (isConnectionError(raw)) {
    const refused = /econnrefused/i.test(raw);
    return face(
      'network',
      withGatewayText(
        refused
          ? msg(
              '连接被拒绝。这个地址的主机或端口没有服务在听。请改 base URL，然后重试。',
              'Connection refused. Nothing is listening at that base URL (wrong host or port). Fix the base URL, then retry.'
            )
          : msg(
              '网络连接失败。请检查 base URL 和网络，然后重试。',
              'Could not connect. Check the base URL and your network, then retry.'
            ),
        raw,
        input.audience
      ),
      [ACTION_RETRY, ACTION_OPEN_SETTINGS],
      true
    );
  }

  if (isTlsProtocolMismatch(raw, code)) {
    return face(
      'network',
      withGatewayText(
        msg(
          '这个地址在讲 HTTP，不是 HTTPS。把 base URL 改成 http，或指到一个 TLS 端口。',
          'This address is speaking HTTP, not HTTPS. Use an http base URL, or point at a TLS port.'
        ),
        raw
      ),
      [ACTION_OPEN_SETTINGS, ACTION_RETRY],
      false
    );
  }

  if (isTlsCertificate(raw, code)) {
    return face(
      'network',
      withGatewayText(
        msg(
          'TLS 证书校验失败。请检查 https 地址和代理，然后重试。',
          'TLS certificate check failed. Check the https base URL and your proxy, then retry.'
        ),
        raw
      ),
      [ACTION_OPEN_SETTINGS, ACTION_RETRY],
      false
    );
  }

  // Model not found
  if (matchModelNotFound(raw, status, code)) {
    const inferInput = {
      provider: provider ?? input.provider,
      baseUrl: input.baseUrl,
      errorMessage: raw,
    };
    const localish = inferLocalInferenceStack(inferInput as ProviderErrorInput);
    const quickLocal = input.lane === 'quick' && localish;
    const userMessage = quickLocal
      ? msg(
          '本机快速模型不可用：请确认 Ollama 已启动且已拉取该模型；可打开「本地模型」完成安装与下发。',
          "The local quick model is unavailable: make sure Ollama is running and the model is pulled; open 'Local models' to install it."
        )
      : localish
        ? msg(
            '本机找不到该模型或未启动推理服务。请在「本地模型」检查运行状态与模型列表，或核对设置中的模型 ID。',
            "The local model was not found or the inference service is not running; check 'Local models' or fix the model ID in settings."
          )
        : msg(
            '云端或网关找不到该模型 ID。请到服务商控制台核对名称，或用 /model 另选一个。',
            'The gateway does not have this model. Pick another with /model, or run moss setup.'
          );
    return face(
      'model_not_found',
      withGatewayText(userMessage, raw),
      [ACTION_OPEN_SETTINGS, ACTION_SWITCH_MODEL],
      false
    );
  }

  if (status === 404) {
    return face(
      'network',
      withGatewayText(
        msg(
          '这个地址的路径不存在（404）。请检查 base URL。这不是模型名错误。',
          'That URL path was not found (404). Check the base URL. This is not a missing model.'
        ),
        raw
      ),
      [ACTION_OPEN_SETTINGS, ACTION_RETRY],
      false
    );
  }

  // Context length exceeded — retrying the same prompt WILL overflow again;
  // the only recovery is a new session (with compaction) or a bigger model.
  // H3 fix: was retryable:true + ACTION_RETRY, which made runtime-retry loop
  // on the same overflowing prompt. Now retryable:false, actions drop RETRY.
  if (matchContextLengthExceeded(raw, code)) {
    return face(
      'context_length_exceeded',
      msg(
        '对话上下文已超出模型限制。建议开启新对话（Moss 会保留上一个会话的摘要），或换用更大上下文窗口的模型。',
        "The conversation exceeds the model's context limit; start a new session (Moss keeps a summary of the previous one) or switch to a larger-window model."
      ),
      [ACTION_NEW_SESSION, ACTION_SWITCH_MODEL],
      false
    );
  }

  if (isServerErrorFailure(raw, status) || isPrematureStreamClose(raw)) {
    return face(
      'service_unavailable',
      msg(
        '厂商服务暂时不可用，请稍后再试或切换深度/快速车道。',
        'The provider is temporarily unavailable; retry shortly or switch between the deep/quick lanes.'
      ),
      [ACTION_RETRY, ACTION_SWITCH_MODEL],
      true
    );
  }

  if (matchStreamingUnsupported(raw)) {
    return face(
      'streaming_not_supported',
      '当前模型/网关不支持流式输出，请到设置中换一个支持 stream 的模型。',
      [ACTION_OPEN_SETTINGS, ACTION_SWITCH_MODEL],
      false
    );
  }

  if (matchToolUnsupported(raw)) {
    return face(
      'tools_not_supported',
      '当前模型不支持工具调用，工具任务可能失败；请到设置换用支持 tools 的模型（推荐 qwen3 / qwen3-coder / llama3.1 / gpt-4.x 或同类工具模型）。',
      [ACTION_OPEN_SETTINGS, ACTION_SWITCH_MODEL],
      false
    );
  }

  if (matchEmptyResponse(raw)) {
    return face(
      'empty_response',
      '模型返回空内容（常见于思考类模型把所有输出放进 reasoning）。请到设置把「推理可见度」改为「stream」让思考过程可见，或换一个非纯思考模型。',
      [ACTION_OPEN_SETTINGS, ACTION_SWITCH_MODEL],
      true
    );
  }

  if (matchRuntimeLifecycle(raw)) {
    return face(
      'runtime_lifecycle',
      '板端协作运行时没有准备好，Moss 需要先恢复板端智能体或 Gateway 后才能继续。',
      [ACTION_OPEN_BOARD_AGENT, ACTION_RETRY, ACTION_OPEN_SETTINGS],
      true
    );
  }

  return face(
    'unknown',
    withGatewayText(
      msg(
        '模型暂时不可用。若当前对话反复失败，请开启新对话并让 Moss 查看上一个会话内容后继续。',
        'The model is temporarily unavailable. If this conversation keeps failing, start a new session and let Moss pick up from the previous one.'
      ),
      raw
    ),
    [ACTION_RETRY, ACTION_NEW_SESSION, ACTION_SWITCH_MODEL],
    false
  );
}

export function renderProviderErrorSurface(surface: ProviderErrorSurface): string {
  if (surface.silent) return '';
  return surface.userMessage;
}

export function sanitizeRawErrorForDetail(raw: string): string {
  if (!raw) return '';
  return sanitizeSecrets(raw);
}
